import type { FastifyRequest } from 'fastify';
import type { PublicUser } from '@bid/shared';
import type { UserPublisherContext, UserRepository } from '../domain/interfaces.js';
import { unauthorized } from '../errors.js';
import { cookieToken, verifyToken } from './token.js';
import type { AuthSettings } from './token.js';

export interface AuthorizedRequest {
  identity: UserPublisherContext;
  user: PublicUser;
  expiresAt: number;
}

export class Authorization {
  constructor(readonly users: UserRepository, readonly settings: () => AuthSettings) {}

  async resolve(request: Pick<FastifyRequest, 'headers'>): Promise<AuthorizedRequest> {
    const settings = this.settings();
    const token = cookieToken(request.headers.cookie, settings.cookieName);
    const claims = token ? verifyToken(token, settings) : null;

    if (!claims) unauthorized();

    return this.resolveUser(claims.userId, claims.expiresAt);
  }

  async resolveUser(userId: string, expiresAt: number): Promise<AuthorizedRequest> {
    if (expiresAt <= Math.floor(Date.now() / 1000)) unauthorized();

    const user = await this.users.findById(userId);
    const memberships = user && !user.disabled ? await this.users.memberships(userId) : [];

    // Phase 1 has exactly one publisher per development user, not a selector.
    if (!user || user.disabled || memberships.length !== 1) unauthorized();

    const identity = { userId, publisherId: memberships[0]!.publisherId } as UserPublisherContext;

    return { identity, user: { userId: user.userId, login: user.login }, expiresAt };
  }
}
