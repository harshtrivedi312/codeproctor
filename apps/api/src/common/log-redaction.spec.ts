import pino from 'pino';
import { LOG_REDACT, SECRET_FIELDS } from './log-redaction';

function capture(obj: object): string {
  const lines: string[] = [];
  const logger = pino({ redact: LOG_REDACT }, { write: (l: string) => void lines.push(l) });
  logger.info(obj, 'test');
  return lines.join('');
}

describe('log redaction (FR-101, FR-102, NFR-04)', () => {
  it('FR-102: every secret field is redacted at top level, under req.body, and nested', () => {
    const secrets: Record<string, string> = {};
    for (const f of SECRET_FIELDS) secrets[f] = `SECRET-VALUE-${f}`;
    const out = capture({
      ...secrets,
      req: {
        headers: { authorization: 'Bearer SECRET-AUTH', cookie: 'cp_refresh=SECRET-COOKIE' },
        body: { ...secrets, nested: { ...secrets } },
      },
      res: { headers: { 'set-cookie': ['cp_refresh=SECRET-SETCOOKIE'] } },
      body: { ...secrets },
      a: { b: { ...secrets } },
      wrapper: { ...secrets },
    });
    expect(out).not.toContain('SECRET-');
    expect(out).toContain('[Redacted]');
  });

  it('FR-101: non-secret fields are left alone', () => {
    const out = capture({ req: { body: { email: 'a@example.com' } } });
    expect(out).toContain('a@example.com');
  });
});
