import { z } from 'zod';
import { PeriodInputSchema, ToolResultSchema } from '@bid/shared';
import type { ToolResult } from '@bid/shared';
import { Analytics } from '../domain/analytics.js';
import { Configurations } from '../domain/configuration.js';
import { fixtureAnalytics, fixtureConfiguration } from '../fixtures/publishers.js';
import type { ExecutionContext } from '../domain/interfaces.js';
import type { ReadOnlyToolDefinition } from './types.js';

const analytics = new Analytics(fixtureAnalytics);
const configurations = new Configurations(fixtureConfiguration);

function define<T>(name: string, description: string, schema: z.ZodType<T>,
  execute: (input: T, context: ExecutionContext) => Promise<ToolResult>): ReadOnlyToolDefinition<unknown, ToolResult> {
  return { name, description, inputSchema: schema, outputSchema: ToolResultSchema, maxOutputBytes: 32_768, readOnly: true,
    async execute(input, context) {
      const result = await execute(schema.parse(input), context);

      return { data: result, evidence: result.evidence };
    } };
}

export const readOnlyTools = [
  define('performance_summary', 'Observed auction volume, fill, weighted winning CPM and estimated revenue in inclusive UTC dates. Demo observations only.',
    PeriodInputSchema, (input, context) => analytics.performanceSummary(context, input)),
  define('compare_periods', 'Compare two inclusive UTC periods, with counts, estimated revenue and percentage change. Does not establish causation.',
    z.strictObject({ current: PeriodInputSchema, previous: PeriodInputSchema }), (input, context) => analytics.comparePeriods(context, input)),
  define('bidder_performance', 'Bidder requests, responses, late responses, wins, latency and estimated revenue in inclusive UTC dates.',
    PeriodInputSchema, (input, context) => analytics.bidderPerformance(context, input)),
  define('current_configuration', 'Read the current publisher demo configuration and version. Cannot save or change it.',
    z.strictObject({}), (_input, context) => configurations.current(context)),
  define('configuration_history', 'Read timestamped publisher demo configuration history with updating-user attribution in inclusive UTC dates.',
    PeriodInputSchema, (input, context) => configurations.history(context, input)),
] as const;

export const modelTools = readOnlyTools.map((tool) => ({ type: 'function' as const, function: {
  name: tool.name, description: tool.description, parameters: z.toJSONSchema(tool.inputSchema, { target: 'draft-7' }),
} }));
