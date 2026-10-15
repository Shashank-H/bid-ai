import { z } from 'zod';
import {
  CounterSchema,
  DateSchema,
  IdSchema,
  PeriodInputSchema,
  TimestampSchema,
} from './common.js';
import { PREBID_VERSION } from './prebid.js';

export const DatasetCountsSchema = z.strictObject({
  events: CounterSchema,
  auctions: CounterSchema,
  dailyMetrics: CounterSchema,
  bidderMetrics: CounterSchema,
});

// Public reproduction/coverage facts only: no scenario names, causes or expected answers.
export const DatasetDescriptorSchema = z
  .strictObject({
    publisherId: IdSchema,
    status: z.enum(['loading', 'ready']),
    synthetic: z.literal(true),
    seed: z.string().min(1).max(128),
    generatorVersion: z.string().min(1).max(50),
    // Older datasets omit this field and store one item per normalized event.
    storageFormat: z.enum(['events', 'auctions']).optional(),
    prebidVersion: z.literal(PREBID_VERSION),
    observedFrom: TimestampSchema,
    observedThrough: TimestampSchema,
    availablePeriod: PeriodInputSchema,
    partialDates: z.array(DateSchema).max(2),
    auctionsPerDay: z.number().int().positive().max(1_000_000),
    counts: DatasetCountsSchema.optional(),
    contentHash: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
  })
  .refine((descriptor) => descriptor.observedFrom < descriptor.observedThrough, {
    message: 'Dataset observation bounds must be ordered',
  })
  .refine(
    (descriptor) =>
      descriptor.availablePeriod.startDate === descriptor.observedFrom.slice(0, 10) &&
      descriptor.availablePeriod.endDate === descriptor.observedThrough.slice(0, 10) &&
      new Set(descriptor.partialDates).size === descriptor.partialDates.length &&
      descriptor.partialDates.every(
        (date) =>
          date >= descriptor.availablePeriod.startDate &&
          date <= descriptor.availablePeriod.endDate,
      ),
    { message: 'Dataset date coverage and partial dates must agree with observation bounds' },
  )
  .refine(
    (descriptor) =>
      descriptor.status !== 'ready' ||
      (descriptor.counts !== undefined && descriptor.contentHash !== undefined),
    { message: 'Ready datasets require verified counts and a content hash' },
  );

// Available dates remain nullable for a publisher whose database has no ready observations.
export const PublisherDatasetMetadataSchema = z.strictObject({
  availablePeriod: PeriodInputSchema.nullable(),
  synthetic: z.literal(true).optional(),
  status: z.enum(['empty', 'loading', 'ready']).optional(),
  observedFrom: TimestampSchema.optional(),
  observedThrough: TimestampSchema.optional(),
  partialDates: z.array(DateSchema).max(2).optional(),
  lastCompleteDate: DateSchema.nullable().optional(),
});

export type DatasetCounts = z.infer<typeof DatasetCountsSchema>;
export type DatasetDescriptor = z.infer<typeof DatasetDescriptorSchema>;
export type PublisherDatasetMetadata = z.infer<typeof PublisherDatasetMetadataSchema>;
