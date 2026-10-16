import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DatasetDescriptorSchema, groupAuctionRecords } from '../../packages/shared/src/index.js';
import type {
  CanonicalConfigurationHistory,
  ConfigurationPublication,
  ConfigurationWorkspace,
  DatasetDescriptor,
  EvidenceReference,
  PrebidConfiguration,
} from '../../packages/shared/src/index.js';
import { createDatabaseClient } from '../../apps/api/src/db/client.js';
import { DynamoConfigurationManagementRepository } from '../../apps/api/src/db/configuration-management.js';
import { initializeDatabase } from '../../apps/api/src/db/initialize.js';
import {
  PublisherDataRepository,
  auctionRecordKey,
  configurationKey,
  datasetKey,
  historyKey,
} from '../../apps/api/src/db/publisher-data.js';
import { PublisherDataWriter } from '../../apps/api/src/db/publisher-data-writes.js';
import { tableDefinitions } from '../../apps/api/src/db/tables.js';
import { reconcilePublisherData } from '../../apps/api/src/commands/data-reconcile.js';
import { canonicalJson } from '../../apps/api/src/domain/aggregation.js';
import {
  ConfigurationManagement,
  PublishedConfigurationRepository,
  configurationSeeds,
} from '../../apps/api/src/domain/configuration-management.js';
import type { ExecutionContext } from '../../apps/api/src/domain/interfaces.js';
import { createConfigurationTools } from '../../apps/api/src/tools/configurations.js';
import { createToolDispatcher } from '../../apps/api/src/tools/dispatch.js';
import {
  PUBLISHER_IDS,
  createTimeline,
  loadingDescriptor,
} from '../../scripts/phase-3-data/configuration.js';
import { generateDay } from '../../scripts/phase-3-data/simulation.js';

const require = createRequire(new URL('../../apps/api/package.json', import.meta.url));
const { DeleteTableCommand, GetItemCommand } = require('@aws-sdk/client-dynamodb');
const suite = randomUUID().replaceAll('-', '');
const prefix = `bid-test-configurations-${suite}`;
const table = `${prefix}-publisher-data`;
const date = '2026-08-24';
const client = createDatabaseClient({
  endpoint: process.env.DYNAMODB_ENDPOINT ?? 'http://127.0.0.1:8000',
  tablePrefix: prefix,
  region: process.env.AWS_REGION ?? 'local',
  accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? 'local',
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? 'local',
});
const original = new PublisherDataRepository(client, prefix);
const writer = new PublisherDataWriter(client, prefix);
const seeds = configurationSeeds((context) =>
  original.readHistory(context.identity.publisherId, undefined, context.signal),
);
const repository = new DynamoConfigurationManagementRepository(client, prefix, seeds);
const management = new ConfigurationManagement(repository);
const serving = new PublishedConfigurationRepository(management, original);
const timelines = PUBLISHER_IDS.map(createTimeline);
const seedKeys: { PK: string; SK: string }[] = [];
const seedBytes = new Map<string, string>();
const readyDescriptors = new Map<string, DatasetDescriptor>();
let ownsTables = false;

function context(publisherId = 'publisher-a', userId = 'editing-human'): ExecutionContext {
  // This suite tests the trusted persistence boundary; HTTP auth has separate coverage.
  return {
    identity: { publisherId, userId },
    correlationId: suite,
    signal: new AbortController().signal,
  } as ExecutionContext;
}

function changed(prebid: PrebidConfiguration): PrebidConfiguration {
  const next = structuredClone(prebid);
  next.setConfig.debug = !next.setConfig.debug;

  return next;
}

function documentOf(state: ConfigurationWorkspace): PrebidConfiguration {
  const prebid = state.draft?.prebid ?? state.current?.prebid;
  expect(prebid).toBeDefined();

  return prebid!;
}

async function save(context: ExecutionContext, prebid?: PrebidConfiguration) {
  const state = await repository.get(context);

  return repository.save(context, {
    expectedRevision: state.revision,
    prebid: prebid ?? changed(documentOf(state)),
  });
}

async function publish(context: ExecutionContext): Promise<ConfigurationPublication> {
  const state = await repository.get(context);

  return repository.publish(context, {
    expectedRevision: state.revision,
    expectedCurrentVersionId: state.current?.versionId ?? null,
    requestId: randomUUID(),
  });
}

