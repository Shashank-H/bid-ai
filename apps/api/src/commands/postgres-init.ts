import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { PostgresSaver } from '@langchain/langgraph-checkpoint-postgres';
import { fileURLToPath } from 'node:url';
import { createPostgres, postgresUrl } from '../db/postgres.js';

export async function initializePostgres(env: NodeJS.ProcessEnv): Promise<{ initialized: true }> {
  const postgres = createPostgres(postgresUrl(env));
  const saver = new PostgresSaver(postgres.pool, undefined, { schema: 'agent_checkpoints' });

  try {
    // Serialize explicit initialization without locking across any model operations.
    const lock = await postgres.pool.connect();

    try {
      await lock.query("SELECT pg_advisory_lock(hashtext('bid-postgres-init'))");
      await migrate(postgres.db, {
        migrationsFolder: fileURLToPath(new URL('../db/migrations', import.meta.url)),
      });
      await saver.setup();
    } finally {
      await lock.query("SELECT pg_advisory_unlock(hashtext('bid-postgres-init'))");
      lock.release();
    }

    return { initialized: true };
  } finally {
    await postgres.pool.end();
  }
}
