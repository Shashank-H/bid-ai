import { z } from 'zod';
import { allowedToolNames } from '../agent/policy.js';
import type { SpecialistRole } from '../agent/policy.js';
import { PeriodInputSchema, ToolResultSchema } from '@bid/shared';
import type { ToolResult } from '@bid/shared';
import { Analytics } from '../domain/analytics.js';
import { Configurations } from '../domain/configuration.js';
import { fixtureAnalytics, fixtureConfiguration } from '../fixtures/publishers.js';
import type {
  AnalyticsRepository,
  ConfigurationRepository,
  ExecutionContext,
} from '../domain/interfaces.js';
import type { ReadOnlyToolDefinition } from './types.js';

export type ReadOnlyTool = ReadOnlyToolDefinition<unknown, ToolResult>;

function define<T>(
  name: string,
  description: string,
  schema: z.ZodType<T>,
  execute: (input: T, context: ExecutionContext) => Promise<ToolResult>,
): ReadOnlyTool {
  return {
    name,
    description,
    inputSchema: schema,
    outputSchema: ToolResultSchema,
    maxOutputBytes: 32_768,
    readOnly: true,
    async execute(input, context) {
      const result = await execute(schema.parse(input), context);

      return { data: result, evidence: result.evidence };
    },
  };
}

/** One registry per application; repository selection never mutates global tool state. */
export function createReadOnlyTools(
  analyticsRepository: AnalyticsRepository,
  configurationRepository: ConfigurationRepository,
): readonly ReadOnlyTool[] {
  const analytics = new Analytics(analyticsRepository);
  const configurations = new Configurations(configurationRepository);

  return [
    define(
      'performance_summary',
      'Observed auction volume, fill, weighted winning CPM and estimated revenue in inclusive UTC dates.',
      PeriodInputSchema,
      (input, context) => analytics.performanceSummary(context, input),
    ),
    define(
      'compare_periods',
      'Compare two inclusive UTC periods, with counts, estimated revenue and percentage change. Does not establish causation.',
      z.strictObject({ current: PeriodInputSchema, previous: PeriodInputSchema }),
      (input, context) => analytics.comparePeriods(context, input),
    ),
    define(
      'bidder_performance',
      'Bidder requests, observed offers, eligible and late offers, wins, latency and estimated revenue in inclusive UTC dates. Evidence references identify bidder-period aggregates.',
      PeriodInputSchema,
      (input, context) => analytics.bidderPerformance(context, input),
    ),
    define(
      'current_configuration',
      'Read the current publisher configuration, native Prebid snapshot, version and parameter tradeoffs. Cannot save or change it.',
      z.strictObject({}),
      (_input, context) => configurations.current(context),
    ),
    define(
      'configuration_history',
      'Read timestamped publisher configuration history with updating-user attribution, native Prebid snapshots and parameter tradeoffs in inclusive UTC dates.',
      PeriodInputSchema,
      (input, context) => configurations.history(context, input),
    ),
  ];
}

// Explicit fixture defaults preserve isolated callers; serving startup injects its own registry.
export const readOnlyTools = createReadOnlyTools(fixtureAnalytics, fixtureConfiguration);
export function toolsForModel(tools: readonly ReadOnlyTool[]) {
  return tools.map((tool) => ({
    type: 'function' as const,
    function: {
      name: tool.name,
      description: tool.description,
      parameters: z.toJSONSchema(tool.inputSchema, { target: 'draft-7' }),
    },
  }));
}

export function toolsForSpecialist(tools: ReturnType<typeof toolsForModel>, role: SpecialistRole) {
  const allowed = allowedToolNames(role);

  return tools.filter((tool) => allowed.includes(tool.function.name));
}

export const modelTools = toolsForModel(readOnlyTools);
