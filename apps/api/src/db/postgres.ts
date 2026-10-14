import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { z } from 'zod';
import { ConfigurationError } from '../env.js';

export function postgresUrl(env: NodeJS.ProcessEnv): string {
  try {
    const value =
      env['DATABASE_URL'] ||
      `postgresql://bid:${encodeURIComponent(env['POSTGRES_PASSWORD'] || 'local-development-only')}@postgres:5432/bid`;
    const url = new URL(value);

    if (
      url.protocol !== 'postgresql:' ||
      !['postgres', 'localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ||
      !url.pathname.slice(1) ||
      url.search ||
      url.hash
    )
      throw new Error('Unsafe database URL');

    return z.string().max(4096).parse(value);
  } catch {
    throw new ConfigurationError();
  }
}

export function createPostgres(url: string) {
  const pool = new pg.Pool({
    connectionString: url,
    max: 10,
    connectionTimeoutMillis: 2500,
    idleTimeoutMillis: 10_000,
    statement_timeout: 5000,
    query_timeout: 6000,
  });
  pool.on('error', () => {
    /* Request boundaries report dependency failures without leaking connection credentials. */
  });

  return { pool, db: drizzle(pool) };
}

export type Postgres = ReturnType<typeof createPostgres>;
