import {
  CreateTableCommand,
  DescribeTableCommand,
  DescribeTimeToLiveCommand,
  DynamoDBClient,
  UpdateTimeToLiveCommand,
} from '@aws-sdk/client-dynamodb';
import { setTimeout as sleep } from 'node:timers/promises';
import { provisionalAttributes, provisionalKeySchema, tableDefinitions } from './tables.js';

function errorNamed(error: unknown, name: string): boolean {
  return error instanceof Error && error.name === name;
}

async function waitActive(
  client: DynamoDBClient,
  tableName: string,
  signal: AbortSignal,
): Promise<void> {
  while (!signal.aborted) {
    const response = await client.send(new DescribeTableCommand({ TableName: tableName }), {
      abortSignal: signal,
    });
    if (response.Table?.TableStatus === 'ACTIVE') return;

    await sleep(200, undefined, { signal });
  }

  signal.throwIfAborted();
}

/** Creates only absent resources. No delete, reset or data-write path exists here. */
export async function initializeDatabase(
  client: DynamoDBClient,
  prefix: string,
  timeoutMs = 15_000,
): Promise<{ tables: string[] }> {
  const signal = AbortSignal.timeout(timeoutMs);
  const definitions = tableDefinitions(prefix);

  for (const definition of definitions) {
    try {
      await client.send(new DescribeTableCommand({ TableName: definition.name }), {
        abortSignal: signal,
      });
    } catch (error) {
      if (!errorNamed(error, 'ResourceNotFoundException')) throw error;

      try {
        await client.send(
          new CreateTableCommand({
            TableName: definition.name,
            KeySchema: provisionalKeySchema,
            AttributeDefinitions: provisionalAttributes,
            BillingMode: 'PAY_PER_REQUEST',
          }),
          { abortSignal: signal },
        );
      } catch (createError) {
        // Simultaneous init may create the same table; validate it below regardless.
        if (!errorNamed(createError, 'ResourceInUseException')) throw createError;
      }
    }

    await waitActive(client, definition.name, signal);
    const { Table: table } = await client.send(
      new DescribeTableCommand({ TableName: definition.name }),
      { abortSignal: signal },
    );
    const keys = table?.KeySchema;

    if (
      keys?.length !== 2 ||
      !provisionalKeySchema.every((expected) =>
        keys.some(
          (key) => key.AttributeName === expected.AttributeName && key.KeyType === expected.KeyType,
        ),
      ) ||
      !provisionalAttributes.every((expected) =>
        table?.AttributeDefinitions?.some(
          (attribute) =>
            attribute.AttributeName === expected.AttributeName &&
            attribute.AttributeType === expected.AttributeType,
        ),
      )
    ) {
      throw new Error(
        `INCOMPATIBLE_SCHEMA: ${definition.name}; initialization never resets existing tables`,
      );
    }

    const { TimeToLiveDescription: ttl } = await client.send(
      new DescribeTimeToLiveCommand({ TableName: definition.name }),
      { abortSignal: signal },
    );
    if (definition.ttlAttribute) {
      if (ttl?.TimeToLiveStatus === 'ENABLED' || ttl?.TimeToLiveStatus === 'ENABLING') {
        if (ttl.AttributeName !== definition.ttlAttribute)
          throw new Error(`INCOMPATIBLE_TTL: ${definition.name}`);
      } else if (ttl?.TimeToLiveStatus === 'DISABLING') {
        throw new Error(
          `TTL_TRANSITION_PENDING: ${definition.name}; retry after TTL disable completes`,
        );
      } else {
        await client.send(
          new UpdateTimeToLiveCommand({
            TableName: definition.name,
            TimeToLiveSpecification: { AttributeName: definition.ttlAttribute, Enabled: true },
          }),
          { abortSignal: signal },
        );
      }
    } else if (ttl?.TimeToLiveStatus && ttl.TimeToLiveStatus !== 'DISABLED') {
      throw new Error(
        `INCOMPATIBLE_TTL: ${definition.name}; no TTL is expected on this foundation table`,
      );
    }
  }

  return { tables: definitions.map((table) => table.name) };
}
