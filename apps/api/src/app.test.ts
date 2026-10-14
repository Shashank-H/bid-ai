import { expect, it } from 'vitest';
import { buildApp } from './app.js';

it('keeps liveness independent from unavailable readiness and recovers on the next check', async () => {
  let ready = false;
  const app = buildApp({ checkReady: async () => ready });

  try {
    expect((await app.inject('/api/health/live')).json()).toEqual({ status: 'alive' });
    expect((await app.inject('/api/health/ready')).statusCode).toBe(503);

    ready = true;

    expect((await app.inject('/api/health/ready')).json()).toEqual({ status: 'ready' });
  } finally {
    await app.close();
  }
});

it('does not expose dependency error details in public responses', async () => {
  const app = buildApp({
    checkReady: async () => {
      throw new Error('private-key-secret-sentinel');
    },
  });

  try {
    const result = await app.inject('/api/health/ready');

    expect(result.statusCode).toBe(503);
    expect(result.json()).toEqual({ status: 'unavailable' });
    expect(result.body).not.toContain('private-key-secret-sentinel');
  } finally {
    await app.close();
  }
});
