import { createDatabaseClient } from '../db/client.js';
import { databaseSettingsFromEnvironment, readEnvironment } from '../env.js';

export { databaseSettingsFromEnvironment } from '../env.js';

import { initializeDatabase } from '../db/initialize.js';
import { resetDatabase } from '../db/reset.js';
import { newVerificationToken, persistenceRecord, verifyDatabase } from '../db/verify.js';

export function parseOptions(args: readonly string[], allowed: readonly string[]): Record<string, string> {
  const options: Record<string, string> = {};

  for (let i = 0; i < args.length; i += 2) {
    const key = args[i];
    const value = args[i + 1];

    if (!key || !allowed.includes(key) || !value || value.startsWith('--') || options[key] !== undefined) {
      throw new Error('INVALID_ARGUMENTS: unknown, missing or duplicate option');
    }

    options[key] = value;
  }

  return options;
}

export async function executeDatabaseCommand(command: string, args: readonly string[], env: NodeJS.ProcessEnv): Promise<unknown> {
  readEnvironment(env);
  const settings = databaseSettingsFromEnvironment(env);

  // Validate destructive command arguments before creating a client or issuing any request.
  const options = parseOptions(args, command === 'db:reset'
    ? ['--endpoint', '--prefix', '--confirm']
    : command === 'db:verify' ? ['--record', '--token'] : []);

  if (command === 'db:reset' && (!options['--endpoint'] || !options['--prefix'] || !options['--confirm'])) {
    throw new Error('RESET_REFUSED: --endpoint, --prefix and --confirm are all required');
  }

  const client = createDatabaseClient(settings);

  try {
    if (command === 'db:init') return await initializeDatabase(client, settings.tablePrefix);
    if (command === 'db:reset') return await resetDatabase(client, settings, {
      endpoint: options['--endpoint']!, prefix: options['--prefix']!, confirmation: options['--confirm']!,
    });

    if (command === 'db:verify') {
      const action = options['--record'];

      if (action === undefined) {
        if (options['--token']) throw new Error('INVALID_ARGUMENTS: --token requires --record');
        return await verifyDatabase(client, settings.tablePrefix);
      }

      if (!['write', 'read', 'delete'].includes(action)) throw new Error('INVALID_ARGUMENTS: --record must be write, read or delete');
      const token = options['--token'] ?? (action === 'write' ? newVerificationToken() : undefined);
      if (!token) throw new Error('INVALID_ARGUMENTS: --token is required for read/delete');

      return await persistenceRecord(client, settings.tablePrefix, action as 'write' | 'read' | 'delete', token);
    }

    throw new Error('INVALID_ARGUMENTS: unknown database command');
  } finally {
    client.destroy();
  }
}
