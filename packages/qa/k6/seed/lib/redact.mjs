// Redaction for everything the seeder prints. Bearer tokens, OTPs, media keys and presigned URLs
// must never reach stdout, stderr, error messages or CI logs (CLAUDE.md rules, ADR 0013 C-5).
const URL_RE = /[a-z][a-z0-9+.-]*:\/\/[^\s"'<>]*/gi; // whole URL: the path can hold a media key
const JWT_RE = /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]*/g;
const LONG_RE = /[A-Za-z0-9_+/=-]{24,}/g; // tokens, base64 keys, hex digests
const BEARER_RE = /\bBearer\s+\S+/gi;
const OTP_RE = /\b\d{6}\b/g;

// Replace known secret values (exact), then URLs, JWTs, bearer headers, long opaque strings and
// six-digit codes. Over-redacting is the safe direction; messages are for humans, not parsers.
const RUN_ID_IN_TEXT = /k6seed-\d{14}-[0-9a-f]{6}/g; // not a secret; keep it readable in logs

export function redact(text, secrets = []) {
  const kept = [];
  let out = String(text).replace(RUN_ID_IN_TEXT, (m) => `\uE000${kept.push(m) - 1}\uE000`);
  for (const s of secrets) {
    if (typeof s === 'string' && s.length >= 4) out = out.split(s).join('<redacted>');
  }
  out = out
    .replace(URL_RE, '<url-redacted>')
    .replace(BEARER_RE, 'Bearer <redacted>')
    .replace(JWT_RE, '<redacted>')
    .replace(LONG_RE, '<redacted>')
    .replace(OTP_RE, '<redacted>');
  return out.replace(/\uE000(\d+)\uE000/g, (_m, i) => kept[Number(i)]);
}

// An error whose message was written by this tool and contains no response body text.
export class SeedError extends Error {
  constructor(message, { status, code, step } = {}) {
    super(message);
    this.name = 'SeedError';
    this.status = status;
    this.code = code;
    this.step = step;
  }
}
