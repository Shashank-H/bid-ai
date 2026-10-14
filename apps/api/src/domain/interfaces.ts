import type {
  BidderMetrics,
  Configuration,
  ConfigurationHistory,
  DailyMetrics,
  PeriodInput,
  PublisherMembership,
  ToolResult,
  User,
} from '@bid/shared';

// Only the future server authorization resolver may establish this opaque brand.
// There is intentionally no JSON parser or public constructor for trusted context.
declare const authorizedPublisherContext: unique symbol;
export interface UserPublisherContext {
  readonly userId: string;
  readonly publisherId: string;
  readonly [authorizedPublisherContext]: true;
}

export interface ExecutionContext {
  readonly identity: UserPublisherContext;
  readonly correlationId: string;
  readonly signal: AbortSignal;
}

export interface UserRepository {
  findByLogin(login: string): Promise<User | null>;
  findById(userId: string): Promise<User | null>;
  memberships(userId: string): Promise<readonly PublisherMembership[]>;
}

export interface AnalyticsRepository {
  daily(context: ExecutionContext, period: PeriodInput): Promise<readonly DailyMetrics[]>;
  bidders(context: ExecutionContext, period: PeriodInput): Promise<readonly BidderMetrics[]>;
}

export interface ConfigurationRepository {
  current(context: ExecutionContext): Promise<Configuration | null>;
  history(context: ExecutionContext, period: PeriodInput): Promise<readonly ConfigurationHistory[]>;
  // Implemented in Phase 2: conditionally save current + immutable history atomically.
  save(
    context: ExecutionContext,
    expectedVersion: number,
    next: Configuration,
    history: ConfigurationHistory,
  ): Promise<void>;
}

export interface AnalyticsService {
  performanceSummary(context: ExecutionContext, period: PeriodInput): Promise<ToolResult>;
  comparePeriods(
    context: ExecutionContext,
    periods: { current: PeriodInput; previous: PeriodInput },
  ): Promise<ToolResult>;
  bidderPerformance(context: ExecutionContext, period: PeriodInput): Promise<ToolResult>;
}

export interface ConfigurationService {
  current(context: ExecutionContext): Promise<ToolResult>;
  history(context: ExecutionContext, period: PeriodInput): Promise<ToolResult>;
}
