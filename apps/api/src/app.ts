import Fastify from 'fastify';
import { registerHealthRoutes } from './routes/health.js';
import type { HealthDependencies } from './routes/health.js';

export function buildApp(dependencies: HealthDependencies, logging = false) {
  const app = Fastify({
    logger: logging ? { redact: ['req.headers.authorization', 'req.headers.cookie', 'res.headers["set-cookie"]'] } : false,
    disableRequestLogging: true,
    requestTimeout: 10_000,
    bodyLimit: 65_536,
  });

  registerHealthRoutes(app, dependencies);
  app.setErrorHandler((_error, _request, reply) => {
    void reply.code(500).send({ code: 'INTERNAL_ERROR', message: 'The request could not be completed.' });
  });

  return app;
}
