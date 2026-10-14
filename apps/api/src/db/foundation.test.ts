import { describe, expect, it } from 'vitest';
import { localEndpoint } from './client.js';
import type { DatabaseSettings } from './client.js';
import { assertResetAllowed } from './reset.js';
import { tableDefinitions } from './tables.js';
import { parseOptions } from '../commands/database.js';

const settings: DatabaseSettings = {
  endpoint: 'http://localhost:8000',
  tablePrefix: 'bid-test-safety',
  region: 'local',
  accessKeyId: 'local',
  secretAccessKey: 'local',
};

describe('local database safeguards', () => {
  it('rejects cloud, remote and credential-bearing endpoints', () => {
    expect(localEndpoint('http://dynamodb:8000')).toBe('http://dynamodb:8000/');
    expect(localEndpoint('http://127.0.0.1:8000')).toBe('http://127.0.0.1:8000/');

    for (const endpoint of [
      'https://dynamodb.us-east-1.amazonaws.com',
      'http://evil.example:8000',
      'http://user:secret@localhost:8000',
      'http://localhost:8000/other',
    ]) {
      expect(() => localEndpoint(endpoint)).toThrow();
    }
  });

  it('resets only the explicitly matched local project prefix', () => {
    const options = {
      endpoint: settings.endpoint,
      prefix: settings.tablePrefix,
      confirmation: `DELETE ${settings.tablePrefix}`,
    };

    expect(() => assertResetAllowed(settings, options)).not.toThrow();
    expect(() => assertResetAllowed(settings, { ...options, prefix: 'bid-foreign' })).toThrow(
      'RESET_REFUSED',
    );
    expect(() => assertResetAllowed(settings, { ...options, confirmation: '' })).toThrow(
      'RESET_REFUSED',
    );
    expect(() =>
      assertResetAllowed(settings, { ...options, endpoint: 'http://localhost:8001' }),
    ).toThrow('RESET_REFUSED');
    expect(() => tableDefinitions('foreign')).toThrow();
  });

  it('rejects ambiguous or unknown command options', () => {
    expect(parseOptions(['--record', 'read'], ['--record'])).toEqual({ '--record': 'read' });
    expect(() => parseOptions(['--record'], ['--record'])).toThrow();
    expect(() => parseOptions(['--record', 'read', '--record', 'write'], ['--record'])).toThrow();
    expect(() => parseOptions(['--unknown', 'value'], [])).toThrow();
  });
});
