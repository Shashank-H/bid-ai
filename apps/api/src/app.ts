import Fastify from 'fastify';
import { registerHealthRoutes } from './routes/health.js';
import type { HealthDependencies } from './routes/health.js';
import { registerAuthRoutes } from './routes/auth.js';
import type { Authorization } from './auth/authorization.js';
import { HttpError } from './errors.js';
import { ConfigurationError } from './env.js';
import { registerConversationRoutes } from './routes/conversations.js';
import type { AgentService } from './agent/service.js';
import { errorDiagnostics } from './observability/diagnostics.js';

export interface ProductDependencies {
  authorization: Authorization;
  cancelUser?: (userId: string) => void;
  agent?: AgentService;
}

export function buildApp(
  dependencies: HealthDependencies,
  logging = false,
  product?: ProductDependencies,
) {
  const app = Fastify({
    logger: logging
      ? { redact: ['req.headers.authorization', 'req.headers.cookie', 'res.headers["set-cookie"]'] }
      : false,
    disableRequestLogging: true,
    requestTimeout: 10_000,
    bodyLimit: 65_536,
  });

  registerHealthRoutes(app, dependencies);
  if (product) {
    app.addHook('preHandler', async (request, reply) => {
      reply.header('Cache-Control', 'no-store');

      if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method)) {
        if (
          request.headers.origin !== product.authorization.settings().origin ||
          request.headers['sec-fetch-site'] === 'cross-site'
        ) {
          throw new HttpError(403, 'UNAUTHORIZED', 'A same-origin request is required.');
        }

        if (!/^application\/json(?:\s*;|$)/i.test(request.headers['content-type'] ?? '')) {
          throw new HttpError(415, 'INVALID_INPUT', 'A JSON request is required.');
        }
      }
    });

    registerAuthRoutes(app, product.authorization, product.cancelUser);
    if (product.agent) registerConversationRoutes(app, product.authorization, product.agent);
  }

  app.setErrorHandler((error, request, reply) => {
    if (!(error instanceof HttpError) || error.status >= 500) {
      request.log.error(
        {
          event: 'http_request_failed',
          requestId: request.id,
          method: request.method,
          path: request.url.split('?')[0],
          error: errorDiagnostics(error, [
            process.env['LLM_API_KEY'] ?? '',
            process.env['LANGFUSE_SECRET_KEY'] ?? '',
          ]),
        },
        'Request failed',
      );
    }

    if (error instanceof HttpError) {
      void reply.code(error.status).send({ code: error.code, message: error.message });
    } else if (error instanceof ConfigurationError) {
      void reply
        .code(503)
        .send({ code: 'DEPENDENCY_UNAVAILABLE', message: 'Server settings are not configured.' });
    } else if (
      error instanceof Error &&
      'statusCode' in error &&
      (error.statusCode === 400 || error.statusCode === 413 || error.statusCode === 415)
    ) {
      void reply
        .code(error.statusCode)
        .send({ code: 'INVALID_INPUT', message: 'The request is invalid or too large.' });
    } else {
      void reply
        .code(500)
        .send({ code: 'INTERNAL_ERROR', message: 'The request could not be completed.' });
    }
  });

  return app;
}