async function originalBytes(key: { PK: string; SK: string }): Promise<string> {
  const result = (await client.send(
    new GetItemCommand({
      TableName: table,
      Key: { PK: { S: key.PK }, SK: { S: key.SK } },
      ConsistentRead: true,
    }),
  )) as { Item?: Record<string, unknown> };
  expect(result.Item).toBeDefined();

  // Compare canonical bytes of raw Dynamo AttributeValues, including number strings,
  // rather than a decoded projection that could overlook original field mutations.
  return canonicalJson(result.Item);
}

beforeAll(async () => {
  ownsTables = true;
  await initializeDatabase(client, prefix);
  const loading = PUBLISHER_IDS.map((publisherId) =>
    DatasetDescriptorSchema.parse({
      ...loadingDescriptor(publisherId),
      storageFormat: 'auctions',
      observedThrough: `${date}T23:59:59.999Z`,
      availablePeriod: { startDate: date, endDate: date },
      partialDates: [date],
    }),
  );
  await writer.preflightEmpty(loading);
  await writer.claimDatasets(loading);
  await writer.writeConfigurations(
    timelines.map((timeline) => timeline.current),
    timelines.flatMap((timeline) => timeline.history),
  );

  const descriptors: DatasetDescriptor[] = [];

  for (const [index, publisherId] of PUBLISHER_IDS.entries()) {
    const timeline = timelines[index]!;
    // One real generated auction is enough to exercise the existing content hash
    // and reconciliation without loading or modifying any existing demo dataset.
    const auctions = groupAuctionRecords(
      generateDay(publisherId, date, timeline.history).events,
    ).slice(0, 1);
    await writer.writeAuctions(auctions);
    const reconciled = await reconcilePublisherData(client, prefix, publisherId, {
      allowLoading: true,
    });
    descriptors.push(reconciled.descriptor);
    readyDescriptors.set(publisherId, reconciled.descriptor);
    seedKeys.push(
      configurationKey(publisherId),
      datasetKey(publisherId),
      ...timeline.history.map((record: CanonicalConfigurationHistory) => historyKey(record)),
      ...auctions.map(auctionRecordKey),
    );
  }

  await writer.activateDatasets(descriptors);

  for (const key of seedKeys) seedBytes.set(`${key.PK}/${key.SK}`, await originalBytes(key));
});

afterAll(async () => {
  try {
    if (ownsTables) {
      // Cleanup is restricted to this suite's exact UUID-owned table names.
      // Never enumerate tables, reset a prefix from the environment or delete demo data.
      if (prefix !== `bid-test-configurations-${suite}`)
        throw new Error('Test ownership invariant failed');

      for (const definition of tableDefinitions(prefix)) {
        try {
          await client.send(new DeleteTableCommand({ TableName: definition.name }));
        } catch (error) {
          if (!(error instanceof Error && error.name === 'ResourceNotFoundException')) throw error;
        }
      }
    }
  } finally {
    client.destroy();
  }
});

