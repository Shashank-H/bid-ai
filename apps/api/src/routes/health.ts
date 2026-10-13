import type { FastifyInstance } from 'fastify';

export interface HealthDependencies {
  checkReady: () => Promise<boolean>
}

export function registerHealthRoutes(app: FastifyInstance, dependencies: HealthDependencies): void {
  app.get('/api/health/live', async () => ({ status: 'alive' }));

  app.get('/api/health/ready', async (_request, reply) => {
    let ready = false;

    try {
      ready = await dependencies.checkReady();
    } catch {
      /* Never expose SDK/configuration details. */
    }

    return reply.code(ready ? 200 : 503).send({ status: ready ? 'ready' : 'unavailable' });
  });
}
