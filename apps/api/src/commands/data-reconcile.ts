import type { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import type { DailyMetrics, BidderMetrics, DatasetDescriptor } from '@bid/shared';
import { DatasetDescriptorSchema, IdSchema } from '@bid/shared';
import { createDatabaseClient } from '../db/client.js';
import { PublisherDataRepository, utcDates } from '../db/publisher-data.js';
import { PublisherDataWriter } from '../db/publisher-data-writes.js';
import { aggregateEventDay, canonicalJson, createEventHasher } from '../domain/aggregation.js';
import { databaseSettingsFromEnvironment, readEnvironment } from '../env.js';
import { parseOptions } from './database.js';

export interface ReconciliationResult {
  descriptor: DatasetDescriptor;
  daily: DailyMetrics[];
  bidders: BidderMetrics[];
}

/** Rebuild only derived records. Never activates an incomplete seed or changes configuration. */
export async function reconcilePublisherData(
  client: DynamoDBClient,
  prefix: string,
  publisherId: string,
  options: { allowLoading?: boolean; signal?: AbortSignal; write?: boolean } = {},
): Promise<ReconciliationResult> {
  const { signal } = options;
  const repository = new PublisherDataRepository(client, prefix);
  const writer = new PublisherDataWriter(client, prefix);
  const descriptor = await repository.readDataset(publisherId, signal);

  if (!descriptor || (descriptor.status !== 'ready' && !options.allowLoading)) {
    throw new Error('DATASET_NOT_READY: reconciliation requires a completed dataset');
  }

  const { current, history } = await repository.readConfigurations(publisherId, signal);
  const latest = history.at(-1);

  if (
    !current ||
    !latest ||
    current.version !== latest.version ||
    current.updatedAt !== latest.timestamp ||
    current.updatedByUserId !== latest.updatedByUserId ||
    canonicalJson(current.prebid) !== canonicalJson(latest.afterPrebid) ||
    canonicalJson(current.settings) !== canonicalJson(latest.after)
  ) {
    throw new Error('INVALID_DATA: current configuration does not match immutable history');
  }

  const hasher = createEventHasher();
  const daily: DailyMetrics[] = [];
  const bidders: BidderMetrics[] = [];
  let eventCount = 0;

  hasher.add({ current, history });

  for (const date of utcDates(descriptor.availablePeriod)) {
    signal?.throwIfAborted();

    async function* observedEvents() {
      for await (const event of repository.readEvents(publisherId, date, signal)) {
        hasher.add(event);
        yield event;
      }
    }

    const result = await aggregateEventDay(publisherId, date, observedEvents(), history, {
      startAt: descriptor.observedFrom,
      endAt: descriptor.observedThrough,
      partial: descriptor.partialDates.includes(date),
    });

    if (!result.daily.auctions) {
      throw new Error(`INVALID_DATA: missing auctions for ${publisherId} on ${date}`);
    }

    eventCount += result.eventCount;
    daily.push(result.daily);
    bidders.push(...result.bidders);
    hasher.add({ daily: result.daily, bidders: result.bidders });
  }

  const verified = DatasetDescriptorSchema.parse({
    ...descriptor,
    status: 'ready',
    counts: {
      events: eventCount,
      auctions: daily.reduce((sum, day) => sum + day.auctions, 0),
      dailyMetrics: daily.length,
      bidderMetrics: bidders.length,
    },
    contentHash: hasher.digest(),
  });

  if (
    descriptor.status === 'ready' &&
    (descriptor.contentHash !== verified.contentHash ||
      canonicalJson(descriptor.counts) !== canonicalJson(verified.counts))
  ) {
    throw new Error('INVALID_DATA: raw/configuration content differs from the verified dataset');
  }

  // Verify the entire raw dataset first; a corrupt later day must not cause partial rewrites.
  if (options.write !== false) await writer.writeMetrics(daily, bidders, signal);

  return { descriptor: verified, daily, bidders };
}

export async function executeReconciliation(args: readonly string[], env: NodeJS.ProcessEnv) {
  const options = parseOptions(args, ['--publisher']);
  const publishers = options['--publisher']
    ? [IdSchema.parse(options['--publisher'])]
    : ['publisher-a', 'publisher-b'];

  readEnvironment(env);
  const settings = databaseSettingsFromEnvironment(env);
  const client = createDatabaseClient(settings);

  try {
    const results: DatasetDescriptor[] = [];

    for (const publisherId of publishers) {
      const result = await reconcilePublisherData(client, settings.tablePrefix, publisherId);
      results.push(result.descriptor);
    }

    return { reconciled: results };
  } finally {
    client.destroy();
  }
}
