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
});

function options(): ReturnType<typeof buildPinoHttpOptions> {
  return buildPinoHttpOptions('info');
}
