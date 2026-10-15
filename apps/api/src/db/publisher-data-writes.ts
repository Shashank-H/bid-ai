import {
  BatchWriteCommand,
  DynamoDBDocumentClient,
  QueryCommand,
  TransactWriteCommand,
} from '@aws-sdk/lib-dynamodb';
import type { BatchWriteCommandInput, TransactWriteCommandInput } from '@aws-sdk/lib-dynamodb';
import type { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { setTimeout as sleep } from 'node:timers/promises';
import { isDeepStrictEqual } from 'node:util';
import {
  CanonicalConfigurationHistorySchema,
  CanonicalConfigurationSchema,
  DatasetDescriptorSchema,
} from '@bid/shared';
import type {
  AuctionRecord,
  BidderMetrics,
  CanonicalConfiguration,
  CanonicalConfigurationHistory,
  DailyMetrics,
  DatasetDescriptor,
} from '@bid/shared';
import { TablePrefixSchema } from './client.js';
import {
  auctionPartitionKey,
  auctionRecordItem,
  bidderMetricsItem,
  configurationKey,
  dailyMetricsItem,
  datasetKey,
  eventPartitionKey,
  historyKey,
  publisherKey,
  queryPublisherPages,
  utcDates,
} from './publisher-data.js';
import type { PublisherDataItem } from './publisher-data.js';

function occupied(): never {
  throw new Error(
    'DATA_CONFLICT: publisher data already exists; one-time seed never replaces data',
  );
}

/** Explicit command-only writes; the serving repositories have no mutation capability. */
export class PublisherDataWriter {
  private readonly document: DynamoDBDocumentClient;
  private readonly table: string;

  constructor(client: DynamoDBClient, prefix: string) {
    TablePrefixSchema.parse(prefix);
    this.document = DynamoDBDocumentClient.from(client, {
      marshallOptions: { removeUndefinedValues: true },
    });
    this.table = `${prefix}-publisher-data`;
  }

  async preflightEmpty(
    descriptors: readonly DatasetDescriptor[],
    signal?: AbortSignal,
  ): Promise<void> {
    this.validateDescriptors(descriptors, 'loading');
    for (const descriptor of descriptors) {
      signal?.throwIfAborted();
      for await (const page of queryPublisherPages(
        this.document,
        this.table,
        {
          KeyConditionExpression: 'PK = :pk',
          ExpressionAttributeValues: { ':pk': publisherKey(descriptor.publisherId) },
        },
        signal,
      ))
        if (page.some((item) => item['SK'] !== 'METADATA')) occupied();
      for (const date of utcDates(descriptor.availablePeriod)) {
        for (const partition of [
          eventPartitionKey(descriptor.publisherId, date),
          auctionPartitionKey(descriptor.publisherId, date),
        ]) {
          signal?.throwIfAborted();
          const result = await this.document.send(
            new QueryCommand({
              TableName: this.table,
              KeyConditionExpression: 'PK = :pk',
              ExpressionAttributeValues: { ':pk': partition },
              ConsistentRead: true,
              Limit: 1,
              Select: 'COUNT',
            }),
            signal ? { abortSignal: signal } : {},
          );
          signal?.throwIfAborted();
          if ((result.Count ?? 0) > 0) occupied();
        }
      }
    }
  }

  async claimDatasets(
    descriptors: readonly DatasetDescriptor[],
    signal?: AbortSignal,
  ): Promise<void> {
    const records = this.validateDescriptors(descriptors, 'loading');
    signal?.throwIfAborted();
    try {
      await this.document.send(
        new TransactWriteCommand({
          TransactItems: records.map((data) => ({
            Put: {
              TableName: this.table,
              Item: { ...datasetKey(data.publisherId), data },
              ConditionExpression: 'attribute_not_exists(PK)',
            },
          })),
        }),
        signal ? { abortSignal: signal } : {},
      );
    } catch (error) {
      if (error instanceof Error && error.name === 'TransactionCanceledException') occupied();
      throw error;
    }
    signal?.throwIfAborted();
  }

  async writeConfigurations(
    current: readonly CanonicalConfiguration[],
    history: readonly CanonicalConfigurationHistory[],
    signal?: AbortSignal,
  ): Promise<void> {
    const configurations = current.map((record) => CanonicalConfigurationSchema.parse(record));
    const changes = history.map((record) => CanonicalConfigurationHistorySchema.parse(record));
    if (
      configurations.length !== 2 ||
      new Set(configurations.map((record) => record.publisherId)).size !== 2
    )
      throw new Error('INVALID_DATA: configuration seed must contain two distinct publishers');
    const puts: NonNullable<TransactWriteCommandInput['TransactItems']> = [];
    for (const configuration of configurations) {
      const timeline = changes
        .filter((record) => record.publisherId === configuration.publisherId)
        .sort((a, b) => a.version - b.version);
      if (!timeline.length || timeline[0]?.version !== 1 || timeline[0]?.before !== null)
        throw new Error('INVALID_DATA: configuration history must begin at initial version 1');
      for (let index = 0; index < timeline.length; index++) {
        const change = timeline[index]!;
        const previous = timeline[index - 1];
        if (
          change.version !== index + 1 ||
          (previous &&
            (change.timestamp <= previous.timestamp ||
              !isDeepStrictEqual(change.beforePrebid, previous.afterPrebid) ||
              !isDeepStrictEqual(change.before, previous.after)))
        )
          throw new Error('INVALID_DATA: configuration history must be continuous and ordered');
        puts.push({
          Put: {
            TableName: this.table,
            Item: { ...historyKey(change), data: change },
            ConditionExpression: 'attribute_not_exists(PK)',
          },
        });
      }
      const latest = timeline.at(-1)!;
      if (
        latest.version !== configuration.version ||
        latest.timestamp !== configuration.updatedAt ||
        latest.updatedByUserId !== configuration.updatedByUserId ||
        !isDeepStrictEqual(latest.afterPrebid, configuration.prebid) ||
        !isDeepStrictEqual(latest.after, configuration.settings)
      )
        throw new Error(
          'INVALID_DATA: current configuration must equal the final history snapshot',
        );
      puts.push({
        ConditionCheck: {
          TableName: this.table,
          Key: datasetKey(configuration.publisherId),
          ConditionExpression: '#data.#status = :loading',
          ExpressionAttributeNames: { '#data': 'data', '#status': 'status' },
          ExpressionAttributeValues: { ':loading': 'loading' },
        },
      });
      puts.push({
        Put: {
          TableName: this.table,
          Item: { ...configurationKey(configuration.publisherId), data: configuration },
          ConditionExpression: 'attribute_not_exists(PK)',
        },
      });
    }
    if (
      changes.some(
        (record) => !configurations.some((config) => config.publisherId === record.publisherId),
      ) ||
      puts.length > 100
    )
      throw new Error('INVALID_DATA: unsupported configuration history size or publisher');
    signal?.throwIfAborted();
    try {
      await this.document.send(
        new TransactWriteCommand({ TransactItems: puts }),
        signal ? { abortSignal: signal } : {},
      );
    } catch (error) {
      if (error instanceof Error && error.name === 'TransactionCanceledException')
        throw new Error(
          'DATA_CONFLICT: configurations were not replaced; loading datasets need operator review',
        );
      throw error;
    }
    signal?.throwIfAborted();
  }

  /** At most 25 items per request; retries retain only unprocessed items, never increment metrics. */
  private async batchPut(items: readonly PublisherDataItem[], signal?: AbortSignal): Promise<void> {
    if (items.length > 25)
      throw new Error('INVALID_INPUT: DynamoDB write batches may contain at most 25 records');
    if (new Set(items.map((item) => `${item.PK}\u0000${item.SK}`)).size !== items.length)
      throw new Error('INVALID_DATA: duplicate keys in a write batch');
    if (!items.length) return;
    let pending: NonNullable<BatchWriteCommandInput['RequestItems']> = {
      [this.table]: items.map((Item) => ({ PutRequest: { Item } })),
    };
    for (let attempt = 0; attempt < 6; attempt++) {
      signal?.throwIfAborted();
      const result = await this.document.send(
        new BatchWriteCommand({ RequestItems: pending }),
        signal ? { abortSignal: signal } : {},
      );
      signal?.throwIfAborted();
      const unprocessed = result.UnprocessedItems?.[this.table] ?? [];
      if (!unprocessed.length) return;
      if (attempt === 5)
        throw new Error(
          `DATA_WRITE_FAILED: ${unprocessed.length} records remain unprocessed after bounded retries`,
        );
      pending = { [this.table]: unprocessed };
      await sleep(Math.min(50 * 2 ** attempt, 800), undefined, signal ? { signal } : {});
    }
  }

  /** Validate the whole input before any I/O; batches contain auctions, not event rows. */
  async writeAuctions(records: readonly AuctionRecord[], signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    const items = records.map(auctionRecordItem);
    if (new Set(items.map((item) => `${item.PK}\u0000${item.SK}`)).size !== items.length)
      throw new Error('INVALID_DATA: duplicate auction keys');
    for (let offset = 0; offset < items.length; offset += 25)
      await this.batchPut(items.slice(offset, offset + 25), signal);
  }

  async writeMetrics(
    daily: readonly DailyMetrics[],
    bidders: readonly BidderMetrics[],
    signal?: AbortSignal,
  ): Promise<void> {
    const items = [...daily.map(dailyMetricsItem), ...bidders.map(bidderMetricsItem)];
    for (let offset = 0; offset < items.length; offset += 25)
      await this.batchPut(items.slice(offset, offset + 25), signal);
  }

  async activateDatasets(
    descriptors: readonly DatasetDescriptor[],
    signal?: AbortSignal,
  ): Promise<void> {
    const records = this.validateDescriptors(descriptors, 'ready');
    signal?.throwIfAborted();
    await this.document.send(
      new TransactWriteCommand({
        TransactItems: records.map((data) => ({
          Put: {
            TableName: this.table,
            Item: { ...datasetKey(data.publisherId), data },
            ConditionExpression:
              '#data.#status = :loading AND #data.#seed = :seed AND #data.#version = :version AND #data.#from = :from AND #data.#through = :through',
            ExpressionAttributeNames: {
              '#data': 'data',
              '#status': 'status',
              '#seed': 'seed',
              '#version': 'generatorVersion',
              '#from': 'observedFrom',
              '#through': 'observedThrough',
            },
            ExpressionAttributeValues: {
              ':loading': 'loading',
              ':seed': data.seed,
              ':version': data.generatorVersion,
              ':from': data.observedFrom,
              ':through': data.observedThrough,
            },
          },
        })),
      }),
      signal ? { abortSignal: signal } : {},
    );
    signal?.throwIfAborted();
  }

  private validateDescriptors(
    descriptors: readonly DatasetDescriptor[],
    status: DatasetDescriptor['status'],
  ): DatasetDescriptor[] {
    const records = descriptors.map((record) => DatasetDescriptorSchema.parse(record));
    if (
      records.length !== 2 ||
      new Set(records.map((record) => record.publisherId)).size !== 2 ||
      records.some((record) => record.status !== status)
    )
      throw new Error(`INVALID_DATA: expected two distinct ${status} publisher datasets`);
    for (const record of records) publisherKey(record.publisherId);
    return records;
  }
}
