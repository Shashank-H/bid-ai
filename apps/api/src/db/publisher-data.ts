import { DynamoDBDocumentClient, GetCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import type { QueryCommandInput } from '@aws-sdk/lib-dynamodb';
import type { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  AuctionRecordSchema,
  BidderMetricsSchema,
  CanonicalAuctionEventSchema,
  compareAuctionEvents,
  expandAuctionRecord,
  CanonicalConfigurationHistorySchema,
  CanonicalConfigurationSchema,
  DailyMetricsSchema,
  DatasetDescriptorSchema,
  DateSchema,
  IdSchema,
  PeriodInputSchema,
  PublisherDatasetMetadataSchema,
} from '@bid/shared';
import type {
  AuctionRecord,
  BidderMetrics,
  CanonicalConfiguration,
  CanonicalConfigurationHistory,
  DailyMetrics,
  DatasetDescriptor,
  NormalizedAuctionEvent,
  PeriodInput,
  PublisherDatasetMetadata,
} from '@bid/shared';
import type {
  AnalyticsRepository,
  ConfigurationRepository,
  DatasetRepository,
  ExecutionContext,
} from '../domain/interfaces.js';
import { HttpError } from '../errors.js';
import { TablePrefixSchema } from './client.js';

export interface PublisherDataKey {
  PK: string;
  SK: string;
}

export interface PublisherDataItem extends PublisherDataKey {
  data: unknown;
}

function component(value: string): string {
  const identifier = IdSchema.parse(value);
  if (identifier.includes('#')) throw new Error('INVALID_INPUT: key identifiers cannot contain #');
  return identifier;
}

export function publisherKey(publisherId: string): string {
  return `PUBLISHER#${component(publisherId)}`;
}

export function datasetKey(publisherId: string): PublisherDataKey {
  return { PK: publisherKey(publisherId), SK: 'DATASET' };
}

export function configurationKey(publisherId: string): PublisherDataKey {
  return { PK: publisherKey(publisherId), SK: 'CONFIGURATION' };
}

export function historyKey(record: CanonicalConfigurationHistory): PublisherDataKey {
  return {
    PK: publisherKey(record.publisherId),
    SK: `HISTORY#${new Date(record.timestamp).toISOString()}#${component(record.historyId)}`,
  };
}

export function dailyMetricsKey(
  record: Pick<DailyMetrics, 'publisherId' | 'date'>,
): PublisherDataKey {
  return { PK: publisherKey(record.publisherId), SK: `DAILY#${DateSchema.parse(record.date)}` };
}

export function bidderMetricsKey(
  record: Pick<BidderMetrics, 'publisherId' | 'date' | 'bidderId'>,
): PublisherDataKey {
  return {
    PK: publisherKey(record.publisherId),
    SK: `BIDDER#${component(record.bidderId)}#DAY#${DateSchema.parse(record.date)}`,
  };
}

export function eventPartitionKey(publisherId: string, date: string): string {
  return `${publisherKey(publisherId)}#EVENTS#${DateSchema.parse(date)}`;
}

export function eventKey(record: NormalizedAuctionEvent): PublisherDataKey {
  return {
    PK: eventPartitionKey(record.publisherId, record.timestamp.slice(0, 10)),
    SK: `${new Date(record.timestamp).toISOString()}#${component(record.eventId)}`,
  };
}

export function eventItem(record: NormalizedAuctionEvent): PublisherDataItem {
  const data = CanonicalAuctionEventSchema.parse(record);
  return { ...eventKey(data), data };
}

export function auctionPartitionKey(publisherId: string, date: string): string {
  return `${publisherKey(publisherId)}#AUCTIONS#${DateSchema.parse(date)}`;
}

export function auctionRecordKey(record: AuctionRecord): PublisherDataKey {
  return {
    PK: auctionPartitionKey(record.publisherId, record.startedAt.slice(0, 10)),
    SK: `${new Date(record.startedAt).toISOString()}#${component(record.auctionId)}`,
  };
}

export function auctionRecordItem(record: AuctionRecord): PublisherDataItem {
  const data = AuctionRecordSchema.parse(record);
  const item = { ...auctionRecordKey(data), data };
  // Conservative headroom below DynamoDB's 400 KiB item limit, including map overhead.
  if (Buffer.byteLength(JSON.stringify(item), 'utf8') > 384 * 1024)
    throw new Error('INVALID_DATA: auction record exceeds the bounded DynamoDB item size');
  return item;
}

export function dailyMetricsItem(record: DailyMetrics): PublisherDataItem {
  const data = DailyMetricsSchema.parse(record);
  return { ...dailyMetricsKey(data), data };
}

export function bidderMetricsItem(record: BidderMetrics): PublisherDataItem {
  const data = BidderMetricsSchema.parse(record);
  return { ...bidderMetricsKey(data), data };
}

export function utcDates(period: PeriodInput): string[] {
  PeriodInputSchema.parse(period);
  const dates: string[] = [];
  for (
    let time = Date.parse(period.startDate);
    time <= Date.parse(period.endDate);
    time += 86_400_000
  )
    dates.push(new Date(time).toISOString().slice(0, 10));
  return dates;
}

function decode<T extends { publisherId: string }>(
  item: Record<string, unknown>,
  schema: { parse(value: unknown): T },
  publisherId: string,
  key: (record: T) => PublisherDataKey,
): T {
  const record = schema.parse(item['data']);
  const expected = key(record);
  if (
    record.publisherId !== publisherId ||
    item['PK'] !== expected.PK ||
    item['SK'] !== expected.SK
  )
    throw new HttpError(502, 'TOOL_FAILED', 'Stored publisher data failed ownership validation.');
  return record;
}

/** SDK pagination shared by bounded tool queries and command-only verification reads. */
export async function* queryPublisherPages(
  document: DynamoDBDocumentClient,
  table: string,
  input: Omit<QueryCommandInput, 'TableName' | 'ExclusiveStartKey'>,
  signal?: AbortSignal,
): AsyncGenerator<Record<string, unknown>[]> {
  let cursor: QueryCommandInput['ExclusiveStartKey'];
  do {
    signal?.throwIfAborted();
    const result = await document.send(
      new QueryCommand({
        ...input,
        TableName: table,
        ConsistentRead: true,
        ExclusiveStartKey: cursor,
      }),
      signal ? { abortSignal: signal } : {},
    );
    signal?.throwIfAborted();
    yield result.Items ?? [];
    cursor = result.LastEvaluatedKey;
  } while (cursor);
}

/** Serving reads are identity-scoped and ready-gated; explicit read* methods are for commands. */
export class PublisherDataRepository
  implements AnalyticsRepository, ConfigurationRepository, DatasetRepository
{
  private readonly document: DynamoDBDocumentClient;
  private readonly table: string;

  constructor(client: DynamoDBClient, prefix: string) {
    TablePrefixSchema.parse(prefix);
    this.document = DynamoDBDocumentClient.from(client);
    this.table = `${prefix}-publisher-data`;
  }

  async readDataset(publisherId: string, signal?: AbortSignal): Promise<DatasetDescriptor | null> {
    const Key = datasetKey(publisherId);
    signal?.throwIfAborted();
    const result = await this.document.send(
      new GetCommand({ TableName: this.table, Key, ConsistentRead: true }),
      signal ? { abortSignal: signal } : {},
    );
    signal?.throwIfAborted();
    return result.Item
      ? decode(result.Item, DatasetDescriptorSchema, publisherId, (data) =>
          datasetKey(data.publisherId),
        )
      : null;
  }

  async getDataset(context: ExecutionContext): Promise<DatasetDescriptor | null> {
    const descriptor = await this.readDataset(context.identity.publisherId, context.signal);
    if (descriptor?.status === 'loading')
      throw new HttpError(503, 'DEPENDENCY_UNAVAILABLE', 'The publisher dataset is not ready.');
    return descriptor;
  }

  async getPublicMetadata(context: ExecutionContext): Promise<PublisherDatasetMetadata> {
    const descriptor = await this.readDataset(context.identity.publisherId, context.signal);
    if (!descriptor || descriptor.status !== 'ready')
      return PublisherDatasetMetadataSchema.parse({
        availablePeriod: null,
        synthetic: true,
        status: descriptor ? 'loading' : 'empty',
        lastCompleteDate: null,
      });
    const dates = utcDates(descriptor.availablePeriod);
    const lastCompleteDate =
      dates.findLast((date) => !descriptor.partialDates.includes(date)) ?? null;
    return PublisherDatasetMetadataSchema.parse({
      availablePeriod: descriptor.availablePeriod,
      synthetic: true,
      status: 'ready',
      observedFrom: descriptor.observedFrom,
      observedThrough: descriptor.observedThrough,
      partialDates: descriptor.partialDates,
      lastCompleteDate,
    });
  }

  async readCurrent(
    publisherId: string,
    signal?: AbortSignal,
  ): Promise<CanonicalConfiguration | null> {
    const Key = configurationKey(publisherId);
    signal?.throwIfAborted();
    const result = await this.document.send(
      new GetCommand({ TableName: this.table, Key, ConsistentRead: true }),
      signal ? { abortSignal: signal } : {},
    );
    signal?.throwIfAborted();
    return result.Item
      ? decode(result.Item, CanonicalConfigurationSchema, publisherId, (data) =>
          configurationKey(data.publisherId),
        )
      : null;
  }

  async current(context: ExecutionContext): Promise<CanonicalConfiguration | null> {
    if (!(await this.getDataset(context))) return null;
    return this.readCurrent(context.identity.publisherId, context.signal);
  }

  async readHistory(
    publisherId: string,
    period?: PeriodInput,
    signal?: AbortSignal,
  ): Promise<CanonicalConfigurationHistory[]> {
    if (period) PeriodInputSchema.parse(period);
    const input: Omit<QueryCommandInput, 'TableName' | 'ExclusiveStartKey'> = period
      ? {
          KeyConditionExpression: 'PK = :pk AND SK BETWEEN :start AND :end',
          ExpressionAttributeValues: {
            ':pk': publisherKey(publisherId),
            ':start': `HISTORY#${period.startDate}`,
            ':end': `HISTORY#${period.endDate}\uffff`,
          },
        }
      : {
          KeyConditionExpression: 'PK = :pk AND begins_with(SK, :kind)',
          ExpressionAttributeValues: { ':pk': publisherKey(publisherId), ':kind': 'HISTORY#' },
        };
    const records: CanonicalConfigurationHistory[] = [];
    for await (const page of queryPublisherPages(this.document, this.table, input, signal)) {
      for (const item of page)
        records.push(decode(item, CanonicalConfigurationHistorySchema, publisherId, historyKey));
      if (records.length > 50)
        throw new HttpError(
          502,
          'TOOL_FAILED',
          'Configuration history exceeds the supported profile.',
        );
    }
    return records;
  }

  async readConfigurations(publisherId: string, signal?: AbortSignal) {
    const current = await this.readCurrent(publisherId, signal);
    const history = await this.readHistory(publisherId, undefined, signal);
    return { current, history };
  }

  async history(
    context: ExecutionContext,
    period: PeriodInput,
  ): Promise<CanonicalConfigurationHistory[]> {
    PeriodInputSchema.parse(period);
    if (!(await this.getDataset(context))) return [];
    return this.readHistory(context.identity.publisherId, period, context.signal);
  }

  async daily(context: ExecutionContext, period: PeriodInput): Promise<DailyMetrics[]> {
    PeriodInputSchema.parse(period);
    if (!(await this.getDataset(context))) return [];
    const publisherId = context.identity.publisherId;
    const records: DailyMetrics[] = [];
    for await (const page of queryPublisherPages(
      this.document,
      this.table,
      {
        KeyConditionExpression: 'PK = :pk AND SK BETWEEN :start AND :end',
        ExpressionAttributeValues: {
          ':pk': publisherKey(publisherId),
          ':start': `DAILY#${period.startDate}`,
          ':end': `DAILY#${period.endDate}`,
        },
      },
      context.signal,
    )) {
      for (const item of page)
        records.push(decode(item, DailyMetricsSchema, publisherId, dailyMetricsKey));
      if (records.length > 90)
        throw new HttpError(502, 'TOOL_FAILED', 'Daily metrics exceed the query bound.');
    }
    return records;
  }

  async bidders(context: ExecutionContext, period: PeriodInput): Promise<BidderMetrics[]> {
    PeriodInputSchema.parse(period);
    if (!(await this.getDataset(context))) return [];
    const publisherId = context.identity.publisherId;
    const configuration = await this.readCurrent(publisherId, context.signal);
    if (!configuration)
      throw new HttpError(502, 'TOOL_FAILED', 'Ready data is missing configuration.');
    const history = await this.readHistory(publisherId, undefined, context.signal);
    const bidderIds = [
      ...new Set([
        ...configuration.settings.enabledBidders,
        ...history.flatMap((change) => change.after.enabledBidders),
      ]),
    ];
    if (bidderIds.length > 5)
      throw new HttpError(502, 'TOOL_FAILED', 'Bidder metrics exceed the supported profile.');
    const records: BidderMetrics[] = [];
    for (const bidderId of bidderIds) {
      const prefix = `BIDDER#${component(bidderId)}#DAY#`;
      for await (const page of queryPublisherPages(
        this.document,
        this.table,
        {
          KeyConditionExpression: 'PK = :pk AND SK BETWEEN :start AND :end',
          ExpressionAttributeValues: {
            ':pk': publisherKey(publisherId),
            ':start': `${prefix}${period.startDate}`,
            ':end': `${prefix}${period.endDate}`,
          },
        },
        context.signal,
      )) {
        for (const item of page) {
          const record = decode(item, BidderMetricsSchema, publisherId, bidderMetricsKey);
          if (record.bidderId !== bidderId)
            throw new HttpError(
              502,
              'TOOL_FAILED',
              'Stored bidder data failed ownership validation.',
            );
          records.push(record);
        }
        if (records.length > 450)
          throw new HttpError(502, 'TOOL_FAILED', 'Bidder metrics exceed the query bound.');
      }
    }
    return records;
  }

  async *readEvents(
    publisherId: string,
    date: string,
    signal?: AbortSignal,
  ): AsyncGenerator<NormalizedAuctionEvent> {
    DateSchema.parse(date);
    const descriptor = await this.readDataset(publisherId, signal);
    if (descriptor?.storageFormat === 'auctions') {
      // Adjacent auctions may overlap. Sort a bounded UTC day globally so expanded
      // events retain the original timestamp#eventId hash/aggregation ordering.
      const events: NormalizedAuctionEvent[] = [];
      const auctionIds = new Set<string>();
      for await (const page of queryPublisherPages(
        this.document,
        this.table,
        {
          KeyConditionExpression: 'PK = :pk',
          ExpressionAttributeValues: { ':pk': auctionPartitionKey(publisherId, date) },
        },
        signal,
      )) {
        for (const item of page) {
          signal?.throwIfAborted();
          const record = decode(item, AuctionRecordSchema, publisherId, auctionRecordKey);
          if (record.startedAt.slice(0, 10) !== date || auctionIds.has(record.auctionId))
            throw new Error('INVALID_DATA: duplicate auction or mismatched date partition');
          auctionIds.add(record.auctionId);
          if (auctionIds.size > 10_000)
            throw new Error('INVALID_DATA: auction date exceeds the supported daily bound');
          events.push(...expandAuctionRecord(record));
        }
      }
      signal?.throwIfAborted();
      events.sort(compareAuctionEvents);
      for (const event of events) {
        signal?.throwIfAborted();
        yield event;
      }
      return;
    }
    for await (const page of queryPublisherPages(
      this.document,
      this.table,
      {
        KeyConditionExpression: 'PK = :pk',
        ExpressionAttributeValues: { ':pk': eventPartitionKey(publisherId, date) },
      },
      signal,
    )) {
      const events = page.map((item) =>
        decode(item, CanonicalAuctionEventSchema, publisherId, eventKey),
      );
      if (events.some((event) => event.timestamp.slice(0, 10) !== date))
        throw new Error('INVALID_DATA: event date partition does not match its timestamp');
      for (const event of events) {
        signal?.throwIfAborted();
        yield event;
      }
    }
  }

  // Phase 3 remains read-only. No dormant unsafe mutation path is exposed.
  async save(): Promise<void> {
    throw new HttpError(405, 'NOT_IMPLEMENTED', 'Configuration changes are not enabled.');
  }
}
