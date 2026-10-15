import type {
  Configuration,
  ConfigurationHistory,
  EvidenceReference,
  PeriodInput,
  ToolResult,
} from '@bid/shared';
import type {
  ConfigurationRepository,
  ConfigurationService,
  ExecutionContext,
} from './interfaces.js';
import { PREBID_PARAMETER_IMPACTS } from './prebid-configuration.js';

function evidence(record: Configuration | ConfigurationHistory): EvidenceReference {
  const source = 'historyId' in record ? 'configuration-history' : 'configuration';
  const recordId =
    'historyId' in record
      ? record.historyId
      : `${record.publisherId}-configuration-v${record.version}`;

  return {
    evidenceId: recordId,
    publisherId: record.publisherId,
    source,
    recordId,
    observedAt: 'timestamp' in record ? record.timestamp : record.updatedAt,
  };
}

export class Configurations implements ConfigurationService {
  constructor(private readonly repository: ConfigurationRepository) {}

  async current(context: ExecutionContext): Promise<ToolResult> {
    const configuration = await this.repository.current(context);

    return {
      summary: configuration
        ? 'Current configuration; read-only. Native Prebid settings and derived summaries are synthetic where marked; parameter tradeoffs are not predictions.'
        : 'No configuration is available.',
      data: {
        kind: 'configuration',
        configuration,
        ...(configuration?.prebid ? { parameterImpacts: PREBID_PARAMETER_IMPACTS } : {}),
      },
      evidence: configuration ? [evidence(configuration)] : [],
      findings: [],
    };
  }

  async history(context: ExecutionContext, period: PeriodInput): Promise<ToolResult> {
    const history = await this.repository.history(context, period);

    return {
      summary: history.length
        ? 'Recorded changes with updating-user attribution, synthetic where marked; timing alone does not prove causation.'
        : 'No recorded changes in this period.',
      data: {
        kind: 'configuration-history',
        period,
        history: [...history],
        ...(history.some((record) => record.afterPrebid)
          ? { parameterImpacts: PREBID_PARAMETER_IMPACTS }
          : {}),
      },
      evidence: history.map(evidence),
      findings: [],
    };
  }
}
