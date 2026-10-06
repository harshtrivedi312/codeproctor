import { scrubClientText, scrubClientUrl } from './scrub-client-text';

const JWT =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';
// Standard base64 of 32 bytes (ADR 0013 section 4): '+' at index 14 and '/' at index 29, one '='.
const HMAC_KEY = 'AbCdEfGhIjKlMn+pQrStUvWxYz012/4AbCdEfGhIjKl=';

describe('scrubClientText (NFR-04, C-32)', () => {
  it('NFR-04: redacts email addresses, encoded, IDN and fullwidth forms', () => {
    const out = scrubClientText('Failed for jane.doe+test@mail.example.com now');
    expect(out).toBe('Failed for [REDACTED] now');
    for (const input of [
      'otpauth://totp/CodeProctor:jane%40example.com?secret=ABC',
      'x jane%40example.com y',
      'x jane@münchen.de y',
      'x jöhn@example.com y',
      'x jane＠example.com y',
    ]) {
      const res = scrubClientText(input);
      expect(res).not.toMatch(/jane|jöhn|example\.com|münchen/);
    }
  });

  it('NFR-04: keeps text that only looks like an email', () => {
    expect(scrubClientText('a @ b and user@localhost')).toBe('a @ b and user@localhost');
  });

  it('NFR-04: redacts JWTs, Bearer tokens and Authorization, Cookie lines', () => {
    const out = scrubClientText(`token ${JWT} and Bearer abc.def-ghi_123`);
    expect(out).not.toContain('eyJ');
    expect(out).not.toContain('abc.def');
    expect(out).toContain('Bearer [REDACTED]');
    const lines = scrubClientText(
      'Authorization: Basic dXNlcjpwYXNz\nCookie: sid=abc; theme=dark\nSet-Cookie: refresh=zzz; HttpOnly\nok',
    );
    expect(lines).not.toMatch(/dXNlcjpwYXNz|sid=abc|theme=dark|refresh=zzz/);
    expect(lines.endsWith('\nok')).toBe(true);
  });

  it('NFR-04: redacts long opaque tokens and hex strings', () => {
    const opaque = 'Ab3dE6gH9jK2mN5pQ8sT1vW4';
    const hex = 'deadbeef'.repeat(4);
    const out = scrubClientText(`id ${opaque} hash ${hex} short abc123`);
    expect(out).not.toContain(opaque);
    expect(out).not.toContain(hex);
    expect(out).toContain('short abc123');
  });

  it('NFR-04: redacts standard base64 keys split by + and /', () => {
    expect(HMAC_KEY.indexOf('+')).toBe(14);
    expect(HMAC_KEY.indexOf('/')).toBe(29);
    for (const input of [
      `hmac ${HMAC_KEY} bad`,
      'Invalid HMAC key q+3xAbCdEfGh12/IjKlMnOpQr34+StUvWxYz567AbCd=',
    ]) {
      const out = scrubClientText(input);
      expect(out).not.toMatch(/AbCdEf|q\+3x|StUvWx|IjKl/);
    }
    // Ordinary paths and words survive.
    expect(
      scrubClientText('at /Users/dev/Projects/MyApp2/src/components/Editor/index.tsx'),
    ).toContain('MyApp2/src/components/Editor');
  });

  it('NFR-04: redacts 6 to 8 digit codes next to otp, code, token or pin, in any spelling', () => {
    expect(scrubClientText('otp 123456 failed')).toBe('otp [REDACTED] failed');
    expect(scrubClientText('code: 98765432')).toBe('code: [REDACTED]');
    expect(scrubClientText('123456 is your pin')).toBe('[REDACTED] is your pin');
    expect(scrubClientText('status 123456 ok')).toBe('status 123456 ok');
    expect(scrubClientText('code 12345')).toBe('code 12345');
    for (const input of [
      '{"otpCode":"482913"}',
      'verificationCode: 482913',
      'one_time_code=482913',
      'otp_code 482913',
      'OTP:\n482913',
      'otp 482-913',
      'otp 482 913',
    ]) {
      expect(scrubClientText(input)).not.toMatch(/482\D?913/);
    }
  });

  it('NFR-04: redacts password and secret pairs in any naming and escaping style', () => {
    for (const input of [
      'login failed password=hunter2 and "password": "swordfish"',
      '{"newPassword":"hunter2"}',
      'currentPassword=hunter2',
      'password_confirmation=hunter2',
      '{\\"password\\":\\"hunter2\\"}',
      'client_secret=hunter2',
      'refreshToken: hunter2',
    ]) {
      expect(scrubClientText(input)).not.toMatch(/hunter2|swordfish/);
    }
  });

  it('NFR-04: redacts presigned URL parameters and storage URLs', () => {
    const url =
      'https://bucket.s3.amazonaws.com/org/1/frame.webm?X-Amz-Signature=abcd1234&X-Amz-Credential=AKIA';
    expect(scrubClientText(`GET ${url} failed`)).toBe('GET [REDACTED_URL] failed');
    const loose = scrubClientText(
      'sig=zz99 X-Amz-Signature=qq11 Credential=AKIAxx key=k1 token=t1',
    );
    expect(loose).not.toMatch(/zz99|qq11|AKIAxx|k1|t1/);
  });

  it('NFR-04: redacts real object keys but keeps Next.js frames', () => {
    expect(scrubClientText('upload failed for orgs/7/sessions/s9/chunk-1.webm')).toBe(
      'upload failed for [REDACTED_KEY]',
    );
    expect(scrubClientText('x orgs/7/identity/u1/photo')).toBe('x [REDACTED_KEY]');
    expect(scrubClientText('report orgs/1/x/y.pdf')).toBe('report [REDACTED_KEY]');
    expect(scrubClientText('see s3://private-bucket/a/b')).toBe('see [REDACTED_URL]');
    expect(scrubClientText('at https://app/_next/static/chunks/main-abc.js:1:2')).toBe(
      'at https://app/_next/static/chunks/main-abc.js:1:2',
    );
    expect(scrubClientText('at https://app/_next/static/chunks/main-abc.js?v=1:1:2')).toBe(
      'at https://app/_next/static/chunks/main-abc.js?[REDACTED]',
    );
    expect(scrubClientText('font https://app/_next/static/media/f.png')).toContain(
      '_next/static/media',
    );
  });

  it('NFR-04: redacts object keys inside quotes, JSON, pairs, brackets and sentences', () => {
    const key = 'orgs/42/sessions/s9/chunk-1.webm';
    for (const input of [
      `Upload failed for "${key}"`,
      `{"key":"${key}"}`,
      `key=${key}`,
      `(${key})`,
      `failed: ${key}.`,
      `https://app/_next/static/x.js ${key}`,
      `https://app/_next/${key}`,
      `see 'foo/bar/chunk-1.webm'.`,
      `"foo/bar/chunk-1.webm".`,
    ]) {
      const out = scrubClientText(input);
      expect(out).not.toMatch(/chunk-1|sessions\/s9|orgs\/42/);
    }
  });

  it('NFR-04: redacts whole quoted secret values, passphrases and unquoted values with symbols', () => {
    for (const input of [
      '{"password":"correct horse battery staple"}',
      "{'password': 'correct horse battery staple'}",
      "'password' => 'correct horse battery staple'",
      '{\\"password\\":\\"correct horse battery staple\\"}',
      'password=correct&horse',
      'password=Tr0ub4dor&3',
      '{"secret":"a b, c; d"}',
    ]) {
      expect(scrubClientText(input)).not.toMatch(/correct|horse|battery|staple|&3|Tr0ub|a b|c; d/);
    }
    expect(scrubClientText('{"password":"x y","after":"kept"}')).toContain('"after":"kept"');
  });

  it('NFR-04: redacts key, sig, pass and pw as the end of an identifier', () => {
    for (const input of [
      '{"hmacKey":"kX9aB3cD7eF1gH2iJ3kQAA=="}',
      'privateKey: abc123',
      'signing_key=abc123',
      'sessionKey = abc123',
      'hmacSig=abc123',
      'userPass: abc123',
      'dbpw=abc123',
      'pwd=abc123',
      'x-api-key: abc123',
    ]) {
      expect(scrubClientText(input)).not.toMatch(/kX9a|abc123/);
    }
    expect(scrubClientText('keyboard shortcut and key words')).toBe(
      'keyboard shortcut and key words',
    );
  });

  it('NFR-04: decodes %2B, %2F and %3D before the base64 pass', () => {
    const out = scrubClientText('k=AbCdEfGhIjKlMn%2BpQrStUvWxYz012%2F4AbCdEfGhIjKl%3D');
    expect(out).not.toMatch(/AbCdEf|pQrSt/);
  });

  it('NFR-04: redacts an upper and lower case base64 run that ends in =, even without digits', () => {
    expect(scrubClientText('x AbCdEfGhIjKlMnOpQrStUvWxYzAbCdEfGhIjKlMn+ y')).not.toMatch(/AbCdEf/);
    expect(scrubClientText(`x ${'a'.repeat(43)}= y`)).toBe('x [REDACTED] y');
  });

  it('NFR-04: strips line separators and bidi overrides', () => {
    expect(scrubClientText('a\u2028b\u202ec\u2066d')).toBe('a b c d');
  });

  it('NFR-04: redacts the whole value when a quoted secret contains an escaped quote', () => {
    const cases: [string, RegExp][] = [
      ['{"password":"ab\\"cd ef"}', /cd|ef/],
      ['{"password":"\\"abc def"}', /abc|def/],
      ['{"privateKey":"x\\"y z"}', /y z|x/],
      ['{\\"password\\":\\"a\\\\\\"b c\\"}', /b c|a\\\\/],
      ["{\\'password\\': \\'x y\\'}", /x y/],
      ['password: `x y`', /x y/],
      ['candidatesMediaUploadEncryptionKey=abc123', /abc123/],
      ['{"otp":["4","8","2","9","1","3"]}', /"4"|"3"/],
      ['postgres://app:hun!ter@db.example.com/x', /hun|app:/],
      ['wss://u:pw@host:1', /u:pw/],
    ];
    for (const [input, leak] of cases) {
      expect(`${input} => ${scrubClientText(input)}`).not.toMatch(
        new RegExp(`=> .*(?:${leak.source})`),
      );
    }
    expect(scrubClientText('{"password":"ab\\"cd ef","after":"kept"}')).toContain('"after":"kept"');
  });

  it('NFR-04: redacts backslash values, encoded URL passwords and hyphenated key names', () => {
    const cases: [string, RegExp][] = [
      ['login failed password=\\Tr0ub4dor', /Tr0ub4dor/],
      ['password=ab\\cd', /cd/],
      ['postgres://app:Xk3%2F9pQ@localhost:5432/db', /Xk3|9pQ|app:/],
      ['postgres://admin@corp.com:S3cretPass@localhost:5432/db', /S3cretPass|admin@corp/],
      ['postgres://admin@corp.com:S3cretPass@10.0.0.5:5432/db', /S3cretPass|admin@corp/],
      ['postgres://app:p%40ss@localhost:5432/db', /ss@|p%40|app:/],
      ['https://u:hun!ter@db.example.com', /hun|u:/],
      ['wss://u:pw@host:1', /u:pw/],
      ['password-confirm=hunter2', /hunter2/],
    ];
    for (const [input, leak] of cases) {
      expect(`${input} => ${scrubClientText(input)}`).not.toMatch(
        new RegExp(`=> .*(?:${leak.source})`),
      );
    }
    expect(scrubClientText('postgres://app:p%40ss@localhost:5432/db')).toContain(
      'localhost:5432/db',
    );
  });

  it('NFR-04: keeps a standard UUID (session and trace ids) but not other long ids', () => {
    const uuid = '123e4567-e89b-12d3-a456-426614174000';
    expect(scrubClientText(`session ${uuid} failed`)).toBe(`session ${uuid} failed`);
    expect(scrubClientText(`token=${uuid}`)).not.toContain(uuid);
    expect(scrubClientText(`id x${uuid}`)).not.toContain(uuid);
  });

  it('NFR-04: strips query strings and fragments from URLs in text', () => {
    const out = scrubClientText('at https://app.example.test/candidate/x?invite=abc&y=1#frag:10:5');
    expect(out).toBe('at https://app.example.test/candidate/x?[REDACTED]');
    expect(scrubClientText('GET ?invite=abc123xyz')).not.toContain('abc123xyz');
    expect(scrubClientUrl('https://app.example.test/p?a=1#z')).toBe('https://app.example.test/p');
    expect(scrubClientUrl('/p#frag')).toBe('/p');
  });

  it('NFR-04: strips control characters and ANSI sequences', () => {
    expect(scrubClientText('\u001b[31mred\u001b[0m\u0007 ok\u0085!')).toBe('red  ok !');
  });

  it('NFR-04: truncates after scrubbing and never splits a surrogate pair', () => {
    expect(scrubClientText('x'.repeat(50), 10)).toHaveLength(10);
    expect(scrubClientText('ab😀😀', 3)).toBe('ab');
  });

  it('NFR-04: handles unicode and empty input', () => {
    expect(scrubClientText('')).toBe('');
    expect(scrubClientText('Fehler: ungültig 日本語 ✓')).toBe('Fehler: ungültig 日本語 ✓');
  });

  it('NFR-04: short unlabelled tokens survive (documented, FU-BE-94)', () => {
    expect(scrubClientText('value abc123def')).toBe('value abc123def');
  });

  it('NFR-04: runs in linear time on adversarial input (each under 100 ms)', () => {
    const inputs: Record<string, string> = {
      a: 'a'.repeat(100_000),
      atA: 'a@'.repeat(50_000),
      ats: '@'.repeat(100_000),
      dots: 'a.'.repeat(50_000),
      atDots: `x@${'.'.repeat(100_000)}a`,
      atDotsA: `${'a@'.repeat(100)}${'.'.repeat(100_000)}a`,
      dashes: '-'.repeat(100_000),
      percent: '%'.repeat(100_000),
      pct40: '%40'.repeat(30_000),
      digits: '1234567 '.repeat(12_000),
      digitDash: '1-'.repeat(50_000),
      codeNear: 'code 12345 '.repeat(10_000),
      keywords: 'password'.repeat(12_000),
      keywordSep: 'password:'.repeat(12_000),
      spaces: ' '.repeat(100_000),
      queries: 'https://x/y?'.repeat(8_000),
      almostLong: `${'a'.repeat(23)}-`.repeat(4_000),
      almostB64: `${'aB3'.repeat(10)}+`.repeat(3_000),
      slashes: '/'.repeat(100_000),
      mixed: 'a1B+/'.repeat(20_000),
      xAmz: `x-amz-${'a'.repeat(100_000)}`,
      quoteOpen: 'password="'.repeat(8_000),
      quoteOpen2: '{"password":"'.repeat(3_000),
      keySuffix: 'a-'.repeat(50_000) + 'key',
      keySuffix2: 'key'.repeat(30_000),
      orgs: 'orgs/'.repeat(20_000),
      orgs2: `orgs/${'a'.repeat(99)}/sessions/`.repeat(300),
      authLines: 'authorization:'.repeat(7_000),
      ctrl: '\u001b['.repeat(50_000),
      unicode: 'é@ü.'.repeat(25_000),
    };
    const timings: string[] = [];
    for (const [name, input] of Object.entries(inputs)) {
      const start = performance.now();
      scrubClientText(input);
      const ms = performance.now() - start;
      timings.push(`${name}=${ms.toFixed(1)}ms`);
      expect(`${name} ${ms < 100}`).toBe(`${name} true`);
    }
    // Independent of the input cut: the same worst cases with the cut lifted (400k characters).
    for (const input of [
      `x@${'.'.repeat(100_000)}a`,
      'a@'.repeat(50_000),
      'a1B+/'.repeat(20_000),
    ]) {
      const start = performance.now();
      scrubClientText(input, 1_000_000);
      const ms = performance.now() - start;
      timings.push(`uncut=${ms.toFixed(1)}ms`);
      expect(ms).toBeLessThan(100);
    }
    process.stdout.write(`scrub timings: ${timings.join(' ')}\n`);
  });
});

