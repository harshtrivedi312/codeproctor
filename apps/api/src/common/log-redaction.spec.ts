import pino from 'pino';
import { LOG_REDACT, SECRET_FIELDS } from './log-redaction';

function capture(obj: object): string {
  const lines: string[] = [];
  const logger = pino({ redact: LOG_REDACT }, { write: (l: string) => void lines.push(l) });
  logger.info(obj, 'test');
  return lines.join('');
}

const CRITICAL = [
  'currentPassword',
  'password',
  'newPassword',
  'totpCode',
  'challengeToken',
  'refreshToken',
  'accessToken',
  'manualKey',
  'otpauthUri',
  'qrDataUrl',
  'recoveryCodes',
  'candidateToken',
  'objectKey',
  'sessionToken',
  'hmacKeyEnc',
  'pdfKey',
];

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
      d1: { d2: { d3: { ...secrets } } },
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

  it('FR-102: the critical secret names are all listed (catches a misspelled entry)', () => {
    for (const name of CRITICAL) expect(SECRET_FIELDS).toContain(name);
  });

  it('FR-101: otpauthUri carries the TOTP secret and is redacted', () => {
    const out = capture({ otpauthUri: 'otpauth://totp/x?secret=SECRET-B32' });
    expect(out).not.toContain('SECRET-B32');
  });

  it('NFR-04, BE-07: the candidate session token, the wrapped HMAC key and the consent PDF key are redacted', () => {
    const out = capture({
      res: { body: { sessionToken: 'SECRET-SESSION-TOKEN' } },
      session: { hmacKeyEnc: 'SECRET-WRAPPED-KEY', consent: { pdfKey: 'SECRET-PDF-KEY' } },
      hmacKeyEnc: 'SECRET-WRAPPED-KEY-2',
    });
    for (const secret of ['SECRET-SESSION-TOKEN', 'SECRET-WRAPPED-KEY', 'SECRET-PDF-KEY']) {
      expect(out).not.toContain(secret);
    }
  });
});
