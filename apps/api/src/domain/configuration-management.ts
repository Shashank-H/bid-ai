import { ConfigurationPublicationSchema, PeriodInputSchema } from '@bid/shared';
import type {
  Configuration,
  ConfigurationHistory,
  ConfigurationPublication,
  ConfigurationVersionPageInput,
  DecideConfigurationDraft,
  EvidenceReference,
  PeriodInput,
  ProposeConfigurationDraft,
  PublishConfigurationDraft,
  SaveConfigurationDraft,
} from '@bid/shared';
import type {
  ConfigurationManagementRepository,
  ConfigurationSeedProvider,
} from '../db/configuration-management.js';
import type { ConfigurationRepository, ExecutionContext } from './interfaces.js';
import { HttpError } from '../errors.js';

/** Normalize immutable seed history without changing its original storage or attribution. */
export function configurationSeeds(
  readSeedHistory: (context: ExecutionContext) => Promise<readonly ConfigurationHistory[]>,
): ConfigurationSeedProvider {
  return async (context) => {
    const history = await readSeedHistory(context);
    const sorted = [...history].sort((a, b) => a.timestamp.localeCompare(b.timestamp));

    return sorted
      .filter((record) => record.afterPrebid)
      .map((record, index) =>
        ConfigurationPublicationSchema.parse({
          publisherId: record.publisherId,
          versionId: record.timestamp,
          configurationVersion: record.version,
          publishedAt: record.timestamp,
          authorUserId: record.updatedByUserId,
          source: 'seed',
          previousVersionId: sorted[index - 1]?.timestamp ?? null,
          settings: record.after,
          prebid: record.afterPrebid,
        }),
      );
  };
}

export function publishedConfiguration(publication: ConfigurationPublication): Configuration {
  return {
    publisherId: publication.publisherId,
    version: publication.configurationVersion,
    updatedAt: publication.publishedAt,
    updatedByUserId: publication.authorUserId,
    settings: publication.settings,
    prebid: publication.prebid,
    syntheticAttribution: true,
  };
}

/** Shared HTTP/tool boundary. No caller may supply publishing authorship. */
export class ConfigurationManagement {
  constructor(readonly repository: ConfigurationManagementRepository) {}

  workspace(context: ExecutionContext) {
    return this.repository.get(context);
  }

  versions(context: ExecutionContext, input?: ConfigurationVersionPageInput) {
    return this.repository.versions(context, input);
  }

  version(context: ExecutionContext, versionId: string) {
    return this.repository.version(context, versionId);
  }

  save(context: ExecutionContext, input: SaveConfigurationDraft) {
    return this.repository.save(context, input);
  }

  publish(context: ExecutionContext, input: PublishConfigurationDraft) {
    return this.repository.publish(context, input);
  }

  decide(context: ExecutionContext, input: DecideConfigurationDraft) {
    return this.repository.decide(context, input);
  }

  propose(
    context: ExecutionContext,
    input: ProposeConfigurationDraft,
    invocationId: string,
    trustedEvidence: readonly EvidenceReference[],
  ) {
    const owned = new Set(
      trustedEvidence
        .filter((reference) => reference.publisherId === context.identity.publisherId)
        .map((reference) => reference.evidenceId),
    );

    if (input.evidenceIds.some((id) => !owned.has(id))) {
      throw new HttpError(
        400,
        'EVIDENCE_INVALID',
        'Proposal evidence must come from this investigation.',
      );
    }

    return this.repository.propose(context, input, invocationId);
  }
}

/** Serving-only overlay. Reconciliation keeps reading the untouched seed repository. */
export class PublishedConfigurationRepository implements ConfigurationRepository {
  constructor(
    private readonly management: ConfigurationManagement,
    private readonly seeds: ConfigurationRepository,
  ) {}

  async current(context: ExecutionContext) {
    const { current } = await this.management.workspace(context);

    return current ? publishedConfiguration(current) : null;
  }

  async history(context: ExecutionContext, period: PeriodInput): Promise<ConfigurationHistory[]> {
    PeriodInputSchema.parse(period);
    const records: ConfigurationPublication[] = [];
    let cursor: string | undefined;

    do {
      const page = await this.management.versions(context, {
        limit: 25,
        ...(cursor ? { cursor } : {}),
      });
      records.push(
        ...page.versions.filter((record) => {
          const date = record.publishedAt.slice(0, 10);

          return (
            record.source === 'published' && date >= period.startDate && date <= period.endDate
          );
        }),
      );
      cursor = page.nextCursor ?? undefined;

      if (records.length > 100) {
        throw new HttpError(
          400,
          'INVALID_INPUT',
          'This period contains too many configuration changes. Choose a shorter period or use paginated version history.',
        );
      }

      const oldest = page.versions.at(-1);

      if (oldest && oldest.publishedAt.slice(0, 10) < period.startDate) break;
    } while (cursor);

    const runtime = await Promise.all(
      records.reverse().map(async (publication) => {
        const before = publication.previousVersionId
          ? await this.management.version(context, publication.previousVersionId)
          : null;

        return {
          historyId: `${publication.publisherId}-configuration-v${publication.configurationVersion}`,
          publisherId: publication.publisherId,
          version: publication.configurationVersion,
          timestamp: publication.publishedAt,
          updatedByUserId: publication.authorUserId,
          before: before?.settings ?? null,
          after: publication.settings,
          beforePrebid: before?.prebid ?? null,
          afterPrebid: publication.prebid,
          syntheticAttribution: true as const,
        };
      }),
    );
    const original = await this.seeds.history(context, period);

    return [...original, ...runtime].sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  }

  async save(): Promise<void> {
    throw new HttpError(
      405,
      'NOT_IMPLEMENTED',
      'Use the shared draft and explicit Publish action.',
    );
  }
}
