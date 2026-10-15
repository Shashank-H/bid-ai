import assert from 'node:assert/strict';
import { access, mkdir, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { resolve } from 'node:path';
import { setImmediate as yieldToEvents } from 'node:timers/promises';
import { DatasetDescriptorSchema, expandAuctionRecord, groupAuctionRecords } from '@bid/shared';
import type { AuctionRecord, DatasetDescriptor } from '@bid/shared';
import { createDatabaseClient } from '../../apps/api/src/db/client.js';
import { IdentityRepository } from '../../apps/api/src/db/identity.js';
import { PublisherDataRepository } from '../../apps/api/src/db/publisher-data.js';
import { PublisherDataWriter } from '../../apps/api/src/db/publisher-data-writes.js';
import { reconcilePublisherData } from '../../apps/api/src/commands/data-reconcile.js';
import { databaseSettingsFromEnvironment } from '../../apps/api/src/env.js';
import { canonicalJson, createEventHasher } from '../../apps/api/src/domain/aggregation.js';
import {
  DEFAULT_SEED,
  PUBLISHER_IDS,
  createTimeline,
  datasetDates,
  loadingDescriptor,
} from './configuration.js';
import type { PublisherTimeline } from './configuration.js';
import { generateDay } from './simulation.js';
import type { SimulatedPublisher } from './simulation.js';
import { verifyCoverage, verifySensitivity } from './verify.js';
import { SCENARIO_MANIFEST, verifyScenarios } from './scenarios.js';

type Output = (message: string) => void;
export interface LoadOptions {
  seed?: string;
  signal?: AbortSignal;
  output?: Output;
}

function report(output: Output, value: unknown) {
  output(JSON.stringify(value));
}

async function checkpoint(signal?: AbortSignal) {
  signal?.throwIfAborted();
  await yieldToEvents();
  signal?.throwIfAborted();
}

/** Full candidate verification, yielding at UTC-day boundaries for cancellation. */
export async function verifyCandidate(seed = DEFAULT_SEED, signal?: AbortSignal) {
  // Validate seed/bounds before expensive simulation, filesystem access or database setup.
  for (const publisherId of PUBLISHER_IDS) loadingDescriptor(publisherId, seed);
  await checkpoint(signal);
  const sensitivity = verifySensitivity();
  const datasets: SimulatedPublisher[] = [];

  for (const publisherId of PUBLISHER_IDS) {
    const timeline = createTimeline(publisherId);
    const hasher = createEventHasher();
    const daily: SimulatedPublisher['daily'] = [];
    const bidders: SimulatedPublisher['bidders'] = [];
    let events = 0;
    hasher.add(timeline);

    for (const date of datasetDates()) {
      await checkpoint(signal);
      const generated = generateDay(publisherId, date, timeline.history, seed);
      const auctions = groupAuctionRecords(generated.events);
      const expanded = auctions
        .flatMap(expandAuctionRecord)
        .sort(
          (left, right) =>
            left.timestamp.localeCompare(right.timestamp) ||
            left.eventId.localeCompare(right.eventId),
        );
      assert.equal(auctions.length, generated.daily.auctions, 'auction record count differs');
      assert.equal(
        canonicalJson(expanded),
        canonicalJson(generated.events),
        'auction records lose event details',
      );
      for (const event of expanded) hasher.add(event);
      hasher.add({ daily: generated.daily, bidders: generated.bidders });
      daily.push(generated.daily);
      bidders.push(...generated.bidders);
      events += generated.eventCount;
    }

    datasets.push({
      timeline,
      daily,
      bidders,
      descriptor: DatasetDescriptorSchema.parse({
        ...loadingDescriptor(publisherId, seed),
        status: 'ready',
        counts: {
          events,
          auctions: daily.reduce((sum, day) => sum + day.auctions, 0),
          dailyMetrics: daily.length,
          bidderMetrics: bidders.length,
        },
        contentHash: hasher.digest(),
      }),
    });
  }

  await checkpoint(signal);
  verifyCoverage(datasets);
  const scenarios = verifyScenarios(datasets);
  signal?.throwIfAborted();
  return { datasets, sensitivity, scenarios };
}

/** Eight in-flight batches maximum; drain all writes before surfacing a failure. */
export async function writeAuctionBatches(
  writer: Pick<PublisherDataWriter, 'writeAuctions'>,
  items: readonly AuctionRecord[],
  signal?: AbortSignal,
) {
  let offset = 0;
  let failed = false;
  const workers = Array.from({ length: Math.min(8, Math.ceil(items.length / 25)) }, async () => {
    while (!failed && offset < items.length) {
      signal?.throwIfAborted();
      const batch = items.slice(offset, offset + 25);
      offset += 25;
      try {
        await writer.writeAuctions(batch, signal);
      } catch (error) {
        failed = true;
        throw error;
      }
    }
  });
  const results = await Promise.allSettled(workers);
  const rejection = results.find((result) => result.status === 'rejected');
  if (rejection) throw rejection.reason;
  signal?.throwIfAborted();
}

async function verifyAttribution(identities: IdentityRepository, signal?: AbortSignal) {
  for (const publisherId of PUBLISHER_IDS) {
    signal?.throwIfAborted();
    const letter = publisherId === 'publisher-a' ? 'a' : 'b';
    const userId = `demo-user-${letter}`;
    const user = await identities.findById(userId);
    signal?.throwIfAborted();
    const memberships = user ? await identities.memberships(userId) : [];
    signal?.throwIfAborted();
    if (
      !user ||
      user.disabled ||
      user.userId !== userId ||
      user.login !== `demo.${letter}` ||
      memberships.length !== 1 ||
      memberships[0]?.userId !== userId ||
      memberships[0]?.publisherId !== publisherId
    ) {
      throw new Error(
        `IDENTITY_REQUIRED: bootstrap the unchanged demo identity and membership for ${publisherId} first`,
      );
    }
  }
}

async function outputManifestPath(env: NodeJS.ProcessEnv, prefix: string) {
  const directory = resolve(env['PHASE3_OUTPUT_DIR'] ?? '/tmp/bid-phase3-output');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await access(directory, constants.W_OK);
  const path = resolve(directory, `private-scenario-manifest-${prefix}.json`);
  try {
    await access(path);
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return path;
    throw error;
  }
  throw new Error(
    'OUTPUT_CONFLICT: private manifest already exists; choose an unused output directory',
  );
}

/** One-time, configuration-first loading. No rollback, replacement, reset or resume path. */
export async function loadHistoricalData(env: NodeJS.ProcessEnv, options: LoadOptions = {}) {
  const seed = options.seed ?? DEFAULT_SEED;
  const { signal } = options;
  const output = options.output ?? console.log;
  const started = Date.now();
  const loading = PUBLISHER_IDS.map((publisherId) => loadingDescriptor(publisherId, seed));
  const settings = databaseSettingsFromEnvironment(env);
  const client = createDatabaseClient(settings);
  const reader = new PublisherDataRepository(client, settings.tablePrefix);
  const writer = new PublisherDataWriter(client, settings.tablePrefix);
  const identities = new IdentityRepository(client, settings.tablePrefix);
  let phase = 'preflight';
  let claimAttempted = false;
  let activated = false;

  try {
    await checkpoint(signal);
    await writer.preflightEmpty(loading, signal);
    await verifyAttribution(identities, signal);
    const manifestPath = await outputManifestPath(env, settings.tablePrefix);
    report(output, {
      event: 'preflight-passed',
      publishers: PUBLISHER_IDS,
      tablePrefix: settings.tablePrefix,
    });

    phase = 'candidate-verification';
    const candidate = await verifyCandidate(seed, signal);
    report(output, {
      event: 'candidate-verified',
      datasets: candidate.datasets.map((dataset) => dataset.descriptor),
    });

    // Recheck occupied keys/attribution after simulation; conditional writes fence competing seeds.
    await writer.preflightEmpty(loading, signal);
    await verifyAttribution(identities, signal);
    phase = 'claim';
    claimAttempted = true;
    await writer.claimDatasets(loading, signal);
    phase = 'configuration';
    await writer.writeConfigurations(
      candidate.datasets.map((dataset) => dataset.timeline.current),
      candidate.datasets.flatMap((dataset) => dataset.timeline.history),
      signal,
    );

    const stored: SimulatedPublisher[] = [];
    phase = 'loading';
    for (const expected of candidate.datasets) {
      const publisherId = expected.descriptor.publisherId;
      const readback = await reader.readConfigurations(publisherId, signal);
      assert(readback.current, 'stored configuration is missing');
      const timeline: PublisherTimeline = { current: readback.current, history: readback.history };
      assert.equal(
        canonicalJson(timeline),
        canonicalJson(expected.timeline),
        'stored configuration/history differs from the verified timeline',
      );

      for (const date of datasetDates()) {
        await checkpoint(signal);
        const generated = generateDay(
          expected.timeline.current.publisherId as (typeof PUBLISHER_IDS)[number],
          date,
          timeline.history,
          seed,
        );
        const auctions = groupAuctionRecords(generated.events);
        await writeAuctionBatches(writer, auctions, signal);
        report(output, {
          event: 'day-loaded',
          publisherId,
          date,
          auctions: auctions.length,
          events: generated.eventCount,
          storageFormat: 'auctions',
        });
      }

      phase = 'reconciliation';
      const observed = await reconcilePublisherData(client, settings.tablePrefix, publisherId, {
        allowLoading: true,
        write: false,
        ...(signal ? { signal } : {}),
      });
      assert.equal(
        canonicalJson(observed.descriptor),
        canonicalJson(expected.descriptor),
        'persisted content hash/counts differ from the verified candidate',
      );
      assert.equal(
        canonicalJson(observed.daily),
        canonicalJson(expected.daily),
        'persisted daily metrics differ from the verified candidate',
      );
      assert.equal(
        canonicalJson(observed.bidders),
        canonicalJson(expected.bidders),
        'persisted bidder metrics differ from the verified candidate',
      );
      stored.push({ ...observed, timeline });
      phase = 'loading';
    }

    phase = 'metrics-and-manifest';
    await checkpoint(signal);
    for (const dataset of stored) await writer.writeMetrics(dataset.daily, dataset.bidders, signal);
    await writeFile(
      manifestPath,
      `${JSON.stringify(
        {
          manifest: SCENARIO_MANIFEST,
          seed,
          datasets: stored.map((dataset) => dataset.descriptor),
          observations: candidate.scenarios,
        },
        null,
        2,
      )}\n`,
      { encoding: 'utf8', mode: 0o600, flag: 'wx' },
    );

    phase = 'activation';
    await checkpoint(signal);
    const datasets: DatasetDescriptor[] = stored.map((dataset) => dataset.descriptor);
    await writer.activateDatasets(datasets, signal);
    activated = true;
    phase = 'ready';
    const result = {
      event: 'seed-ready',
      tablePrefix: settings.tablePrefix,
      datasets,
      auctions: datasets.reduce((sum, dataset) => sum + dataset.counts!.auctions, 0),
      events: datasets.reduce((sum, dataset) => sum + dataset.counts!.events, 0),
      storageFormat: 'auctions',
      durationMs: Date.now() - started,
      privateManifestPath: manifestPath,
    };
    report(output, result);
    return result;
  } catch (error) {
    report(output, {
      event: 'seed-failed',
      phase,
      publishers: PUBLISHER_IDS,
      status: activated ? 'ready' : claimAttempted ? 'inspect-loading-status' : 'unchanged',
      automaticCleanup: false,
    });
    throw error;
  } finally {
    client.destroy();
  }
}
