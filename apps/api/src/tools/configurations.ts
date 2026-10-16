import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  ConfigurationTargetSchema,
  ConfigurationVersionPageInputSchema,
  ProposeConfigurationDraftSchema,
  TimestampSchema,
  ToolResultSchema,
} from '@bid/shared';
import type {
  ConfigurationTarget,
  EvidenceReference,
  PrebidConfiguration,
  ToolResult,
} from '@bid/shared';
import type { ConfigurationManagement } from '../domain/configuration-management.js';
import type { ExecutionContext } from '../domain/interfaces.js';
import { HttpError } from '../errors.js';
import type { ToolDefinition } from './types.js';

const Selection = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('current') }),
  z.strictObject({ kind: z.literal('draft') }),
  z.strictObject({ kind: z.literal('version'), versionId: TimestampSchema }),
]);
type Selection = z.infer<typeof Selection>;

function define<T>(
  name: string,
  description: string,
  schema: z.ZodType<T>,
  execute: (input: T, context: ExecutionContext) => Promise<ToolResult>,
  readOnly = true,
): ToolDefinition<unknown, ToolResult> {
  return {
    name,
    description,
    inputSchema: schema,
    outputSchema: ToolResultSchema,
    readOnly,
    maxOutputBytes: 32_768,
    async execute(input, context) {
      const data = await execute(schema.parse(input), context);
      return { data, evidence: data.evidence };
    },
  };
}

function differences(
  before: unknown,
  after: unknown,
  path = '',
): { path: string; beforeJson: string; afterJson: string }[] {
  if (JSON.stringify(before) === JSON.stringify(after)) return [];
  if (
    before !== null &&
    after !== null &&
    typeof before === 'object' &&
    typeof after === 'object'
  ) {
    const left = before as Record<string, unknown>;
    const right = after as Record<string, unknown>;
    return [...new Set([...Object.keys(left), ...Object.keys(right)])].flatMap((key) =>
      differences(left[key], right[key], path ? `${path}.${key}` : key),
    );
  }
  return [
    {
      path: path || 'configuration',
      beforeJson: JSON.stringify(before) ?? 'Not set',
      afterJson: JSON.stringify(after) ?? 'Not set',
    },
  ];
}

