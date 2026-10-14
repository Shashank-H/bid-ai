const sensitiveKey = /authorization|cookie|password|secret|api[-_]?key|access[-_]?token|refresh[-_]?token/i;
const privateReasoning = /^(reasoning|reasoning_content|reasoning_details|analysis|thoughts?|thinking)$/i;

export function sanitizeDiagnostics(value: unknown, secrets: string[] = [], depth = 0): unknown {
  if (depth > 8) return '[TRUNCATED]';

  if (typeof value === 'string') {
    let text = value;
    for (const secret of secrets.filter(Boolean)) text = text.replaceAll(secret, '[REDACTED]');

    return text.replace(/<(think|thinking|analysis|reasoning)\b[^>]*>[\s\S]*?(?:<\/\1\s*>|$)/gi, '[OMITTED_REASONING]')
      .replace(/([a-z][a-z0-9+.-]*:\/\/)[^/\s@]+@/gi, '$1[REDACTED]@')
      .replace(/\bBearer\s+[^\s"',;]+/gi, 'Bearer [REDACTED]')
      .replace(/\b(?:sk|pk)-(?:[A-Za-z0-9_-]{8,})/g, '[REDACTED]')
      .replace(/((?:api[-_]?key|password|secret|authorization|cookie)\s*[=:]\s*)[^\s,;]+/gi, '$1[REDACTED]')
      .slice(0, 8192);
  }

  if (Array.isArray(value)) return value.slice(0, 30).map((item) => sanitizeDiagnostics(item, secrets, depth + 1));

  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).slice(0, 50).map(([key, item]) => [key,
      sensitiveKey.test(key) ? '[REDACTED]' : privateReasoning.test(key) ? '[OMITTED]' : sanitizeDiagnostics(item, secrets, depth + 1)]));
  }

  return value;
}

export function errorDiagnostics(error: unknown, secrets: string[] = []): Record<string, unknown> {
  const seen = new Set<unknown>();
  const describe = (value: unknown, depth: number): Record<string, unknown> => {
    if (!value || typeof value !== 'object') return { message: String(value) };
    if (seen.has(value) || depth > 4) return { message: '[TRUNCATED CAUSE]' };
    seen.add(value);

    const source = value as Record<string, unknown>;
    const details: Record<string, unknown> = {};
    for (const key of ['name', 'message', 'stack', 'code', 'status', 'statusCode', 'type', 'param', 'request_id', 'requestID', 'diagnostics']) {
      if (source[key] !== undefined) details[key] = source[key];
    }

    // OpenAI APIError.error carries the provider's structured error, not request headers.
    if (source['error'] && typeof source['error'] === 'object') {
      const provider = source['error'] as Record<string, unknown>;
      details['providerError'] = Object.fromEntries(['code', 'type', 'param', 'message']
        .filter((key) => provider[key] !== undefined).map((key) => [key, provider[key]]));
    }

    if (source['cause'] !== undefined) details['cause'] = describe(source['cause'], depth + 1);

    return details;
  };

  return sanitizeDiagnostics(describe(error, 0), secrets) as Record<string, unknown>;
}

export function reportFailure(event: string, fields: Record<string, unknown>, error: unknown, secrets: string[] = []): void {
  console.error(JSON.stringify({ level: 'error', time: new Date().toISOString(), event,
    ...sanitizeDiagnostics(fields, secrets) as Record<string, unknown>, error: errorDiagnostics(error, secrets) }));
}

export function diagnosticEndpoint(baseURL: string): string {
  const url = new URL(baseURL);

  return `${url.origin}${url.pathname}`;
}
