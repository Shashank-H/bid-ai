import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { IdSchema } from '@bid/shared';

const ClaimsSchema = z.strictObject({
  v: z.literal(1), userId: IdSchema, issuedAt: z.number().int().nonnegative(),
  expiresAt: z.number().int().positive(), nonce: z.string().regex(/^[a-f0-9]{32}$/),
});

export interface AuthSettings {
  secret: string;
  cookieName: string;
  lifetimeSeconds: number;
  secure: boolean;
  origin: string;
}

export function issueToken(userId: string, settings: AuthSettings, now = Date.now()): string {
  const seconds = Math.floor(now / 1000);
  const payload = Buffer.from(JSON.stringify(ClaimsSchema.parse({ v: 1, userId,
    issuedAt: seconds, expiresAt: seconds + settings.lifetimeSeconds, nonce: randomBytes(16).toString('hex') }))).toString('base64url');

  return `${payload}.${createHmac('sha256', settings.secret).update(payload).digest('base64url')}`;
}

export function verifyToken(token: string, settings: AuthSettings, now = Date.now()) {
  if (token.length > 1024 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/.test(token)) return null;

  const [payload, signature] = token.split('.') as [string, string];
  const expected = createHmac('sha256', settings.secret).update(payload).digest();
  const supplied = Buffer.from(signature, 'base64url');

  if (supplied.length !== expected.length || supplied.toString('base64url') !== signature
    || !timingSafeEqual(expected, supplied)) return null;

  try {
    const decoded = Buffer.from(payload, 'base64url');
    if (decoded.toString('base64url') !== payload) return null;

    const claims = ClaimsSchema.parse(JSON.parse(decoded.toString('utf8')));
    const seconds = Math.floor(now / 1000);

    return claims.expiresAt > seconds && claims.issuedAt <= seconds + 30
      && claims.expiresAt > claims.issuedAt && claims.expiresAt - claims.issuedAt <= settings.lifetimeSeconds
      ? claims : null;
  } catch {
    return null;
  }
}

export function authCookie(token: string, settings: AuthSettings, clear = false): string {
  return `${settings.cookieName}=${clear ? '' : token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${clear ? 0 : settings.lifetimeSeconds}${settings.secure ? '; Secure' : ''}`;
}

export function cookieToken(header: string | undefined, name: string): string | null {
  const matches = (header ?? '').split(';').map((part) => part.trim()).filter((part) => part.startsWith(`${name}=`));

  return matches.length === 1 ? matches[0]!.slice(name.length + 1) : null;
}
