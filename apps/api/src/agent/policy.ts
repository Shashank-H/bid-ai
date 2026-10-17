export type SpecialistRole = 'read' | 'configuration' | 'response';

export const AGENT_LIMITS = {
  specialists: 6,
  decisions: 3,
  models: 9,
  tools: 12,
} as const;

const readNames = [
  'performance_summary',
  'compare_periods',
  'bidder_performance',
  'current_configuration',
  'configuration_history',
  'configuration_read',
  'configuration_versions',
  'configuration_compare',
];

const configurationNames = [
  'current_configuration',
  'configuration_history',
  'configuration_read',
  'configuration_versions',
  'configuration_compare',
  'configuration_propose_draft',
  'configuration_navigate',
];

export function allowedToolNames(role: SpecialistRole): readonly string[] {
  return role === 'read' ? readNames : role === 'configuration' ? configurationNames : [];
}
