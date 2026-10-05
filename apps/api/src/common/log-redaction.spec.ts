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
    // `code` is a secret only in bodies; elsewhere it is an error code.
    const bodySecrets = { ...secrets, code: 'SECRET-VALUE-code' };
    const out = capture({
      ...secrets,
      req: {
        headers: { authorization: 'Bearer SECRET-AUTH', cookie: 'cp_refresh=SECRET-COOKIE' },
        body: { ...bodySecrets, nested: { ...bodySecrets } },
      },
      body: { ...bodySecrets },
      a: { b: { ...secrets } },
      d1: { d2: { d3: { d4: { ...secrets } } } },
      res: {
        headers: { 'set-cookie': ['cp_refresh=SECRET-SETCOOKIE'] },
        body: { ...bodySecrets, nested: { ...bodySecrets } },
      },
      wrapper: { ...secrets },
    });
    expect(out).not.toContain('SECRET-');
    expect(out).toContain('[Redacted]');
  });

  it('FR-101: non-secret fields are left alone', () => {
    const out = capture({ req: { body: { email: 'a@example.com' } } });
    expect(out).toContain('a@example.com');
  });

  it('FR-101: a database or Node error code under err survives while req.body.code is redacted', () => {
    const out = capture({
      err: Object.assign(new Error('x'), { code: 'P2002' }),
      req: { id: 'req-1234', body: { code: 'SECRET-TOTP' } },
      traceId: 'trace-1234',
    });
    expect(out).toContain('P2002');
    expect(out).not.toContain('SECRET-TOTP');
    expect(out).toContain('req-1234');
    expect(out).toContain('trace-1234');
  });
});
