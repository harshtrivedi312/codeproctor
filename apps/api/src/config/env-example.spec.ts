// The root .env.example must boot the API locally: its uncommented lines pass the real parser, it
// lists every required variable, and no commented default is an empty value (DL-52, NFR-04).
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { envSchema, validateEnv } from './env';

const text = readFileSync(resolve(__dirname, '../../../../.env.example'), 'utf8');
const lines = text.split(/\r?\n/);

function parse(rows: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const row of rows) {
    const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(row);
    if (m?.[1] !== undefined && m[2] !== undefined) out[m[1]] = m[2];
  }
  return out;
}

const active = parse(lines.filter((l) => !l.trimStart().startsWith('#') && l.trim() !== ''));
const commented = parse(
  lines.filter((l) => /^#\s*[A-Za-z_][A-Za-z0-9_]*=/.test(l)).map((l) => l.replace(/^#\s*/, '')),
);

/** Names whose schema field is neither optional nor defaulted: the API cannot boot without them. */
function requiredNames(): string[] {
  return Object.entries(envSchema.shape)
    .filter(([, field]) => !field.safeParse(undefined).success)
    .map(([name]) => name);
}

describe('.env.example (DL-52, NFR-04)', () => {
  it('DL-52 the uncommented lines pass the API environment parser with APP_ENV=development', () => {
    expect(active['APP_ENV']).toBe('development');
    expect(() => validateEnv({ ...active })).not.toThrow();
  });

  it('DL-52 the wrapping key for the active kid is a valid 32-byte key', () => {
    const kid = active['SESSION_KEY_ENC_ACTIVE_KID'] ?? 'k1';
    const key = active[`SESSION_KEY_ENC_KEY_${kid}`] ?? '';
    expect(Buffer.from(key, 'base64')).toHaveLength(32);
  });

  it('DL-52 every variable the schema requires appears uncommented', () => {
    const required = requiredNames();
    expect(required).toEqual(expect.arrayContaining(['DATABASE_URL', 'REDIS_URL', 'WEB_ORIGIN']));
    for (const name of required) expect(Object.keys(active)).toContain(name);
  });

  it('DL-52 the placeholder secrets are obviously fake', () => {
    for (const name of [
      'JWT_ACCESS_SECRET',
      'COOKIE_SECRET',
      'JWT_CANDIDATE_SECRET',
      'OTP_PEPPER',
    ]) {
      expect(active[name]).toMatch(/^change-me/);
    }
  });

  it('DL-52 no commented-out variable has an empty value (an empty number is read as 0)', () => {
    const empty = Object.entries(commented)
      .filter(([, value]) => value.trim() === '')
      .map(([name]) => name);
    expect(empty).toEqual([]);
  });

  it('DL-52 no active numeric variable is empty', () => {
    const numeric = Object.keys(envSchema.shape).filter((n) =>
      /(_PORT|_MS|_LIMIT|_SECONDS|_MAX|_HOPS)$/.test(n),
    );
    for (const name of numeric) {
      if (name in active) expect(active[name]).not.toBe('');
    }
  });
});
