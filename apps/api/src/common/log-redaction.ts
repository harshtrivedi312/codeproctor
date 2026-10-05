/** Field names that must never reach a log line, at any depth (FR-101, FR-102, NFR-04). */
export const SECRET_FIELDS = [
  'currentPassword',
  'password',
  'newPassword',
  'totpCode',
  'code',
  'token',
  'challengeToken',
  'recoveryCode',
  'recoveryCodes',
  'refreshToken',
  'accessToken',
  'secret',
  'manualKey',
  'qrDataUrl',
] as const;

const PREFIXES = [
  '',
  '*.',
  '*.*.',
  '*.*.*.',
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
  ],
  censor: '[Redacted]',
};
