import { resolveRequestId } from './request-id';

describe('resolveRequestId (NFR-09, FU-BE-12, FU-BE-95)', () => {
  const uuid = /^[0-9a-f-]{36}$/;

  it('NFR-09: keeps a well-formed inbound id', () => {
    expect(resolveRequestId('abc-12345_x.y', '/api/v1/health')).toBe('abc-12345_x.y');
  });

  it('FU-BE-12: replaces missing, short, long, array and unsafe ids', () => {
    for (const bad of [
      undefined,
      'short',
      'x'.repeat(65),
      ['a-long-enough-id'],
      'bad id 12345',
      'a\nb-12345678',
    ]) {
      expect(resolveRequestId(bad, '/api/v1/health')).toMatch(uuid);
    }
  });

  it('FU-BE-95: ignores the inbound id on /client-errors, case-insensitively', () => {
    for (const url of [
      '/api/v1/client-errors',
      '/api/v1/Client-Errors/',
      '/api/v1/client-errors?a=1',
    ]) {
      expect(resolveRequestId('victim-trace-0001', url)).toMatch(uuid);
    }
    // Absolute-form request target still routes to /client-errors.
    for (const url of [
      'http://host/api/v1/client-errors',
      'https://host:8443/API/v1/Client-Errors?x=1',
    ]) {
      expect(resolveRequestId('victim-trace-0001', url)).toMatch(uuid);
    }
    expect(resolveRequestId('victim-trace-0001', '/api/v1/client-errors-x')).toBe(
      'victim-trace-0001',
    );
  });
});