export function createConfigurationTools(
  service: ConfigurationManagement,
): readonly ToolDefinition<unknown, ToolResult>[] {
  async function read(selection: Selection, context: ExecutionContext) {
    const workspace = await service.workspace(context);
    const publication =
      selection.kind === 'version'
        ? await service.version(context, selection.versionId)
        : workspace.current;
    const target: ConfigurationTarget =
      selection.kind === 'draft'
        ? { kind: 'draft' }
        : publication
          ? { kind: 'version', versionId: publication.versionId }
          : { kind: 'list' };
    const prebid: PrebidConfiguration | null =
      selection.kind === 'draft'
        ? (workspace.draft?.prebid ?? null)
        : (publication?.prebid ?? null);
    const observedAt =
      selection.kind === 'draft' ? workspace.draft?.updatedAt : publication?.publishedAt;
    const evidence: EvidenceReference[] =
      prebid && observedAt
        ? [
            {
              evidenceId:
                selection.kind === 'draft'
                  ? `draft-r${workspace.revision}`
                  : `version-${publication!.versionId}`,
              publisherId: context.identity.publisherId,
              source: 'configuration',
              recordId:
                selection.kind === 'draft'
                  ? `draft-r${workspace.revision}`
                  : publication!.versionId,
              observedAt,
              configurationTarget: target,
            },
          ]
        : [];
    return { workspace, publication, target, prebid, evidence };
  }

  return [
    define(
      'configuration_read',
      'Read one current, shared draft, or timestamped published native configuration. Returns its shared workspace revision for proposed draft changes. Draft may be absent; use current as the starting document. Does not save or publish.',
      z.strictObject({ selection: Selection }),
      async ({ selection }, context) => {
        const { workspace, publication, target, prebid, evidence } = await read(selection, context);
        return {
          summary: prebid
            ? 'Supported synthetic Prebid snapshot. One shared draft; only explicit human Publish creates a version. Performance is unverified.'
            : 'No saved draft/configuration exists for this selection.',
          data: {
            kind: 'configuration-document',
            target,
            revision: workspace.revision,
            currentVersionId: workspace.current?.versionId ?? null,
            prebid,
            ...(selection.kind !== 'draft' && publication
              ? {
                  authorUserId: publication.authorUserId,
                  ...(publication.coauthor ? { coauthor: publication.coauthor } : {}),
                }
              : {}),
          },
          evidence,
          findings: [],
        };
      },
    ),
    define(
      'configuration_versions',
      'List timestamped published configuration versions and author/coauthor metadata. Paginated; use configuration_read for a single full document.',
      ConfigurationVersionPageInputSchema,
      async (input, context) => {
        const page = await service.versions(context, input);
        return {
          summary: 'Published configuration history; the shared draft is not a published version.',
          data: {
            kind: 'configuration-version-list',
            versions: page.versions.map(
              ({ versionId, publishedAt, authorUserId, coauthor, source }) => ({
                versionId,
                publishedAt,
                authorUserId,
                ...(coauthor ? { coauthor } : {}),
                source,
              }),
            ),
            nextCursor: page.nextCursor,
          },
          evidence: page.versions.map((record) => ({
            evidenceId: `version-${record.versionId}`,
            publisherId: context.identity.publisherId,
            source: 'configuration' as const,
            recordId: record.versionId,
            observedAt: record.publishedAt,
            configurationTarget: { kind: 'version' as const, versionId: record.versionId },
          })),
          findings: [],
        };
      },
    ),
    define(
      'configuration_compare',
      'Compare two current/draft/published native snapshots. Returns exact changed paths; cannot predict performance gains.',
      z.strictObject({ left: Selection, right: Selection }),
      async ({ left, right }, context) => {
        const first = await read(left, context);
        const second = await read(right, context);
        if (!first.prebid || !second.prebid)
          throw new HttpError(404, 'NOT_FOUND', 'Both selected configurations must exist.');
        return {
          summary:
            'Exact native configuration differences, not a backtest or proof of performance improvement.',
          data: {
            kind: 'configuration-comparison',
            left: first.target,
            right: second.target,
            changes: differences(first.prebid, second.prebid),
          },
          evidence: [
            ...new Map(
              [...first.evidence, ...second.evidence].map((entry) => [entry.evidenceId, entry]),
            ).values(),
          ],
          findings: [],
        };
      },
    ),
    define(
      'configuration_propose_draft',
      'Propose an exact update to the one shared draft using the revision from configuration_read and evidence IDs from this turn. A human must approve Update draft; only a separate human Publish creates a version. Full tool arguments must fit 16 KiB; larger documents can be edited in the UI.',
      ProposeConfigurationDraftSchema,
      async (input, context) => {
        const invocation = context.invocation;
        if (!invocation)
          throw new HttpError(
            400,
            'INVALID_INPUT',
            'Draft proposals require a trusted agent invocation.',
          );
        const invocationId = createHash('sha256')
          .update(
            JSON.stringify([invocation.conversationId, invocation.turnId, invocation.toolCallId]),
          )
          .digest('hex');
        const proposal = await service.propose(context, input, invocationId, invocation.evidence);
        const workspace = await service.workspace(context);

        return {
          summary:
            'Draft update proposed for explicit human review. This has not saved the draft or published a configuration.',
          data: {
            kind: 'configuration-draft-proposal',
            proposalId: proposal.proposalId,
            status: proposal.status,
            revision: workspace.revision,
            target: { kind: 'draft' },
          },
          // References already belong to this turn; returning them again would allocate new IDs.
          evidence: [],
          findings: [],
        };
      },
      false,
    ),
    define(
      'configuration_navigate',
      'Open a configuration page only when the user explicitly asks to open/show/navigate to it. Otherwise return clickable configuration targets from read tools. Never publishes or edits.',
      z.strictObject({ target: ConfigurationTargetSchema }),
      async ({ target }, context) => {
        if (target.kind === 'version') await service.version(context, target.versionId);
        const { evidence } = await read({ kind: 'current' }, context);
        return {
          summary:
            'Configuration page link; navigation is requested only in the active live turn when explicitly asked.',
          data: { kind: 'configuration-navigation', target },
          evidence,
          findings: [],
        };
      },
    ),
  ];
}
