import { createHash } from 'node:crypto';
import { TransactionCanceledException } from '@aws-sdk/client-dynamodb';
import type { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  GetCommand,
  QueryCommand,
  TransactWriteCommand,
} from '@aws-sdk/lib-dynamodb';
import { z } from 'zod';
import {
  ConfigurationPublicationSchema,
  ConfigurationWorkspaceSchema,
  ConfigurationVersionPageInputSchema,
  DecideConfigurationDraftSchema,
  IdSchema,
  ProposeConfigurationDraftSchema,
  PublishConfigurationDraftSchema,
  SaveConfigurationDraftSchema,
  TimestampSchema,
  summarizePrebidConfiguration,
} from '@bid/shared';
import type {
  ConfigurationDraftProposal,
  ConfigurationPublication,
  ConfigurationVersionPage,
  ConfigurationVersionPageInput,
  ConfigurationWorkspace,
  DecideConfigurationDraft,
  ProposeConfigurationDraft,
  PublishConfigurationDraft,
  SaveConfigurationDraft,
} from '@bid/shared';
import type { ExecutionContext } from '../domain/interfaces.js';
import { canonicalJson } from '../domain/aggregation.js';
import { resolvePrebidAuction } from '../domain/prebid-configuration.js';
import { HttpError } from '../errors.js';
import { TablePrefixSchema } from './client.js';
import { publisherKey } from './publisher-data.js';

/** Read-only normalization of existing seed snapshots; never writes seed records. */
export type ConfigurationSeedProvider = (
  context: ExecutionContext,
) => Promise<readonly ConfigurationPublication[]>;

export interface ConfigurationManagementRepository {
  get(context: ExecutionContext): Promise<ConfigurationWorkspace>;
  versions(
    context: ExecutionContext,
    input?: ConfigurationVersionPageInput,
  ): Promise<ConfigurationVersionPage>;
  version(context: ExecutionContext, versionId: string): Promise<ConfigurationPublication>;
  save(context: ExecutionContext, input: SaveConfigurationDraft): Promise<ConfigurationWorkspace>;
  publish(
    context: ExecutionContext,
    input: PublishConfigurationDraft,
  ): Promise<ConfigurationPublication>;
  propose(
    context: ExecutionContext,
    input: ProposeConfigurationDraft,
    invocationId: string,
  ): Promise<ConfigurationDraftProposal>;
  decide(
    context: ExecutionContext,
    input: DecideConfigurationDraft,
  ): Promise<ConfigurationWorkspace>;
}

type Receipt = {
  hash: string;
  result: ConfigurationPublication | ConfigurationDraftProposal | null;
};
type Commit = {
  previousRevision: number;
  next: ConfigurationWorkspace;
  publication?: ConfigurationPublication;
  receipt?: { id: string; data: Receipt };
};

const CursorSchema = z.strictObject({ publisherId: IdSchema, before: TimestampSchema });

function conflict(message = 'Configuration changed. Reload before trying again.'): never {
  throw new HttpError(409, 'CONFLICT', message);
}

function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const parsed = schema.safeParse(input);

  if (!parsed.success) throw new HttpError(400, 'INVALID_INPUT', 'Invalid configuration request.');

  return parsed.data;
}

function fingerprint(input: unknown): string {
  return createHash('sha256').update(canonicalJson(input)).digest('hex');
}

function checkDocument(prebid: SaveConfigurationDraft['prebid']): void {
  if (Buffer.byteLength(JSON.stringify(prebid)) > 24_000) {
    throw new HttpError(400, 'INVALID_INPUT', 'Configuration exceeds the supported document size.');
  }

  try {
    for (const unit of prebid.adUnits) resolvePrebidAuction(prebid, unit.code);
  } catch {
    throw new HttpError(
      400,
      'INVALID_INPUT',
      'Configuration is outside the supported auction profile.',
    );
  }
}

abstract class ConfigurationStore implements ConfigurationManagementRepository {
  constructor(private readonly seeds: ConfigurationSeedProvider) {}

  protected abstract readState(context: ExecutionContext): Promise<ConfigurationWorkspace | null>;
  protected abstract readReceipt(context: ExecutionContext, id: string): Promise<Receipt | null>;
  protected abstract readPublications(
    context: ExecutionContext,
    before: string | null,
    limit: number,
  ): Promise<ConfigurationPublication[]>;
  protected abstract readPublication(
    context: ExecutionContext,
    versionId: string,
  ): Promise<ConfigurationPublication | null>;
  protected abstract commit(context: ExecutionContext, input: Commit): Promise<void>;

