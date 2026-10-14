import { DeleteTableCommand, DescribeTableCommand, DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { setTimeout as sleep } from 'node:timers/promises';
import { localEndpoint, TablePrefixSchema } from './client.js';
import type { DatabaseSettings } from './client.js';
import { initializeDatabase } from './initialize.js';
import { tableDefinitions } from './tables.js';

export interface ResetOptions {
  endpoint: string;
  prefix: string;
  confirmation: string;
}

export function assertResetAllowed(settings: DatabaseSettings, options: ResetOptions): void {
  if (localEndpoint(options.endpoint) !== localEndpoint(settings.endpoint))
    throw new Error('RESET_REFUSED: endpoint must match configured local database');

  TablePrefixSchema.parse(options.prefix);

  if (options.prefix !== settings.tablePrefix)
    throw new Error('RESET_REFUSED: prefix must match configured project prefix');
  if (options.confirmation !== `DELETE ${options.prefix}`)
    throw new Error('RESET_REFUSED: explicit confirmation must be DELETE <prefix>');
}

/** Deletes only the three explicitly configured project tables; never the volume. */
export async function resetDatabase(
  client: DynamoDBClient,
  settings: DatabaseSettings,
  options: ResetOptions,
): Promise<{ tables: string[] }> {
  assertResetAllowed(settings, options);

  const signal = AbortSignal.timeout(15_000);

  for (const table of tableDefinitions(options.prefix)) {
    try {
      await client.send(new DeleteTableCommand({ TableName: table.name }), { abortSignal: signal });
    } catch (error) {
      if (!(error instanceof Error && error.name === 'ResourceNotFoundException')) throw error;
    }

    while (!signal.aborted) {
      try {
        await client.send(new DescribeTableCommand({ TableName: table.name }), {
          abortSignal: signal,
        });
      } catch (error) {
        if (error instanceof Error && error.name === 'ResourceNotFoundException') break;
        throw error;
      }

      await sleep(200, undefined, { signal });
    }

    signal.throwIfAborted();
  }

  return initializeDatabase(client, settings.tablePrefix);
}
