import { describe, expect, it } from 'vitest';
import OpenAI from 'openai';
import { HttpError } from '../errors.js';
import { diagnosticEndpoint, errorDiagnostics, sanitizeDiagnostics } from './diagnostics.js';

describe('safe failure diagnostics', () => {
  it('keeps provider details and causes while redacting credentials', () => {
    const secret = 'private-provider-credential';
    const provider = new OpenAI.APIError(400, { code: 'unsupported_parameter', type: 'invalid_request_error',
      param: 'max_tokens', message: `Cannot accept max_tokens: ${secret}` }, 'request rejected', new Headers({ 'x-request-id': 'req-test' }));
    const failure = new HttpError(502, 'MODEL_INCOMPATIBLE', 'The endpoint rejected the request.', { cause: provider,
      diagnostics: { stage: 'request', model: 'model-test', apiKey: secret } });
    const details = errorDiagnostics(failure, [secret]);

    expect(details).toMatchObject({ code: 'MODEL_INCOMPATIBLE', diagnostics: { stage: 'request', apiKey: '[REDACTED]' },
      cause: { status: 400, requestID: 'req-test', providerError: { param: 'max_tokens', code: 'unsupported_parameter' } } });
    expect(JSON.stringify(details)).not.toContain(secret);
  });

  it('redacts nested credentials and credentials in messages', () => {
    const result = sanitizeDiagnostics({ authorization: 'Bearer abc', nested: { password: 'hidden', cookie: 'session=hidden' },
      message: 'postgres://user:pass@localhost/db Bearer abcdef api_key=hidden sk-proj-1234567890' });
    const text = JSON.stringify(result);

    expect(text).not.toContain('user:pass');
    expect(text).not.toContain('abcdef');
    expect(text).not.toContain('hidden');
    expect(text).not.toContain('sk-proj-');
  });

  it('omits private reasoning but retains configured effort and token counts', () => {
    const result = sanitizeDiagnostics({ reasoning_content: 'private reasoning', reasoningEffort: 'none',
      reasoning_tokens: 12, lastChunk: { content: '<think>private details</think>Public answer' } });

    expect(result).toEqual({ reasoning_content: '[OMITTED]', reasoningEffort: 'none', reasoning_tokens: 12,
      lastChunk: { content: '[OMITTED_REASONING]Public answer' } });
  });

  it('handles cyclic causes and bounds diagnostic values', () => {
    const failure = new Error('Failure', { cause: undefined });
    failure.cause = failure;

    expect(JSON.stringify(errorDiagnostics(failure))).toContain('TRUNCATED CAUSE');
    expect(sanitizeDiagnostics('x'.repeat(10000))).toHaveLength(8192);
  });

  it('keeps only endpoint origin and path', () => {
    expect(diagnosticEndpoint('https://user:password@model.test/v1?api_key=secret#token'))
      .toBe('https://model.test/v1');
  });
});