  private async seedVersions(context: ExecutionContext): Promise<ConfigurationPublication[]> {
    context.signal.throwIfAborted();
    const versions = (await this.seeds(context)).map((item) =>
      ConfigurationPublicationSchema.parse(item),
    );

    if (versions.some((item) => item.publisherId !== context.identity.publisherId)) {
      throw new HttpError(500, 'INTERNAL_ERROR', 'Configuration seed ownership is invalid.');
    }

    return versions.sort((a, b) => a.versionId.localeCompare(b.versionId));
  }

  async get(context: ExecutionContext): Promise<ConfigurationWorkspace> {
    const stored = await this.readState(context);

    if (stored) return structuredClone(stored);

    const seeds = await this.seedVersions(context);

    return {
      publisherId: context.identity.publisherId,
      revision: 0,
      current: seeds.at(-1) ?? null,
      draft: null,
      proposal: null,
    };
  }

  async versions(
    context: ExecutionContext,
    input: ConfigurationVersionPageInput = {},
  ): Promise<ConfigurationVersionPage> {
    const request = parse(ConfigurationVersionPageInputSchema, input);
    const limit = request.limit ?? 10;
    let before: string | null = null;

    if (request.cursor) {
      try {
        const cursor = CursorSchema.parse(
          JSON.parse(Buffer.from(request.cursor, 'base64url').toString('utf8')),
        );

        if (cursor.publisherId !== context.identity.publisherId) throw new Error('Wrong publisher');

        before = cursor.before;
      } catch {
        throw new HttpError(400, 'INVALID_INPUT', 'Invalid configuration history cursor.');
      }
    }

    const [runtime, seeds] = await Promise.all([
      this.readPublications(context, before, limit + 1),
      this.seedVersions(context),
    ]);
    const all = [
      ...runtime,
      ...seeds.filter((item) => before === null || item.versionId < before),
    ].sort((a, b) => b.versionId.localeCompare(a.versionId));
    const versions = all.slice(0, limit);
    const last = versions.at(-1);

    return {
      versions,
      nextCursor:
        all.length > limit && last
          ? Buffer.from(
              JSON.stringify({ publisherId: context.identity.publisherId, before: last.versionId }),
            ).toString('base64url')
          : null,
    };
  }

  async version(context: ExecutionContext, versionId: string): Promise<ConfigurationPublication> {
    const id = parse(TimestampSchema, versionId);
    const runtime = await this.readPublication(context, id);
    const publication =
      runtime ?? (await this.seedVersions(context)).find((item) => item.versionId === id);

    if (!publication) throw new HttpError(404, 'NOT_FOUND', 'Configuration version was not found.');

    return publication;
  }

  async save(
    context: ExecutionContext,
    input: SaveConfigurationDraft,
  ): Promise<ConfigurationWorkspace> {
    const request = parse(SaveConfigurationDraftSchema, input);
    checkDocument(request.prebid);
    const state = await this.get(context);

    if (state.revision !== request.expectedRevision) conflict();

    const source = request.sourceVersionId
      ? await this.version(context, request.sourceVersionId)
      : null;

    if (source && canonicalJson(source.prebid) !== canonicalJson(request.prebid)) {
      throw new HttpError(
        400,
        'INVALID_INPUT',
        'Restored configuration must match its source version.',
      );
    }

    const next: ConfigurationWorkspace = {
      ...state,
      revision: state.revision + 1,
      draft: {
        prebid: request.prebid,
        baseVersionId: state.current?.versionId ?? null,
        updatedAt: new Date().toISOString(),
        updatedByUserId: context.identity.userId,
        agentContributed: source
          ? source.coauthor === 'agent'
          : (state.draft?.agentContributed ?? false),
      },
      proposal: null,
    };
    await this.commit(context, { previousRevision: state.revision, next });

    return next;
  }

