import { DescribeTableCommand, DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { tableDefinitions } from './tables.js';

/** Public callers expose only readiness, not SDK diagnostics or environment data. */
export async function databaseReady(
  client: DynamoDBClient,
  prefix: string,
  timeoutMs = 4000,
): Promise<boolean> {
  const signal = AbortSignal.timeout(timeoutMs);

  try {
    const results = await Promise.all(
      tableDefinitions(prefix).map((table) =>
        client.send(new DescribeTableCommand({ TableName: table.name }), { abortSignal: signal }),
      ),
    );

    return results.every((result) => result.Table?.TableStatus === 'ACTIVE');
  } catch {
    return false;
  }
}
