import { DashboardQuerySchema } from '@bid/shared';
import type { FastifyInstance } from 'fastify';
import type { Authorization } from '../auth/authorization.js';
import type { Dashboard } from '../domain/dashboard.js';
import { HttpError } from '../errors.js';

export function registerAnalyticsRoutes(
  app: FastifyInstance,
  authorization: Authorization,
  dashboard: Dashboard,
) {
  app.post('/api/analytics/query', async (request) => {
    const auth = await authorization.resolve(request);
    const parsed = DashboardQuerySchema.safeParse(request.body);

    if (!parsed.success) {
      throw new HttpError(
        400,
        'INVALID_INPUT',
        'Choose a supported metric and up to 90 UTC dates per period.',
      );
    }

    return dashboard.query(
      {
        identity: auth.identity,
        correlationId: request.id,
        signal: AbortSignal.timeout(10_000),
      },
      parsed.data,
    );
  });
}