describe('durable publisher configuration management', () => {
  it('keeps one draft, conditionally publishes once and survives a new repository instance', async () => {
    const editor = context();
    const initial = await repository.get(editor);
    expect(initial.current?.source).toBe('seed');
    expect(initial.current?.configurationVersion).toBe(timelines[0]!.current.version);
    const first = await save(editor);
    const second = await save(editor);
    expect(second.current).toEqual(initial.current);
    expect(second.revision).toBe(first.revision + 1);
    expect((await repository.versions(editor)).versions).toHaveLength(timelines[0]!.history.length);

    const race = await Promise.allSettled([
      repository.save(editor, { expectedRevision: second.revision, prebid: documentOf(second) }),
      repository.save(editor, {
        expectedRevision: second.revision,
        prebid: changed(documentOf(second)),
      }),
    ]);
    expect(race.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const rejected = race.find((result) => result.status === 'rejected');
    expect(rejected?.status === 'rejected' && rejected.reason).toMatchObject({ status: 409 });

    const saved = await repository.get(editor);
    const publisher = context('publisher-a', 'publishing-human');
    const input = {
      expectedRevision: saved.revision,
      expectedCurrentVersionId: saved.current!.versionId,
      requestId: randomUUID(),
    };
    const concurrentPublish = await Promise.all([
      repository.publish(publisher, input),
      repository.publish(publisher, input),
    ]);
    const publication = concurrentPublish[0]!;
    expect(concurrentPublish[1]).toEqual(publication);
    expect(publication.authorUserId).toBe('publishing-human');
    expect(publication.coauthor).toBeUndefined();
    expect(publication.prebid).toEqual(saved.draft!.prebid);
    expect(publication.versionId).toBe(publication.publishedAt);
    expect(publication.versionId > initial.current!.versionId).toBe(true);
    expect(await repository.publish(publisher, input)).toEqual(publication);
    await expect(
      repository.publish(publisher, { ...input, expectedRevision: input.expectedRevision + 1 }),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      repository.save(editor, { expectedRevision: 0, prebid: documentOf(initial) }),
    ).rejects.toMatchObject({ status: 409 });

    const restarted = new DynamoConfigurationManagementRepository(client, prefix, seeds);
    const reloaded = await restarted.get(editor);
    expect(reloaded.current).toEqual(publication);
    expect(reloaded.draft).toBeNull();
    expect(reloaded.revision).toBe(saved.revision + 1);
    expect(await restarted.version(editor, publication.versionId)).toEqual(publication);
    const nextDraft = await restarted.save(editor, {
      expectedRevision: reloaded.revision,
      prebid: changed(publication.prebid),
    });
    await expect(
      restarted.publish(publisher, {
        expectedRevision: nextDraft.revision,
        expectedCurrentVersionId: initial.current!.versionId,
        requestId: randomUUID(),
      }),
    ).rejects.toMatchObject({ status: 409 });
    expect(await restarted.version(editor, publication.versionId)).toEqual(publication);
  });

  it('attributes publication to the human publisher and resets coauthor when replacing a draft from a source', async () => {
    const editor = context();
    let state = await repository.get(editor);
    const proposal = await repository.propose(
      editor,
      {
        expectedRevision: state.revision,
        prebid: changed(documentOf(state)),
        rationale: 'Review the supported debug flag change.',
        evidenceIds: ['trusted-configuration-evidence'],
      },
      `${suite}:coauthor-proposal`,
    );
    state = await repository.get(editor);
    state = await repository.decide(context('publisher-a', 'approving-human'), {
      expectedRevision: state.revision,
      proposalId: proposal.proposalId,
      decision: 'approve',
    });
    expect(state.draft?.agentContributed).toBe(true);
    state = await save(editor);
    expect(state.draft?.agentContributed).toBe(true);
    const aiPublication = await publish(context('publisher-a', 'different-publishing-human'));
    expect(aiPublication.authorUserId).toBe('different-publishing-human');
    expect(aiPublication.coauthor).toBe('agent');

    const seed = (await seeds(editor))[0]!;
    state = await repository.get(editor);
    state = await repository.save(editor, {
      expectedRevision: state.revision,
      sourceVersionId: aiPublication.versionId,
      prebid: aiPublication.prebid,
    });
    expect(state.draft?.agentContributed).toBe(true);
    state = await repository.save(editor, {
      expectedRevision: state.revision,
      sourceVersionId: seed.versionId,
      prebid: seed.prebid,
    });
    expect(state.draft?.agentContributed).toBe(false);
    await expect(
      repository.save(editor, {
        expectedRevision: state.revision,
        sourceVersionId: seed.versionId,
        prebid: changed(seed.prebid),
      }),
    ).rejects.toMatchObject({ status: 400 });
    expect((await repository.get(editor)).revision).toBe(state.revision);
    const manualPublication = await publish(context('publisher-a', 'manual-publisher'));
    expect(manualPublication.coauthor).toBeUndefined();
    expect(manualPublication.authorUserId).toBe('manual-publisher');
    expect(manualPublication.versionId > aiPublication.versionId).toBe(true);
    expect(await repository.version(editor, aiPublication.versionId)).toEqual(aiPublication);
  });

  it('persists replay-safe proposals and decisions without resurrecting stale cards or overwriting newer work', async () => {
    const editor = context();
    const initial = await repository.get(editor);
    const input = {
      expectedRevision: initial.revision,
      prebid: changed(documentOf(initial)),
      rationale: 'Review this exact draft update.',
      evidenceIds: ['trusted-configuration-evidence'],
    };
    const invocation = `${suite}:replay-proposal`;
    const proposed = await repository.propose(editor, input, invocation);
    const proposedState = await repository.get(editor);
    const restarted = new DynamoConfigurationManagementRepository(client, prefix, seeds);
    expect(await restarted.propose(editor, input, invocation)).toEqual(proposed);
    expect((await restarted.get(editor)).revision).toBe(proposedState.revision);
    await expect(
      restarted.propose(editor, { ...input, rationale: 'Different payload' }, invocation),
    ).rejects.toMatchObject({ status: 409 });

    const rejection = {
      expectedRevision: proposedState.revision,
      proposalId: proposed.proposalId,
      decision: 'reject' as const,
    };
    const rejected = await restarted.decide(editor, rejection);
    expect(rejected.draft).toEqual(initial.draft);
    expect(rejected.proposal?.status).toBe('rejected');
    expect(await restarted.decide(editor, rejection)).toEqual(rejected);
    expect((await restarted.propose(editor, input, invocation)).status).toBe('rejected');

    const nextInput = { ...input, expectedRevision: rejected.revision };
    const stale = await restarted.propose(editor, nextInput, `${suite}:stale-proposal`);
    const pending = await restarted.get(editor);
    const manual = await restarted.save(editor, {
      expectedRevision: pending.revision,
      prebid: changed(documentOf(pending)),
    });
    expect((await restarted.propose(editor, nextInput, `${suite}:stale-proposal`)).status).toBe(
      'superseded',
    );
    await expect(
      restarted.decide(editor, {
        expectedRevision: pending.revision,
        proposalId: stale.proposalId,
        decision: 'approve',
      }),
    ).rejects.toMatchObject({ status: 409 });
    expect(await restarted.get(editor)).toEqual(manual);

    const accepted = await restarted.propose(
      editor,
      {
        ...input,
        expectedRevision: manual.revision,
        prebid: changed(documentOf(manual)),
      },
      `${suite}:accepted-proposal`,
    );
    const beforeApproval = await restarted.get(editor);
    const approval = {
      expectedRevision: beforeApproval.revision,
      proposalId: accepted.proposalId,
      decision: 'approve' as const,
    };
    const approved = await restarted.decide(editor, approval);
    expect(approved.current).toEqual(initial.current);
    expect(approved.draft?.agentContributed).toBe(true);
    expect(await restarted.decide(editor, approval)).toEqual(approved);
    const later = await restarted.save(editor, {
      expectedRevision: approved.revision,
      prebid: changed(documentOf(approved)),
    });
    expect(await restarted.decide(editor, approval)).toEqual(later);
    await expect(
      restarted.decide(editor, { ...approval, decision: 'reject' }),
    ).rejects.toMatchObject({ status: 409 });
  });

  it('scopes versions, source restores, cursors and proposal receipts to their publisher', async () => {
    const publisherA = context();
    const publisherB = context('publisher-b');
    const a = await repository.get(publisherA);
    const b = await repository.get(publisherB);
    expect(a.current?.publisherId).toBe('publisher-a');
    expect(b.current?.publisherId).toBe('publisher-b');
    await expect(repository.version(publisherB, a.current!.versionId)).rejects.toMatchObject({
      status: 404,
    });
    await expect(
      repository.save(publisherB, {
        expectedRevision: b.revision,
        sourceVersionId: a.current!.versionId,
        prebid: a.current!.prebid,
      }),
    ).rejects.toMatchObject({ status: 404 });
    expect(await repository.get(publisherB)).toEqual(b);
    const page = await repository.versions(publisherA, { limit: 1 });
    expect(page.nextCursor).not.toBeNull();
    await expect(
      repository.versions(publisherB, { limit: 1, cursor: page.nextCursor! }),
    ).rejects.toMatchObject({ status: 400 });

    const invocation = `${suite}:same-invocation-different-publishers`;
    const proposalA = await repository.propose(
      publisherA,
      {
        expectedRevision: a.revision,
        prebid: changed(documentOf(a)),
        rationale: 'Publisher A draft only.',
        evidenceIds: ['trusted-a-evidence'],
      },
      invocation,
    );
    const proposalB = await repository.propose(
      publisherB,
      {
        expectedRevision: b.revision,
        prebid: changed(documentOf(b)),
        rationale: 'Publisher B draft only.',
        evidenceIds: ['trusted-b-evidence'],
      },
      invocation,
    );
    expect(proposalA.publisherId).toBe('publisher-a');
    expect(proposalB.publisherId).toBe('publisher-b');
    const beforeBApprovalA = await repository.get(publisherA);
    const pendingB = await repository.get(publisherB);
    await repository.decide(publisherB, {
      expectedRevision: pendingB.revision,
      proposalId: proposalB.proposalId,
      decision: 'approve',
    });
    expect(await repository.get(publisherA)).toEqual(beforeBApprovalA);
    expect(
      (await repository.versions(publisherB)).versions.every(
        (item) => item.publisherId === 'publisher-b',
      ),
    ).toBe(true);
  });

  it('pages more than fifty publications without gaps and keeps serving history available', async () => {
    const editor = context();
    const created: ConfigurationPublication[] = [];

    for (let index = 0; index < 55; index++) {
      await save(editor);
      created.push(await publish(editor));
    }

    const versions: ConfigurationPublication[] = [];
    let cursor: string | undefined;

    do {
      const page = await repository.versions(editor, {
        limit: 7,
        ...(cursor ? { cursor } : {}),
      });
      expect(page.versions.length).toBeLessThanOrEqual(7);
      versions.push(...page.versions);
      cursor = page.nextCursor ?? undefined;
    } while (cursor);

    expect(versions.length).toBeGreaterThan(50);
    expect(new Set(versions.map((item) => item.versionId)).size).toBe(versions.length);
    expect(versions.map((item) => item.versionId)).toEqual(
      versions
        .map((item) => item.versionId)
        .sort()
        .reverse(),
    );
    expect(versions.filter((item) => item.source === 'seed')).toHaveLength(
      timelines[0]!.history.length,
    );
    expect(
      created.every((item) => versions.some((version) => version.versionId === item.versionId)),
    ).toBe(true);
    const oldest = created[0]!;
    const newest = created.at(-1)!;
    const history = await serving.history(editor, {
      startDate: oldest.publishedAt.slice(0, 10),
      endDate: newest.publishedAt.slice(0, 10),
    });
    expect(history.length).toBeGreaterThanOrEqual(55);
    expect((await serving.current(editor))?.updatedAt).toBe(newest.publishedAt);
    expect(history.some((record) => record.timestamp === newest.publishedAt)).toBe(true);
  });

  it('does not return already-owned proposal evidence for graph renumbering at the fifty-reference limit', async () => {
    const editor = context();
    const initial = await repository.get(editor);
    const evidence: EvidenceReference[] = Array.from({ length: 50 }, (_, index) => ({
      evidenceId: `e${index + 1}`,
      publisherId: editor.identity.publisherId,
      source: 'configuration',
      recordId: initial.current!.versionId,
      observedAt: initial.current!.publishedAt,
    }));
    const trusted: ExecutionContext = {
      ...editor,
      invocation: {
        conversationId: `conversation-${suite}`,
        turnId: `turn-${suite}`,
        toolCallId: 'proposal-fifty-references',
        evidence,
        allowNavigation: false,
      },
    };
    const dispatcher = createToolDispatcher(createConfigurationTools(management));
    const evidenceIds = evidence.map((reference) => reference.evidenceId);
    const result = await dispatcher(
      'configuration_propose_draft',
      JSON.stringify({
        expectedRevision: initial.revision,
        prebid: changed(documentOf(initial)),
        rationale:
          'Review an exact draft update backed by fifty references already owned by this turn.',
        evidenceIds,
      }),
      trusted,
    );

    expect(result.evidence).toEqual([]);
    expect(result.data).toMatchObject({
      kind: 'configuration-draft-proposal',
      status: 'pending',
    });
    const proposed = await repository.get(editor);
    expect(proposed.proposal?.evidenceIds).toEqual(evidenceIds);
    expect(proposed.proposal?.evidenceIds).toHaveLength(50);
    expect(proposed.revision).toBe(initial.revision + 1);
    expect(proposed.draft).toEqual(initial.draft);
    expect(proposed.current).toEqual(initial.current);
  });

  it('leaves original stored seed config/history bytes, dataset hash and reconciliation unchanged', async () => {
    for (const key of seedKeys) {
      expect(await originalBytes(key)).toBe(seedBytes.get(`${key.PK}/${key.SK}`));
    }

    for (const [index, publisherId] of PUBLISHER_IDS.entries()) {
      expect(await original.readCurrent(publisherId)).toEqual(timelines[index]!.current);
      expect(await original.readHistory(publisherId)).toEqual(timelines[index]!.history);
      const reconciled = await reconcilePublisherData(client, prefix, publisherId, {
        write: false,
      });
      expect(reconciled.descriptor).toEqual(readyDescriptors.get(publisherId));
      expect(reconciled.descriptor.contentHash).toBe(
        readyDescriptors.get(publisherId)!.contentHash,
      );
      expect(reconciled.daily[0]?.auctions).toBe(1);
    }
  });
});
