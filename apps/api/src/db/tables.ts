import { TablePrefixSchema } from './client.js';

export interface TableDefinition {
  readonly name: string;
  readonly ttlAttribute?: string;
}

/** Foundation placeholders only; later phase plans may change keys/indexes. */
export function tableDefinitions(prefix: string): readonly TableDefinition[] {
  TablePrefixSchema.parse(prefix);

  return [
    { name: `${prefix}-identity`, ttlAttribute: 'expiresAt' },
    { name: `${prefix}-publisher-data` },
    { name: `${prefix}-workflow` },
  ];
}

export const provisionalKeySchema = [
  { AttributeName: 'PK', KeyType: 'HASH' as const },
  { AttributeName: 'SK', KeyType: 'RANGE' as const },
];

export const provisionalAttributes = [
  { AttributeName: 'PK', AttributeType: 'S' as const },
  { AttributeName: 'SK', AttributeType: 'S' as const },
];
