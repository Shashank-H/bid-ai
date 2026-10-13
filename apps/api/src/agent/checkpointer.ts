import { PostgresSaver } from '@langchain/langgraph-checkpoint-postgres';
import type pg from 'pg';

/** Official saver semantics, fenced only during short writes, never across model calls. */
export class FencedPostgresSaver extends PostgresSaver {
  constructor(pool: pg.Pool, private readonly fence: <T>(operation: () => Promise<T>) => Promise<T>) {
    super(pool, undefined, { schema: 'agent_checkpoints' });
  }

  override put(...args: Parameters<PostgresSaver['put']>): ReturnType<PostgresSaver['put']> {
    return this.fence(() => super.put(...args));
  }

  override putWrites(...args: Parameters<PostgresSaver['putWrites']>): ReturnType<PostgresSaver['putWrites']> {
    return this.fence(() => super.putWrites(...args));
  }
}