  async publish(
    context: ExecutionContext,
    input: PublishConfigurationDraft,
  ): Promise<ConfigurationPublication> {
    const request = parse(PublishConfigurationDraftSchema, input);
    const receiptId = `publish:${request.requestId}`;
    const hash = fingerprint({ actor: context.identity.userId, request });
    const replay = await this.readReceipt(context, receiptId);

    if (replay) {
      if (replay.hash !== hash)
        conflict('This publish request was already used for different content.');

      return ConfigurationPublicationSchema.parse(replay.result);
    }

    const state = await this.get(context);

    if (
      state.revision !== request.expectedRevision ||
      (state.current?.versionId ?? null) !== request.expectedCurrentVersionId
    )
      conflict();
    if (!state.draft) conflict('Save a draft before publishing.');

    checkDocument(state.draft.prebid);
    const versionId = new Date(
      Math.max(Date.now(), state.current ? Date.parse(state.current.versionId) + 1 : 0),
    ).toISOString();
    const publication: ConfigurationPublication = {
      publisherId: context.identity.publisherId,
      versionId,
      configurationVersion: (state.current?.configurationVersion ?? 0) + 1,
      publishedAt: versionId,
      authorUserId: context.identity.userId,
      ...(state.draft.agentContributed ? { coauthor: 'agent' as const } : {}),
      source: 'published',
      previousVersionId: state.current?.versionId ?? null,
      settings: summarizePrebidConfiguration(state.draft.prebid),
      prebid: state.draft.prebid,
    };
    const next: ConfigurationWorkspace = {
      ...state,
      revision: state.revision + 1,
      current: publication,
      draft: null,
      proposal: null,
    };

    try {
      await this.commit(context, {
        previousRevision: state.revision,
        next,
        publication,
        receipt: { id: receiptId, data: { hash, result: publication } },
      });
    } catch (error) {
      const completed = await this.readReceipt(context, receiptId);

      if (completed?.hash === hash) return ConfigurationPublicationSchema.parse(completed.result);

      throw error;
    }

    return publication;
  }

  async propose(
    context: ExecutionContext,
    input: ProposeConfigurationDraft,
    invocationId: string,
  ): Promise<ConfigurationDraftProposal> {
    const request = parse(ProposeConfigurationDraftSchema, input);
    checkDocument(request.prebid);
    // Invocation identity is supplied by the agent executor, never model arguments.
    if (!invocationId || invocationId.length > 1000)
      throw new HttpError(400, 'INVALID_INPUT', 'Invalid proposal invocation.');

    const proposalId = `proposal-${fingerprint(invocationId)}`;
    const receiptId = `proposal:${proposalId}`;
    const hash = fingerprint({ actor: context.identity.userId, request });
    const replay = await this.readReceipt(context, receiptId);

    if (replay) {
      if (replay.hash !== hash)
        conflict('Proposal invocation was already used for different content.');

      const state = await this.get(context);
      const previous = replay.result as ConfigurationDraftProposal;

      return state.proposal?.proposalId === proposalId
        ? state.proposal
        : { ...previous, status: 'superseded' };
    }

    const state = await this.get(context);

    if (state.revision !== request.expectedRevision) conflict();

    const before = state.draft?.prebid ?? state.current?.prebid;

    if (!before) conflict('A current configuration is required before proposing changes.');
    if (canonicalJson(before) === canonicalJson(request.prebid)) {
      throw new HttpError(400, 'INVALID_INPUT', 'The proposed configuration has no changes.');
    }

    const proposal: ConfigurationDraftProposal = {
      proposalId,
      publisherId: context.identity.publisherId,
      createdAt: new Date().toISOString(),
      proposedByUserId: context.identity.userId,
      baseVersionId: state.current?.versionId ?? null,
      before,
      after: request.prebid,
      rationale: request.rationale,
      evidenceIds: request.evidenceIds,
      status: 'pending',
    };
    const next = { ...state, revision: state.revision + 1, proposal };

    try {
      await this.commit(context, {
        previousRevision: state.revision,
        next,
        receipt: { id: receiptId, data: { hash, result: proposal } },
      });
    } catch (error) {
      const completed = await this.readReceipt(context, receiptId);

      if (completed?.hash === hash) {
        const latest = await this.get(context);

        return latest.proposal?.proposalId === proposalId
          ? latest.proposal
          : { ...proposal, status: 'superseded' };
      }

      throw error;
    }

    return proposal;
  }

