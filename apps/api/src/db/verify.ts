import { DynamoDBClient, ScanCommand } from '@aws-sdk/client-dynamodb';
import type { AttributeValue } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, DeleteCommand, GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { randomUUID } from 'node:crypto';
import { databaseReady } from './readiness.js';
import { tableDefinitions } from './tables.js';

/** Read-only verification; counts are scanned rather than using delayed Table.ItemCount. */
export async function verifyDatabase(client: DynamoDBClient, prefix: string): Promise<{ tables: { name: string; count: number }[] }> {
  if (!await databaseReady(client, prefix)) throw new Error('DATABASE_NOT_READY');

  const signal = AbortSignal.timeout(15_000);
  const tables = [];

  for (const table of tableDefinitions(prefix)) {
    let count = 0;
    let cursor: Record<string, AttributeValue> | undefined;

    do {
      const result = await client.send(new ScanCommand({ TableName: table.name, Select: 'COUNT', ConsistentRead: true,
        ...(cursor ? { ExclusiveStartKey: cursor } : {}),
      }), { abortSignal: signal });
      count += result.Count ?? 0;
      cursor = result.LastEvaluatedKey;
    } while (cursor);

    tables.push({ name: table.name, count });
  }

  return { tables };
}

/** A verification record is isolated by a unique key; it is never seed/demo data. */
export async function persistenceRecord(client: DynamoDBClient, prefix: string,
  action: 'write' | 'read' | 'delete', token: string): Promise<{ token: string; present: boolean }> {
  if (!/^[a-f0-9-]{36}$/.test(token)) throw new Error('INVALID_VERIFICATION_TOKEN');

  const table = tableDefinitions(prefix)[0]!;
  const Key = { PK: `VERIFY#${token}`, SK: 'PERSISTENCE' };
  const document = DynamoDBDocumentClient.from(client);
  const options = { abortSignal: AbortSignal.timeout(5000) };

  if (action === 'write') {
    await document.send(new PutCommand({ TableName: table.name, Item: { ...Key, verification: token },
      ConditionExpression: 'attribute_not_exists(PK)',
    }), options);
  } else if (action === 'delete') {
    await document.send(new DeleteCommand({ TableName: table.name, Key, ConditionExpression: 'verification = :token',
      ExpressionAttributeValues: { ':token': token },
    }), options);
  }

  const result = await document.send(new GetCommand({ TableName: table.name, Key, ConsistentRead: true }), options);

  return { token, present: result.Item?.verification === token };
}

export function newVerificationToken(): string {
  return randomUUID();
}
