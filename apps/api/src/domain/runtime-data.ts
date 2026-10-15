import type { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import type { PublisherDatasetMetadata } from '@bid/shared';
import { PublisherDataRepository } from '../db/publisher-data.js';
import { fixtureMetadata } from '../fixtures/publishers.js';
import { createReadOnlyTools } from '../tools/registry.js';
import { createToolDispatcher, dispatchTool } from '../tools/dispatch.js';
import type { ToolDispatcher } from '../tools/dispatch.js';
import type { DatasetRepository, ExecutionContext } from './interfaces.js';

export type DatasetMetadataProvider = DatasetRepository['getPublicMetadata'];

export interface RuntimeDataDependencies {
  dispatchTool: ToolDispatcher;
  getMetadata: DatasetMetadataProvider;
}

export async function fixtureDatasetMetadata(
  context: ExecutionContext,
): Promise<PublisherDatasetMetadata> {
  context.signal.throwIfAborted();
  return fixtureMetadata(context.identity.publisherId);
}

/** Select once per application; database reads never fall back to fixtures. */
export function createRuntimeData(
  mode: 'fixture' | 'database',
  client: DynamoDBClient,
  prefix: string,
): RuntimeDataDependencies {
  if (mode === 'database') {
    const repository = new PublisherDataRepository(client, prefix);
    const tools = createReadOnlyTools(repository, repository);

    return {
      dispatchTool: createToolDispatcher(tools),
      getMetadata: (context) => repository.getPublicMetadata(context),
    };
  }

  return {
    dispatchTool,
    getMetadata: fixtureDatasetMetadata,
  };
}