  async decide(
    context: ExecutionContext,
    input: DecideConfigurationDraft,
  ): Promise<ConfigurationWorkspace> {
    const request = parse(DecideConfigurationDraftSchema, input);
    const receiptId = `decision:${request.proposalId}`;
    const hash = fingerprint({ actor: context.identity.userId, request });
    const replay = await this.readReceipt(context, receiptId);

    if (replay) {
      if (replay.hash !== hash) conflict('This proposal already has a different decision.');

      return this.get(context);
    }

    const state = await this.get(context);
    const proposal = state.proposal;

    if (
      state.revision !== request.expectedRevision ||
      !proposal ||
      proposal.proposalId !== request.proposalId ||
      proposal.status !== 'pending'
    )
      conflict('This proposal is no longer pending.');
    if ((state.current?.versionId ?? null) !== proposal.baseVersionId) conflict();

    checkDocument(proposal.after);
    const now = new Date().toISOString();
    const next: ConfigurationWorkspace = {
      ...state,
      revision: state.revision + 1,
      draft:
        request.decision === 'approve'
          ? {
              prebid: proposal.after,
              baseVersionId: proposal.baseVersionId,
              updatedAt: now,
              updatedByUserId: context.identity.userId,
              agentContributed: true,
            }
          : state.draft,
      proposal: {
        ...proposal,
        status: request.decision === 'approve' ? 'approved' : 'rejected',
        decidedAt: now,
        decidedByUserId: context.identity.userId,
      },
    };

    try {
      await this.commit(context, {
        previousRevision: state.revision,
        next,
        receipt: { id: receiptId, data: { hash, result: null } },
      });
    } catch (error) {
      const completed = await this.readReceipt(context, receiptId);

      if (completed?.hash === hash) return this.get(context);

      throw error;
    }

    return next;
  }
}

/** Each application/test gets an isolated fixture store, never module-global mutation. */
export class MemoryConfigurationManagementRepository extends ConfigurationStore {
  private readonly states = new Map<string, ConfigurationWorkspace>();
  private readonly publications = new Map<string, ConfigurationPublication>();
  private readonly receipts = new Map<string, Receipt>();

  protected async readState(context: ExecutionContext) {
    context.signal.throwIfAborted();

    return structuredClone(this.states.get(context.identity.publisherId) ?? null);
  }

  protected async readReceipt(context: ExecutionContext, id: string) {
    context.signal.throwIfAborted();

    return structuredClone(
      this.receipts.get(`${publisherKey(context.identity.publisherId)}:${id}`) ?? null,
    );
  }

  protected async readPublications(
    context: ExecutionContext,
    before: string | null,
    limit: number,
  ) {
    context.signal.throwIfAborted();

    return structuredClone(
      [...this.publications.values()]
        .filter(
          (item) =>
            item.publisherId === context.identity.publisherId &&
            (before === null || item.versionId < before),
        )
        .sort((a, b) => b.versionId.localeCompare(a.versionId))
        .slice(0, limit),
    );
  }

  protected async readPublication(context: ExecutionContext, id: string) {
    context.signal.throwIfAborted();

    return structuredClone(
      this.publications.get(`${publisherKey(context.identity.publisherId)}:${id}`) ?? null,
    );
  }

  protected async commit(context: ExecutionContext, input: Commit) {
    context.signal.throwIfAborted();
    const publisher = context.identity.publisherId;

    if ((this.states.get(publisher)?.revision ?? 0) !== input.previousRevision) conflict();

    if (input.receipt) {
      const key = `${publisherKey(publisher)}:${input.receipt.id}`;

      if (this.receipts.has(key)) conflict();

      this.receipts.set(key, structuredClone(input.receipt.data));
    }

    this.states.set(publisher, structuredClone(input.next));

    if (input.publication) {
      this.publications.set(
        `${publisherKey(publisher)}:${input.publication.versionId}`,
        structuredClone(input.publication),
      );
    }
  }
}

/** Runtime overlays only: CONFIGURATION, HISTORY# and DATASET remain seed-owned. */
export class DynamoConfigurationManagementRepository extends ConfigurationStore {
  private readonly document: DynamoDBDocumentClient;
  private readonly table: string;

  constructor(client: DynamoDBClient, prefix: string, seeds: ConfigurationSeedProvider) {
    super(seeds);
    TablePrefixSchema.parse(prefix);
    this.document = DynamoDBDocumentClient.from(client, {
      marshallOptions: { removeUndefinedValues: true },
    });
    this.table = `${prefix}-publisher-data`;
  }

  private key(context: ExecutionContext, SK: string) {
    return { PK: publisherKey(context.identity.publisherId), SK };
  }

  private async read(context: ExecutionContext, sortKey: string): Promise<unknown> {
    context.signal.throwIfAborted();
    const result = await this.document.send(
      new GetCommand({
        TableName: this.table,
        Key: this.key(context, sortKey),
        ConsistentRead: true,
      }),
      { abortSignal: context.signal },
    );

    return result.Item?.['data'] ?? null;
  }

