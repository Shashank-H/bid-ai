import type { FastifyInstance } from 'fastify';
import { HttpError, unauthorized } from '../errors.js';
import { hashPassword, LoginInputSchema, verifyPassword } from '../auth/credentials.js';
import { authCookie, issueToken } from '../auth/token.js';
import type { Authorization } from '../auth/authorization.js';
import { fixtureMetadata } from '../fixtures/publishers.js';

export function registerAuthRoutes(app: FastifyInstance, authorization: Authorization,
  cancelUser: (userId: string) => void = () => {}) {
  const attempts = new Map<string, { count: number; until: number }>();
  const dummyHash = hashPassword('unused-timing-equalization-password');

  app.post('/api/auth/login', async (request, reply) => {
    const input = LoginInputSchema.safeParse(request.body);

    if (!input.success) throw new HttpError(400, 'INVALID_INPUT', 'Provide a valid login and password (12–256 characters).');

    const now = Date.now();
    const previous = attempts.get(request.ip);
    const entry = previous && previous.until > now ? previous : { count: 0, until: now + 60_000 };

    if (entry.count >= 10) throw new HttpError(429, 'RATE_LIMITED', 'Too many login attempts. Try again in a minute.');

    entry.count++;
    if (attempts.size >= 1000 && !attempts.has(request.ip)) {
      for (const [key, value] of attempts) if (value.until <= now) attempts.delete(key);
      if (attempts.size >= 1000) throw new HttpError(429, 'RATE_LIMITED', 'Login is busy. Try again in a minute.');
    }
    attempts.set(request.ip, entry);

    const user = await authorization.users.findByLogin(input.data.login);
    const valid = await verifyPassword(user?.credentialHash ?? await dummyHash, input.data.password);

    if (!user || user.disabled || !valid) unauthorized();

    const settings = authorization.settings();
    const resolved = await authorization.resolveUser(user.userId, Math.floor(now / 1000) + settings.lifetimeSeconds);
    reply.header('Set-Cookie', authCookie(issueToken(user.userId, settings), settings));
    reply.header('Cache-Control', 'no-store');

    return { user: resolved.user, publisherId: resolved.identity.publisherId, ...fixtureMetadata(resolved.identity.publisherId) };
  });

  app.post('/api/auth/logout', async (request, reply) => {
    const settings = authorization.settings();

    try {
      const resolved = await authorization.resolve(request);
      cancelUser(resolved.identity.userId);
    } catch (error) {
      if (!(error instanceof HttpError) || error.status !== 401) throw error;
    }

    reply.header('Set-Cookie', authCookie('', settings, true));
    reply.header('Cache-Control', 'no-store');

    return { loggedOut: true };
  });

  app.get('/api/auth/me', async (request, reply) => {
    const resolved = await authorization.resolve(request);
    reply.header('Cache-Control', 'no-store');

    return { user: resolved.user, publisherId: resolved.identity.publisherId, ...fixtureMetadata(resolved.identity.publisherId) };
  });
}
