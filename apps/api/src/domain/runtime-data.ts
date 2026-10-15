import type { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import type { PublisherDatasetMetadata } from '@bid/shared';
import { PublisherDataRepository } from '../db/publisher-data.js';
import { fixtureMetadata, fixtureAnalytics } from '../fixtures/publishers.js';
import { Dashboard } from './dashboard.js';
import { createReadOnlyTools } from '../tools/registry.js';
import { createToolDispatcher, dispatchTool } from '../tools/dispatch.js';
import type { ToolDispatcher } from '../tools/dispatch.js';
import type { DatasetRepository, ExecutionContext } from './interfaces.js';

export type DatasetMetadataProvider = DatasetRepository['getPublicMetadata'];

export interface RuntimeDataDependencies {
  dispatchTool: ToolDispatcher;
  getMetadata: DatasetMetadataProvider;
  dashboard: Dashboard;
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
      dashboard: new Dashboard(repository),
      getMetadata: (context) => repository.getPublicMetadata(context),
    };
  }

  return {
    dispatchTool,
    dashboard: new Dashboard(fixtureAnalytics),
    getMetadata: fixtureDatasetMetadata,
  };
}
