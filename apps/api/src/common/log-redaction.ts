/** Field names that must never reach a log line, at any depth (FR-101, FR-102, NFR-04). */
export const SECRET_FIELDS = [
  'currentPassword',
  'password',
  'newPassword',
  'totpCode',
  'token',
  'challengeToken',
  'recoveryCode',
  'recoveryCodes',
  'refreshToken',
  'accessToken',
  'secret',
  'manualKey',
  'qrDataUrl',
  // Sensitive column names, in case a row is ever logged.
  'passwordHash',
  'totpSecretEnc',
  'recoveryCodeHashes',
  'setPasswordTokenHash',
  'tokenHash',
] as const;

/**
 * `code` is a secret only as a request or response body member (the TOTP or recovery code). It is
 * deliberately not redacted under `err`, where it is a Prisma or Node error code (P2002, ...).
 */
const BODY_ONLY_FIELDS = ['code'] as const;

const PREFIXES = [
  '',
  '*.',
  '*.*.',
  '*.*.*.',
  '*.*.*.*.',
  '*.*.*.*.*.',
  'req.body.',
  'req.body.*.',
  'req.body.*.*.',
  'body.',
  'body.*.',
  'res.body.',
  'res.body.*.',
];

const BODY_PREFIXES = [
  'req.body.',
  'req.body.*.',
  'req.body.*.*.',
  'body.',
  'body.*.',
  'res.body.',
  'res.body.*.',
];

/** pino redact config: header redactions plus every secret field name at several depths. */
export const LOG_REDACT = {
  paths: [
    'req.headers.authorization',
    'req.headers.cookie',
    'res.headers["set-cookie"]',
    ...PREFIXES.flatMap((prefix) => SECRET_FIELDS.map((field) => `${prefix}${field}`)),
    ...BODY_PREFIXES.flatMap((prefix) => BODY_ONLY_FIELDS.map((field) => `${prefix}${field}`)),
  ],
  censor: '[Redacted]',
};
