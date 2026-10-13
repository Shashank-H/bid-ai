import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { afterAll, describe, expect, it } from 'vitest';
import { createDatabaseClient, type DatabaseSettings } from '../../apps/api/src/db/client.js';
import { initializeDatabase } from '../../apps/api/src/db/initialize.js';
import { databaseReady } from '../../apps/api/src/db/readiness.js';
import { assertResetAllowed, resetDatabase } from '../../apps/api/src/db/reset.js';
import { provisionalAttributes, provisionalKeySchema, tableDefinitions } from '../../apps/api/src/db/tables.js';

// AWS is an API dependency, not a fourth workspace or root/browser dependency.
const require = createRequire(new URL('../../apps/api/package.json', import.meta.url));
const {
  CreateTableCommand, DeleteTableCommand, DescribeTableCommand, DescribeTimeToLiveCommand,
  GetItemCommand, PutItemCommand, ScanCommand, UpdateTimeToLiveCommand,
} = require('@aws-sdk/client-dynamodb');

const endpoint = process.env.DYNAMODB_ENDPOINT ?? 'http://dynamodb:8000';
const suiteId = randomUUID().replaceAll('-', '');
const ownedPrefixes = new Set<string>();

function settings(prefix: string): DatabaseSettings {
  return {
    endpoint, tablePrefix: prefix, region: process.env.AWS_REGION ?? 'local',
    accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? 'local',
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? 'local',
  };
}

function own(label: string) {
  const prefix = `bid-test-${suiteId}-${label}`;
  ownedPrefixes.add(prefix);

  return prefix;
}

const client = createDatabaseClient(settings(`bid-test-${suiteId}`));
const markerKey = { PK: { S: 'FOUNDATION#verification' }, SK: { S: 'RECORD' } };

async function putMarker(tableName: string) {
  await client.send(new PutItemCommand({ TableName: tableName, Item: {
    ...markerKey, value: { S: suiteId },
  }, ConditionExpression: 'attribute_not_exists(PK)' }));
}

async function getMarker(tableName: string) {
  return client.send(new GetItemCommand({ TableName: tableName, Key: markerKey, ConsistentRead: true }));
}

afterAll(async () => {
  // Never enumerate/delete foreign resources or use the demo TABLE_PREFIX.
  try {
    for (const prefix of ownedPrefixes) {
      if (!prefix.startsWith(`bid-test-${suiteId}-`)) throw new Error('Test cleanup ownership invariant failed');

      for (const table of tableDefinitions(prefix)) {
        try {
          await client.send(new DeleteTableCommand({ TableName: table.name }));
        } catch (error) {
          if (!(error instanceof Error && error.name === 'ResourceNotFoundException')) throw error;
        }
      }
    }
  } finally {
    client.destroy();
  }
});

