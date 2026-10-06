// Scrubbing of text that a browser sent us, before it can reach a log line (NFR-04, C-32).
// A crash message can carry anything the page had in hand: an email, a token, an OTP, a signed
// storage URL, the proctor HMAC key. The route is public, so every pass here must be linear in
// the input: the input is hard-cut first, no regex has an unbounded quantifier that can be
// retried from many start positions, and the token and email passes scan by hand (tested on
// adversarial strings).

const REDACTED = '[REDACTED]';

/** Input is cut to this many times the output bound before any pass runs. */
const INPUT_FACTOR = 4;

/** ADR 0013 section 5.7: `orgs/<id>/<area>/...`. The area is the object-store partition. */
const KEY_AREAS: ReadonlySet<string> = new Set([
  'sessions',
  'consents',
  'identity',
  'reports',
  'live',
  'sealed',
]);
const MEDIA_EXTENSION = /\.(?:webm|mp4|mkv|ogg|wav|jpe?g|png|pdf|bin|enc)$/i;

const LONG_TOKEN_MIN = 24;
const LOCAL_CHAR = /[\p{L}\p{N}._%+-]/u;
const DOMAIN_CHAR = /[\p{L}\p{N}.-]/u;
const TLD = /^(?:\p{L}{2,}|xn--[a-z0-9-]{2,})$/iu;

