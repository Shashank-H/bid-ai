import type { SafeError } from '@bid/shared';

export class HttpError extends Error {
  readonly diagnostics: Record<string, unknown> | undefined;

  constructor(readonly status: number, readonly code: SafeError['code'], message: string,
    options?: ErrorOptions & { diagnostics?: Record<string, unknown> }) {
    super(message, options);
    this.diagnostics = options?.diagnostics;
  }
}

export function unauthorized(): never {
  throw new HttpError(401, 'UNAUTHORIZED', 'Please log in again.');
}

export function notFound(): never {
  throw new HttpError(404, 'NOT_FOUND', 'The conversation was not found.');
}
