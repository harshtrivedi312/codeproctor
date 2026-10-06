// Scrubbing of text that a browser sent us, before it can reach a log line (NFR-04, C-32).
// A crash message can carry anything the page had in hand: an email, a token, an OTP, a signed
// storage URL. Everything here is linear in the input: no regex has an unbounded quantifier
// that can be retried from many start positions, and the token and email passes scan by hand,
// so a hostile 100k-character string cannot stall the event loop (tested).

const REDACTED = '[REDACTED]';

/** Path segments that mark an object-store key (candidate media, evidence, uploads). */
const OBJECT_SEGMENTS: ReadonlySet<string> = new Set([
  'media',
  'recordings',
  'recording',
  'snapshots',
  'snapshot',
  'frames',
  'frame',
  'chunks',
  'evidence',
  'uploads',
  'objects',
]);
const MEDIA_EXTENSION = /\.(?:webm|mp4|mkv|ogg|wav|jpe?g|png|bin|enc)$/i;

const LONG_TOKEN_MIN = 24;
const LOCAL_CHAR = /[A-Za-z0-9._%+-]/;
const DOMAIN_CHAR = /[A-Za-z0-9.-]/;

// Bounded quantifiers only. `\s{0,5}` and `[^\s&,;"']{1,500}` cannot backtrack badly.
const BEARER = /\b(Bearer|Basic)\s{1,5}[^\s,;"']{1,2000}/gi;
const KEY_VALUE =
  /\b(password|passwd|pwd|secret|token|access_token|refresh_token|api_?key|signature|credential|sig|key|x-amz-[a-z-]{1,40})(["']?\s{0,5}[=:]\s{0,5}["']?)[^\s&,;"']{1,500}/gi;
const OTP_AFTER_WORD = /\b(otp|code|token|pin|passcode)\b([^\d\n]{0,20}?)(?<!\d)\d{6,8}(?!\d)/gi;
const OTP_BEFORE_WORD = /(?<!\d)\d{6,8}(?!\d)([^\d\n]{0,20}?)\b(otp|code|token|pin|passcode)\b/gi;

function scrubWhitespaceToken(token: string): string {
  const lower = token.toLowerCase();
  if (
    lower.includes('s3://') ||
    lower.includes('amazonaws.com') ||
    lower.includes('cloudflarestorage.com')
  ) {
    return '[REDACTED_URL]';
  }
  if (!token.includes('/')) return token;
  // URL-ish: drop the query string and the fragment, which can carry tokens and ids.
  const q = token.indexOf('?');
  const h = token.indexOf('#');
  const cut = q === -1 ? h : h === -1 ? q : Math.min(q, h);
  const base = cut === -1 ? token : token.slice(0, cut);
  const isKey = base.split('/').some((seg) => OBJECT_SEGMENTS.has(seg.toLowerCase()));
  if (isKey || MEDIA_EXTENSION.test(base)) return '[REDACTED_KEY]';
  return cut === -1 ? token : `${base}?${REDACTED}`;
}

function isHexLike(run: string): boolean {
  return run.length >= 32 && /^[0-9a-f]+$/i.test(run);
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
  // A long opaque token (also covers hex strings of 32 or more) in any dot-separated part.
  if (parts.some((p) => p.length >= LONG_TOKEN_MIN || isHexLike(p))) return REDACTED;
  return run;
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
    const domain = input.slice(at + 1, end).replace(/\.+$/, '');
    const dot = domain.lastIndexOf('.');
    const validDomain = dot > 0 && /^[A-Za-z]{2,}$/.test(domain.slice(dot + 1));
    if (start < at && validDomain) {
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
 * storage URLs and object keys, `Bearer` tokens, `password=`/`token=`/`key=`/`X-Amz-*` pairs,
 * OTP-looking numbers near a keyword, emails, JWTs, and long opaque or hex tokens. Pure; never
 * throws. Truncates to `maxLength` after scrubbing.
 */
export function scrubClientText(input: string, maxLength = 8000): string {
  let s = input.replace(/\S+/g, scrubWhitespaceToken);
  s = s.replace(BEARER, (_m, scheme: string) => `${scheme} ${REDACTED}`);
  s = s.replace(KEY_VALUE, (_m, k: string, sep: string) => `${k}${sep}${REDACTED}`);
  s = s.replace(OTP_AFTER_WORD, (_m, w: string, gap: string) => `${w}${gap}${REDACTED}`);
  s = s.replace(OTP_BEFORE_WORD, (_m, gap: string, w: string) => `${REDACTED}${gap}${w}`);
  s = scrubEmails(s);
  s = s.replace(/[A-Za-z0-9_.-]+/g, scrubRun);
  return truncate(s, maxLength);
}

/** A page URL: always drops the query string and fragment first, then scrubs what is left. */
export function scrubClientUrl(input: string, maxLength = 500): string {
  const cut = input.search(/[?#]/);
  const base = cut === -1 ? input : input.slice(0, cut);
  return scrubClientText(base, maxLength);
}
