import { z } from 'zod';

export const IdSchema = z.string().trim().min(1).max(128);
export const TimestampSchema = z.iso.datetime({ offset: false });
export const DateSchema = z.iso.date();
export const CurrencySchema = z.string().regex(/^[A-Z]{3}$/);
export const CounterSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const AmountSchema = z.number().finite().nonnegative();
export const RatioSchema = z.number().min(0).max(1).nullable();

// Tool input deliberately has no publisher: authorization supplies it separately.
export const PeriodInputSchema = z
  .strictObject({
    startDate: DateSchema,
    endDate: DateSchema,
  })
  .refine(({ startDate, endDate }) => startDate <= endDate, {
    message: 'Period end must not precede start',
  })
  .refine(
    ({ startDate, endDate }) => (Date.parse(endDate) - Date.parse(startDate)) / 86_400_000 < 90,
    {
      message: 'Period may cover at most 90 UTC dates',
    },
  );

export type PeriodInput = z.infer<typeof PeriodInputSchema>;
