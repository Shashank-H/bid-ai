import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { z } from 'zod';

export const TablePrefixSchema = z
  .string()
  .regex(/^bid(?:-[a-z0-9]+)*$/)
  .max(100);

/** Local-only by design: never allow SDK defaults to route commands to AWS. */
export function localEndpoint(value: string): string {
  const url = new URL(value);

  if (
    url.protocol !== 'http:' ||
    !['localhost', '127.0.0.1', '[::1]', 'dynamodb'].includes(url.hostname) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== '/'
  ) {
    throw new Error('DYNAMODB_ENDPOINT must be an HTTP loopback or Compose dynamodb endpoint');
  }

  return url.href;
}

export interface DatabaseSettings {
  endpoint: string;
  tablePrefix: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
}

export function createDatabaseClient(settings: DatabaseSettings): DynamoDBClient {
  return new DynamoDBClient({
    endpoint: localEndpoint(settings.endpoint),
    region: settings.region,
    credentials: { accessKeyId: settings.accessKeyId, secretAccessKey: settings.secretAccessKey },
    maxAttempts: 2,
    requestHandler: { connectionTimeout: 1000, requestTimeout: 2500 },
  });
}
