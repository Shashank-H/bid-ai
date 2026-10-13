import { z } from 'zod';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { StreamEventSchema } from '@bid/shared';
import type { StreamEvent } from '@bid/shared';
import type { Authorization } from '../auth/authorization.js';
import type { AgentService } from '../agent/service.js';
import { HttpError } from '../errors.js';

const Ids = z.object({ id: z.uuid(), turnId: z.uuid().optional() });
const Pagination = z.strictObject({ cursor: z.uuid().optional() });
const NewTurn = z.strictObject({ requestId: z.uuid(), message: z.string().trim().min(1).max(8192)
  .refine((text) => Buffer.byteLength(text) <= 8192) });

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);

  if (!result.success) throw new HttpError(400, 'INVALID_INPUT', 'The request does not match the allowed schema.');

  return result.data;
}

export function registerConversationRoutes(app: FastifyInstance, authorization: Authorization, service: AgentService) {
  app.post('/api/conversations', async (request) => {
    parse(z.strictObject({}), request.body);
    const auth = await authorization.resolve(request);

    return service.conversations.create(auth.identity);
  });

  app.get('/api/conversations', async (request) => {
    const query = parse(Pagination, request.query);
    const auth = await authorization.resolve(request);

    return service.conversations.list(auth.identity, query.cursor);
  });

  app.get('/api/conversations/:id', async (request) => {
    const { id } = parse(Ids, request.params);
    const query = parse(Pagination, request.query);
    const auth = await authorization.resolve(request);

    return service.conversations.detail(auth.identity, id, query.cursor);
  });

  async function stream(request: FastifyRequest, reply: FastifyReply, resume: boolean) {
    const { id, turnId } = parse(Ids, request.params);
    const auth = await authorization.resolve(request);
    const input = resume ? (parse(z.strictObject({}), request.body), { resumeId: turnId! }) : parse(NewTurn, request.body);
    const accepted = await service.prepare(auth, id, input);

    if (accepted.duplicate) return reply.code(200).send({ duplicate: true, turnId: accepted.turn.id, status: accepted.turn.status });

    const controller = new AbortController();
    const disconnected = () => controller.abort('DISCONNECT');
    reply.raw.on('close', disconnected);
    reply.hijack();
    reply.raw.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' });
    const heartbeat = setInterval(() => { if (!reply.raw.destroyed) reply.raw.write(': heartbeat\n\n'); }, 5000);
    const emit = (event: StreamEvent) => {
      const payload = StreamEventSchema.parse(event);
      if (!reply.raw.destroyed) reply.raw.write(`data: ${JSON.stringify(payload)}\n\n`);
    };

    try {
      await service.run(auth, accepted, resume, controller, emit);
    } finally {
      clearInterval(heartbeat);
      reply.raw.off('close', disconnected);
      if (!reply.raw.destroyed) reply.raw.end();
    }
  }

  app.post('/api/conversations/:id/turns/:turnId/cancel', async (request) => {
    const { id, turnId } = parse(Ids, request.params);
    parse(z.strictObject({}), request.body);
    const auth = await authorization.resolve(request);

    return service.cancel(auth.identity, id, turnId!);
  });

  app.post('/api/conversations/:id/turns', (request, reply) => stream(request, reply, false));
  app.post('/api/conversations/:id/turns/:turnId/resume', (request, reply) => stream(request, reply, true));
}
