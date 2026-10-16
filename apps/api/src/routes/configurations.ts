import { z } from 'zod';
import {
  ConfigurationVersionPageInputSchema,
  DecideConfigurationDraftSchema,
  PublishConfigurationDraftSchema,
  SaveConfigurationDraftSchema,
  TimestampSchema,
} from '@bid/shared';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Authorization } from '../auth/authorization.js';
import type { ConfigurationManagement } from '../domain/configuration-management.js';
import type { ExecutionContext } from '../domain/interfaces.js';
import { HttpError } from '../errors.js';

const PageQuery = ConfigurationVersionPageInputSchema.extend({
  limit: z.coerce.number().int().min(1).max(25).optional(),
});
const VersionParams = z.strictObject({ versionId: TimestampSchema });
const EmptyQuery = z.strictObject({});

function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const parsed = schema.safeParse(input);

  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const location = issue?.path.map(String).join('.') || 'request';

    throw new HttpError(
      400,
      'INVALID_INPUT',
      `Invalid ${location}: ${issue?.message ?? 'unsupported value'}`.slice(0, 500),
    );
  }

  return parsed.data;
}

export function registerConfigurationRoutes(
  app: FastifyInstance,
  authorization: Authorization,
  service: ConfigurationManagement,
) {
  async function context(request: FastifyRequest): Promise<ExecutionContext> {
    const auth = await authorization.resolve(request);

    return {
      identity: auth.identity,
      correlationId: request.id,
      signal: AbortSignal.timeout(10_000),
    };
  }

  app.get('/api/configurations/workspace', async (request) => {
    const execution = await context(request);
    parse(EmptyQuery, request.query);

    return service.workspace(execution);
  });

  app.get('/api/configurations/versions', async (request) => {
    const execution = await context(request);
    const input = parse(PageQuery, request.query);

    return service.versions(execution, input);
  });

  app.get('/api/configurations/versions/:versionId', async (request) => {
    const execution = await context(request);
    const { versionId } = parse(VersionParams, request.params);
    parse(EmptyQuery, request.query);

    return service.version(execution, versionId);
  });

  app.put('/api/configurations/draft', async (request) => {
    const execution = await context(request);

    return service.save(execution, parse(SaveConfigurationDraftSchema, request.body));
  });

  app.post('/api/configurations/publish', async (request) => {
    const execution = await context(request);

    return service.publish(execution, parse(PublishConfigurationDraftSchema, request.body));
  });

  app.post('/api/configurations/proposal/decision', async (request) => {
    const execution = await context(request);

    return service.decide(execution, parse(DecideConfigurationDraftSchema, request.body));
  });
}