describe('compiled foundation with real DynamoDB Local', () => {
  it('imports compiled ESM entry points rather than relying on TS path aliases', async () => {
    const compiledClient = await import('../../apps/api/dist/db/client.js');
    const compiledTables = await import('../../apps/api/dist/db/tables.js');

    expect(typeof compiledClient.createDatabaseClient).toBe('function');
    expect(compiledTables.tableDefinitions('bid-test-import').map((table: { name: string }) => table.name))
      .toEqual(['bid-test-import-identity', 'bid-test-import-publisher-data', 'bid-test-import-workflow']);
  });

  it('creates empty resources, configures session TTL, and leaves existing records unchanged on repeat init', async () => {
    const prefix = own('repeat');

    const initialized = await initializeDatabase(client, prefix);

    expect(initialized.tables).toEqual(tableDefinitions(prefix).map((table) => table.name));
    expect(await databaseReady(client, prefix)).toBe(true);

    for (const name of initialized.tables) {
      const table = await client.send(new DescribeTableCommand({ TableName: name }));

      expect(table.Table?.TableStatus).toBe('ACTIVE');
      expect(table.Table?.KeySchema).toEqual(provisionalKeySchema);

      const scan = await client.send(new ScanCommand({ TableName: name, Select: 'COUNT', ConsistentRead: true }));

      expect(scan.Count).toBe(0);
    }

    const identity = initialized.tables[0]!;
    const ttl = await client.send(new DescribeTimeToLiveCommand({ TableName: identity }));

    expect(ttl.TimeToLiveDescription?.AttributeName).toBe('expiresAt');
    expect(['ENABLED', 'ENABLING']).toContain(ttl.TimeToLiveDescription?.TimeToLiveStatus);

    await putMarker(identity);
    const before = await getMarker(identity);

    await initializeDatabase(client, prefix);

    expect((await getMarker(identity)).Item).toEqual(before.Item);
  });

  it('refuses incompatible existing keys without replacing the table or touching records', async () => {
    const prefix = own('schema');
    const identity = tableDefinitions(prefix)[0]!.name;

    await client.send(new CreateTableCommand({ TableName: identity, BillingMode: 'PAY_PER_REQUEST',
      KeySchema: [{ AttributeName: 'existingKey', KeyType: 'HASH' }],
      AttributeDefinitions: [{ AttributeName: 'existingKey', AttributeType: 'S' }],
    }));
    await client.send(new PutItemCommand({ TableName: identity, Item: { existingKey: { S: suiteId } } }));

    await expect(initializeDatabase(client, prefix)).rejects.toThrow('INCOMPATIBLE_SCHEMA');

    const table = await client.send(new DescribeTableCommand({ TableName: identity }));
    expect(table.Table?.KeySchema).toEqual([{ AttributeName: 'existingKey', KeyType: 'HASH' }]);

    const row = await client.send(new GetItemCommand({ TableName: identity, Key: { existingKey: { S: suiteId } }, ConsistentRead: true }));

    expect(row.Item).toEqual({ existingKey: { S: suiteId } });
  });

  it('refuses incompatible TTL without automatically changing its attribute', async () => {
    const prefix = own('ttl');
    const identity = tableDefinitions(prefix)[0]!.name;

    await client.send(new CreateTableCommand({ TableName: identity, BillingMode: 'PAY_PER_REQUEST',
      KeySchema: provisionalKeySchema, AttributeDefinitions: provisionalAttributes,
    }));
    await client.send(new UpdateTimeToLiveCommand({ TableName: identity,
      TimeToLiveSpecification: { AttributeName: 'foreignExpiry', Enabled: true },
    }));

    await expect(initializeDatabase(client, prefix)).rejects.toThrow('INCOMPATIBLE_TTL');

    const ttl = await client.send(new DescribeTimeToLiveCommand({ TableName: identity }));

    expect(ttl.TimeToLiveDescription?.AttributeName).toBe('foreignExpiry');
  });

  it('reports missing tables unavailable, then recovers after initialization', async () => {
    const prefix = own('readiness');

    expect(await databaseReady(client, prefix, 500)).toBe(false);

    await initializeDatabase(client, prefix);

    expect(await databaseReady(client, prefix, 2000)).toBe(true);
  });

  it('bounds unavailable-database readiness instead of hanging or leaking errors', async () => {
    const unreachable = createDatabaseClient({ ...settings(own('unavailable')), endpoint: 'http://127.0.0.1:1' });
    const started = performance.now();

    try {
      expect(await databaseReady(unreachable, 'bid-test-unavailable', 250)).toBe(false);
      expect(performance.now() - started).toBeLessThan(3000);
    } finally {
      unreachable.destroy();
    }
  });

  it('rejects unconfirmed, foreign-prefix, and cloud-endpoint resets without changing data', async () => {
    const prefix = own('guard');
    const configured = settings(prefix);

    await initializeDatabase(client, prefix);

    const table = tableDefinitions(prefix)[0]!.name;

    await putMarker(table);

    expect(() => assertResetAllowed(configured, { endpoint, prefix, confirmation: '' })).toThrow('RESET_REFUSED');
    expect(() => assertResetAllowed(configured, { endpoint, prefix: 'bid', confirmation: 'DELETE bid' })).toThrow('RESET_REFUSED');
    expect(() => assertResetAllowed(configured, { endpoint: 'https://dynamodb.us-east-1.amazonaws.com', prefix, confirmation: `DELETE ${prefix}` })).toThrow();
    expect((await getMarker(table)).Item?.value).toEqual({ S: suiteId });
  });

  it('confirmed reset recreates only its test-owned resources and preserves a different test prefix', async () => {
    const prefix = own('reset');
    const neighbor = own('neighbor');

    await initializeDatabase(client, prefix);
    await initializeDatabase(client, neighbor);

    const ownTable = tableDefinitions(prefix)[0]!.name;
    const neighborTable = tableDefinitions(neighbor)[0]!.name;

    await putMarker(ownTable);
    await putMarker(neighborTable);

    await resetDatabase(client, settings(prefix), { endpoint, prefix, confirmation: `DELETE ${prefix}` });

    expect(await databaseReady(client, prefix)).toBe(true);
    expect((await getMarker(ownTable)).Item).toBeUndefined();
    expect((await getMarker(neighborTable)).Item?.value).toEqual({ S: suiteId });
  });
});