// Only bounded quantifiers below: `\s{0,5}`, `[^\s&,;"'\\]{1,500}`, `[^\r\n]{1,2000}`.
// eslint-disable-next-line no-control-regex -- stripping control characters is the point
const ANSI = /\u001b\[[0-9;?]{0,20}[ -/]{0,2}[@-~]/g;
// eslint-disable-next-line no-control-regex -- stripping control characters is the point
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g;
const AUTH_LINE = /\bauthorization(\\?["']?\s{0,5}[=:]\s{0,5})[^\r\n]{1,2000}/gi;
const COOKIE_LINE = /\b((?:set-)?cookie)(\\?["']?\s{0,5}[=:]\s{0,5})[^\r\n]{1,2000}/gi;
const SCHEME = /\b(Bearer|Basic)\s{1,5}[^\s,;"'\\]{1,2000}/gi;
// Keyword as an identifier substring (otpCode, new_password, password_confirmation), then up to
// 20 identifier characters, an optional (escaped) quote, `=` or `:` and the value.
const KEY_VALUE =
  /(password|passwd|secret|token|passcode|api_?key|signature|credential|x-amz-[a-z-]{1,40})([A-Za-z0-9_]{0,20}\\?["']?\s{0,5}[=:]\s{0,5}\\?["']?)[^\s&,;"'\\]{1,500}/gi;
const WORD_KEY_VALUE = /\b(key|sig)(\\?["']?\s{0,5}[=:]\s{0,5}\\?["']?)[^\s&,;"'\\]{1,500}/gi;
// 6 to 8 digits, with one optional space or dash between digits (482-913).
const DIGITS = String.raw`(?<!\d)\d(?:[ -]?\d){5,7}(?!\d)`;
const OTP_AFTER_WORD = new RegExp(
  String.raw`(otp|code|token|pin|passcode)([^\d]{0,20}?)${DIGITS}`,
  'gi',
);
const OTP_BEFORE_WORD = new RegExp(
  String.raw`${DIGITS}([^\d]{0,20}?)(otp|code|token|pin|passcode)`,
  'gi',
);

/** Index where a query string or fragment starts, or -1. A bare `?` needs a `=` after it. */
function queryStart(token: string): number {
  const slash = token.includes('/');
  let q = token.indexOf('?');
  if (q !== -1 && !slash && token.indexOf('=', q) === -1) q = -1;
  const h = slash ? token.indexOf('#') : -1;
  return q === -1 ? h : h === -1 ? q : Math.min(q, h);
}

function isObjectKey(base: string): boolean {
  if (base.includes('_next/')) return false;
  const segs = base.split('/');
  for (let i = 0; i + 2 < segs.length; i += 1) {
    if (
      (segs[i] ?? '').toLowerCase() === 'orgs' &&
      KEY_AREAS.has((segs[i + 2] ?? '').toLowerCase())
    ) {
      return true;
    }
  }
  return MEDIA_EXTENSION.test(base);
}

function scrubWhitespaceToken(token: string): string {
  const lower = token.toLowerCase();
  if (
    lower.includes('s3://') ||
    lower.includes('amazonaws.com') ||
    lower.includes('cloudflarestorage.com') ||
    lower.includes('otpauth:')
  ) {
    return '[REDACTED_URL]';
  }
  const cut = queryStart(token);
  const base = cut === -1 ? token : token.slice(0, cut);
  if (token.includes('/') && isObjectKey(base)) return '[REDACTED_KEY]';
  return cut === -1 ? token : `${base}?${REDACTED}`;
}

function hasMixedClasses(s: string): boolean {
  return /[A-Z]/.test(s) && /[a-z]/.test(s) && /\d/.test(s);
}

function scrubRun(run: string): string {
  const parts = run.split('.');
  // JWT: three dot-separated base64url parts.
  if (
    parts.length === 3 &&
    ((parts[0] ?? '').startsWith('eyJ') || (run.length >= 40 && parts.every((p) => p.length >= 10)))
  ) {
    return REDACTED;
  }
  // A long opaque token (also covers hex of 32 or more) in any dot-separated part.
  return parts.some((p) => p.length >= LONG_TOKEN_MIN) ? REDACTED : run;
}

/** Standard base64 (the HMAC proctor key, ADR 0013 section 4): split by + and / so the run pass misses it. */
function scrubBase64(run: string): string {
  const qualifies = (run.includes('+') || run.endsWith('=')) && hasMixedClasses(run);
  return qualifies ? REDACTED : run;
}

function trimTrailingDots(s: string): string {
  let end = s.length;
  while (end > 0 && s.charCodeAt(end - 1) === 46) end -= 1;
  return s.slice(0, end);
}

function scrubEmails(input: string): string {
  if (!input.includes('@')) return input;
  let out = '';
  let last = 0;
  let at = input.indexOf('@');
  while (at !== -1) {
    let start = at;
    while (start > last && LOCAL_CHAR.test(input[start - 1] ?? '')) start -= 1;
    let end = at + 1;
    while (end < input.length && DOMAIN_CHAR.test(input[end] ?? '')) end += 1;
    const domain = trimTrailingDots(input.slice(at + 1, end));
    const dot = domain.lastIndexOf('.');
    if (start < at && dot > 0 && TLD.test(domain.slice(dot + 1))) {
      out += input.slice(last, start) + REDACTED;
      last = at + 1 + domain.length;
      at = input.indexOf('@', last);
    } else {
      at = input.indexOf('@', at + 1);
    }
  }
  return out + input.slice(last);
}

/** Truncates to `max` characters without leaving half of a surrogate pair. */
function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  const cut = s.slice(0, max);
  const last = cut.charCodeAt(max - 1);
  return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut;
}

/**
 * Redacts personal data and secrets from client-supplied text: URL query strings and fragments,
 * storage URLs and object keys, Authorization and Cookie lines, `Bearer` tokens, password, token,
 * key and `X-Amz-*` pairs in any naming style, OTP-looking numbers near a keyword, emails, JWTs,
 * base64 keys and long opaque or hex tokens. Pure; never throws; the input is cut to four times
 * `maxLength` first, and the result is truncated to `maxLength` after scrubbing. Short unlabelled
 * tokens are not caught (FU-BE-94).
 */
export function scrubClientText(input: string, maxLength = 8000): string {
  let s = input.slice(0, maxLength * INPUT_FACTOR);
  s = s.replace(ANSI, '').replace(CONTROL, ' ');
  // Encoded and fullwidth at-signs: otpauth labels carry `jane%40example.com`.
  s = s.replace(/%40/gi, '@').replace(/\uff20/g, '@');
  s = s.replace(/\S+/g, scrubWhitespaceToken);
  s = s.replace(AUTH_LINE, (_m, sep: string) => `authorization${sep}${REDACTED}`);
  s = s.replace(COOKIE_LINE, (_m, k: string, sep: string) => `${k}${sep}${REDACTED}`);
  s = s.replace(SCHEME, (_m, scheme: string) => `${scheme} ${REDACTED}`);
  s = s.replace(KEY_VALUE, (_m, k: string, sep: string) => `${k}${sep}${REDACTED}`);
  s = s.replace(WORD_KEY_VALUE, (_m, k: string, sep: string) => `${k}${sep}${REDACTED}`);
  s = s.replace(OTP_AFTER_WORD, (_m, w: string, gap: string) => `${w}${gap}${REDACTED}`);
  s = s.replace(OTP_BEFORE_WORD, (_m, gap: string, w: string) => `${REDACTED}${gap}${w}`);
  s = scrubEmails(s);
  s = s.replace(/[A-Za-z0-9+/]{32,}={0,2}/g, scrubBase64);
  s = s.replace(/[A-Za-z0-9_.-]+/g, scrubRun);
  return truncate(s, maxLength);
}

/** A page URL: always drops the query string and fragment first, then scrubs what is left. */
export function scrubClientUrl(input: string, maxLength = 500): string {
  const head = input.slice(0, maxLength * INPUT_FACTOR);
  const cut = head.search(/[?#]/);
  return scrubClientText(cut === -1 ? head : head.slice(0, cut), maxLength);
}
