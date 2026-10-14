import { DuplicateTurnResponseSchema, SafeErrorSchema, StreamEventSchema } from '@bid/shared';
import type { StreamEvent } from '@bid/shared';

export function requestId(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();

  // Container/local HTTP aliases lack randomUUID; getRandomValues remains cryptographically secure.
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6]! & 15) | 64;
  bytes[8] = (bytes[8]! & 63) | 128;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');

  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

async function check(response: Response): Promise<void> {
  if (response.ok) return;

  const payload: unknown = await response.json().catch(() => null);
  const error = SafeErrorSchema.safeParse(payload);

  throw new ApiError(
    response.status,
    error.success ? error.data.message : 'The server is unavailable. Try again.',
  );
}

export async function api<T>(
  path: string,
  schema: { parse(value: unknown): T },
  body?: unknown,
): Promise<T> {
  const response = await fetch(path, {
    method: body === undefined ? 'GET' : 'POST',
    credentials: 'same-origin',
    cache: 'no-store',
    signal: AbortSignal.timeout(8000),
    ...(body === undefined
      ? {}
      : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
  });
  await check(response);

  return schema.parse(await response.json());
}

export async function streamTurn(
  path: string,
  conversationId: string,
  body: unknown,
  signal: AbortSignal,
  onEvent: (event: StreamEvent) => void,
): Promise<void> {
  const response = await fetch(path, {
    method: 'POST',
    credentials: 'same-origin',
    cache: 'no-store',
    signal,
    headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
    body: JSON.stringify(body),
  });
  await check(response);

  if (response.headers.get('content-type')?.includes('application/json')) {
    DuplicateTurnResponseSchema.parse(await response.json());
    return;
  }
  if (!response.headers.get('content-type')?.includes('text/event-stream') || !response.body)
    throw new Error('The server did not return a supported stream.');

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let terminal = false;

  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      buffer += decoder.decode(part.value, { stream: true });
      if (buffer.length > 131_072) throw new Error('The response frame limit was reached.');

      let boundary: number;
      while ((boundary = buffer.indexOf('\n\n')) !== -1) {
        const frame = buffer.slice(0, boundary).trim();
        buffer = buffer.slice(boundary + 2);
        if (frame.startsWith(':') || !frame) continue;
        if (!frame.startsWith('data: '))
          throw new Error('The server returned an invalid response frame.');

        const event = StreamEventSchema.parse(JSON.parse(frame.slice(6)));
        if (event.conversationId !== conversationId)
          throw new Error('The response conversation does not match.');
        if (['turn-complete', 'turn-error', 'turn-cancelled'].includes(event.type)) terminal = true;
        onEvent(event);
      }
    }

    if (!terminal)
      throw new Error('The stream disconnected. Reload the saved turn before resuming.');
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