// The scrubber runs on a public route, so every pass must stay linear. This table feeds each
// field's bound with runs of every special character in the shapes that have bitten before
// (`[class]+$`, nested quantifiers, repeated near-matches) and checks both an absolute bound and
// that doubling the input does not much more than double the time.
describe('scrubClientText worst cases (NFR-04, C-32)', () => {
  const fields: [string, number, (s: string) => string][] = [
    ['message', 1000, (s) => scrubClientText(s, 1000)],
    ['stack', 8000, (s) => scrubClientText(s, 8000)],
    ['url', 2000, (s) => scrubClientUrl(s, 500)],
    ['component', 200, (s) => scrubClientText(s, 200)],
    ['release', 100, (s) => scrubClientText(s, 100)],
    ['userAgent', 200, (s) => scrubClientText(s, 200)],
  ];
  const chars = [
    ...'.,;:)([]}{><"\'`\\/@=&?#%-_+!*~|^$ \t\n0123456789aAéü＠',
    '%40',
    '%2B',
    '\u001b[',
  ];
  const shapes: [string, (c: string, n: number) => string][] = [
    ['c*n+a', (c, n) => `${c.repeat(n)}a`],
    ['a+c*n+a', (c, n) => `a${c.repeat(n)}a`],
    ['/+c*n+x', (c, n) => `/${c.repeat(n)}x`],
    ['@+c*n+x', (c, n) => `@${c.repeat(n)}x`],
    ['=+c*n+x', (c, n) => `=${c.repeat(n)}x`],
    ['key=+c*n', (c, n) => `key=${c.repeat(n)}`],
    ['password"+c*n', (c, n) => `password"${c.repeat(n)}`],
    ['orgs/+c*n', (c, n) => `orgs/${c.repeat(n)}`],
    ['x-amz-+c*n', (c, n) => `x-amz-${c.repeat(n)}`],
    ['otp+c*n+digits', (c, n) => `otp${c.repeat(n)}123456`],
    ['scheme://u:+c*n', (c, n) => `https://u:${c.repeat(n)}`],
    ['pairs', (c, n) => `${c}a`.repeat(Math.ceil(n / 2))],
  ];

  function time(fn: (s: string) => string, input: string): number {
    const start = performance.now();
    fn(input);
    return performance.now() - start;
  }

  /**
   * Best of several runs: a pause (GC, a busy shared runner) only ever adds time, so the minimum is
   * the stable estimate of the work itself. A genuinely super-linear pass is slow on every run.
   */
  function best(fn: (s: string) => string, input: string, runs: number): number {
    let min = Infinity;
    for (let i = 0; i < runs; i++) min = Math.min(min, time(fn, input));
    return min;
  }

  it('NFR-04: every field, character and shape is under 100 ms and grows linearly', () => {
    let slowest = { ms: 0, label: '' };
    const failures: string[] = [];
    for (const [field, max, fn] of fields) {
      fn('warm up'.repeat(100));
      for (const [shape, build] of shapes) {
        for (const c of chars) {
          const small = build(c, Math.floor(max * 1.5));
          const large = build(c, max * 3);
          let ts = best(fn, small, 3);
          let tl = best(fn, large, 3);
          // A suspicious ratio is measured again with more runs before it counts as a failure.
          if (tl >= 10 && tl / Math.max(ts, 0.5) > 3.3) {
            ts = best(fn, small, 11);
            tl = best(fn, large, 11);
          }
          const label = `${field} ${shape} c=${JSON.stringify(c)}`;
          if (tl > slowest.ms) slowest = { ms: tl, label };
          if (tl >= 100) failures.push(`${label} took ${tl.toFixed(1)} ms`);
          if (tl >= 10 && tl / Math.max(ts, 0.5) > 3.3) {
            failures.push(
              `${label} grew ${(tl / ts).toFixed(1)}x for 2x input (${tl.toFixed(1)} ms)`,
            );
          }
        }
      }
    }
    process.stdout.write(`scrub fuzz slowest: ${slowest.label} ${slowest.ms.toFixed(1)} ms\n`);
    expect(failures).toEqual([]);
  });
});
