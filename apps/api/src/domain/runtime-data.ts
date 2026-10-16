import type { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import type { PublisherDatasetMetadata } from '@bid/shared';
import { PublisherDataRepository } from '../db/publisher-data.js';
import {
  DynamoConfigurationManagementRepository,
  MemoryConfigurationManagementRepository,
} from '../db/configuration-management.js';
import {
  fixtureMetadata,
  fixtureAnalytics,
  fixtureConfiguration,
  publisherFixture,
} from '../fixtures/publishers.js';
import { Dashboard } from './dashboard.js';
import {
  ConfigurationManagement,
  PublishedConfigurationRepository,
  configurationSeeds,
} from './configuration-management.js';
import { createReadOnlyTools, toolsForModel } from '../tools/registry.js';
import { createConfigurationTools } from '../tools/configurations.js';
import { createToolDispatcher } from '../tools/dispatch.js';
import type { ToolDispatcher } from '../tools/dispatch.js';
import type { ConfigurationRepository, DatasetRepository, ExecutionContext } from './interfaces.js';

export type DatasetMetadataProvider = DatasetRepository['getPublicMetadata'];

export interface RuntimeDataDependencies {
  dispatchTool: ToolDispatcher;
  modelTools: ReturnType<typeof toolsForModel>;
  getMetadata: DatasetMetadataProvider;
  dashboard: Dashboard;
  configurations: ConfigurationManagement;
  configurationRepository: ConfigurationRepository;
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
    const seeds = configurationSeeds(async (context) => {
      if (!(await repository.getDataset(context))) return [];

      return repository.readHistory(context.identity.publisherId, undefined, context.signal);
    });
    const configurations = new ConfigurationManagement(
      new DynamoConfigurationManagementRepository(client, prefix, seeds),
    );
    const configurationRepository = new PublishedConfigurationRepository(
      configurations,
      repository,
    );
    const tools = [
      ...createReadOnlyTools(repository, configurationRepository),
      ...createConfigurationTools(configurations),
    ];

    return {
      dispatchTool: createToolDispatcher(tools),
      modelTools: toolsForModel(tools),
      dashboard: new Dashboard(repository),
      getMetadata: (context) => repository.getPublicMetadata(context),
      configurations,
      configurationRepository,
    };
  }

  const seeds = configurationSeeds(async (context) => {
    context.signal.throwIfAborted();

    return publisherFixture(context.identity.publisherId).history;
  });
  const configurations = new ConfigurationManagement(
    new MemoryConfigurationManagementRepository(seeds),
  );
  const configurationRepository = new PublishedConfigurationRepository(
    configurations,
    fixtureConfiguration,
  );
  const tools = [
    ...createReadOnlyTools(fixtureAnalytics, configurationRepository),
    ...createConfigurationTools(configurations),
  ];

  return {
    dispatchTool: createToolDispatcher(tools),
    modelTools: toolsForModel(tools),
    dashboard: new Dashboard(fixtureAnalytics),
    getMetadata: fixtureDatasetMetadata,
    configurations,
    configurationRepository,
  };
}