  protected async readState(context: ExecutionContext) {
    const data = await this.read(context, 'CONFIGURATION-RUNTIME');

    if (data === null) return null;

    const state = ConfigurationWorkspaceSchema.parse(data);

    if (
      state.publisherId !== context.identity.publisherId ||
      (state.current && state.current.publisherId !== state.publisherId) ||
      (state.proposal && state.proposal.publisherId !== state.publisherId)
    ) {
      throw new HttpError(500, 'INTERNAL_ERROR', 'Invalid configuration ownership.');
    }

    return state;
  }

  protected async readReceipt(context: ExecutionContext, id: string): Promise<Receipt | null> {
    return (await this.read(context, `CONFIGURATION-RECEIPT#${fingerprint(id)}`)) as Receipt | null;
  }

  protected async readPublication(context: ExecutionContext, id: string) {
    const data = await this.read(context, `CONFIGURATION-PUBLICATION#${id}`);

    if (data === null) return null;

    const publication = ConfigurationPublicationSchema.parse(data);

    if (publication.publisherId !== context.identity.publisherId || publication.versionId !== id) {
      throw new HttpError(500, 'INTERNAL_ERROR', 'Invalid configuration ownership.');
    }

    return publication;
  }

  protected async readPublications(
    context: ExecutionContext,
    before: string | null,
    limit: number,
  ) {
    context.signal.throwIfAborted();
    const result = await this.document.send(
      new QueryCommand({
        TableName: this.table,
        KeyConditionExpression: 'PK = :publisher AND SK BETWEEN :start AND :end',
        ExpressionAttributeValues: {
          ':publisher': publisherKey(context.identity.publisherId),
          ':start': 'CONFIGURATION-PUBLICATION#',
          ':end': before
            ? `CONFIGURATION-PUBLICATION#${before}`
            : 'CONFIGURATION-PUBLICATION#\uffff',
        },
        ScanIndexForward: false,
        ConsistentRead: true,
        Limit: before ? limit + 1 : limit,
      }),
      { abortSignal: context.signal },
    );
    const publications = (result.Items ?? []).map((item) =>
      ConfigurationPublicationSchema.parse(item['data']),
    );

    if (publications.some((item) => item.publisherId !== context.identity.publisherId)) {
      throw new HttpError(500, 'INTERNAL_ERROR', 'Invalid configuration ownership.');
    }

    return publications
      .filter((item) => before === null || item.versionId < before)
      .slice(0, limit);
  }

  protected async commit(context: ExecutionContext, input: Commit) {
    context.signal.throwIfAborted();
    const state = ConfigurationWorkspaceSchema.parse(input.next);

    if (state.publisherId !== context.identity.publisherId)
      throw new HttpError(403, 'UNAUTHORIZED', 'Publisher mismatch.');

    try {
      await this.document.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              Put: {
                TableName: this.table,
                Item: { ...this.key(context, 'CONFIGURATION-RUNTIME'), data: state },
                ConditionExpression:
                  input.previousRevision === 0
                    ? 'attribute_not_exists(PK)'
                    : '#data.#revision = :revision',
                ...(input.previousRevision === 0
                  ? {}
                  : {
                      ExpressionAttributeNames: { '#data': 'data', '#revision': 'revision' },
                      ExpressionAttributeValues: { ':revision': input.previousRevision },
                    }),
              },
            },
            ...(input.publication
              ? [
                  {
                    Put: {
                      TableName: this.table,
                      Item: {
                        ...this.key(
                          context,
                          `CONFIGURATION-PUBLICATION#${input.publication.versionId}`,
                        ),
                        data: input.publication,
                      },
                      ConditionExpression: 'attribute_not_exists(PK)',
                    },
                  },
                ]
              : []),
            ...(input.receipt
              ? [
                  {
                    Put: {
                      TableName: this.table,
                      Item: {
                        ...this.key(
                          context,
                          `CONFIGURATION-RECEIPT#${fingerprint(input.receipt.id)}`,
                        ),
                        data: input.receipt.data,
                      },
                      ConditionExpression: 'attribute_not_exists(PK)',
                    },
                  },
                ]
              : []),
          ],
        }),
        { abortSignal: context.signal },
      );
    } catch (error) {
      if (
        error instanceof TransactionCanceledException &&
        error.CancellationReasons?.some((reason) => reason.Code === 'ConditionalCheckFailed')
      ) {
        conflict();
      }

      throw error;
    }
  }
}
