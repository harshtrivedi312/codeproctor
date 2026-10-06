import { LOG_REDACT } from './log-redaction';
import { buildPinoHttpOptions } from './pino-http.config';

describe('pinoHttp config (FR-101, FR-102, NFR-04)', () => {
  it('FR-102: the app logger is configured with LOG_REDACT and the requested level', () => {
    const options = buildPinoHttpOptions('warn');
    expect(options.redact).toBe(LOG_REDACT);
    expect(options.level).toBe('warn');
  });

  it('NFR-04: the request serializer drops the query string', () => {
    const req = options().serializers?.req as (r: object) => { url: string };
    expect(req({ id: 'a', method: 'GET', url: '/x?token=SECRET' }).url).toBe('/x');
  });

  it('NFR-09, FU-BE-12: a malformed inbound id is replaced; a good one is kept', () => {
    const gen = options().genReqId as (req: object, res: object) => string;
    const res = { setHeader: jest.fn() };
    expect(gen({ headers: { 'x-request-id': 'good-id-12345' }, url: '/api/v1/x' }, res)).toBe(
      'good-id-12345',
    );
    expect(gen({ headers: { 'x-request-id': 'bad id\r\n<x>' }, url: '/api/v1/x' }, res)).toMatch(
      /^[0-9a-f-]{36}$/,
    );
  });

  it('FU-BE-95: the public client-errors route ignores the inbound id, in any case', () => {
    const gen = options().genReqId as (req: object, res: object) => string;
    const res = { setHeader: jest.fn() };
    for (const url of ['/api/v1/client-errors', '/API/V1/Client-Errors?x=1']) {
      expect(gen({ headers: { 'x-request-id': 'victim-trace-0001' }, url }, res)).toMatch(
        /^[0-9a-f-]{36}$/,
      );
    }
  });
});

function options(): ReturnType<typeof buildPinoHttpOptions> {
  return buildPinoHttpOptions('info');
}
