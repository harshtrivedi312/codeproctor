import { scrubClientText, scrubClientUrl } from './scrub-client-text';

const JWT =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';

describe('scrubClientText (NFR-04, C-32)', () => {
  it('NFR-04: redacts email addresses', () => {
    const out = scrubClientText('Failed for jane.doe+test@mail.example.com now');
    expect(out).not.toContain('jane');
    expect(out).not.toContain('example.com');
    expect(out).toContain('Failed for [REDACTED] now');
  });

  it('NFR-04: keeps text that only looks like an email', () => {
    expect(scrubClientText('a @ b and user@localhost')).toBe('a @ b and user@localhost');
  });

  it('NFR-04: redacts JWTs and Bearer tokens', () => {
    const out = scrubClientText(`token ${JWT} and Authorization: Bearer abc.def-ghi_123`);
    expect(out).not.toContain('eyJ');
    expect(out).not.toContain('abc.def');
    expect(out).toContain('Bearer [REDACTED]');
  });

  it('NFR-04: redacts long opaque tokens and hex strings', () => {
    const opaque = 'Ab3dE6gH9jK2mN5pQ8sT1vW4';
    const hex = 'deadbeef'.repeat(4);
    const out = scrubClientText(`id ${opaque} hash ${hex} short abc123`);
    expect(out).not.toContain(opaque);
    expect(out).not.toContain(hex);
    expect(out).toContain('short abc123');
  });

  it('NFR-04: redacts 6 to 8 digit codes next to otp, code, token or pin', () => {
    expect(scrubClientText('otp 123456 failed')).toBe('otp [REDACTED] failed');
    expect(scrubClientText('code: 98765432')).toBe('code: [REDACTED]');
    expect(scrubClientText('123456 is your pin')).toBe('[REDACTED] is your pin');
    expect(scrubClientText('status 123456 ok')).toBe('status 123456 ok');
    expect(scrubClientText('code 12345')).toBe('code 12345');
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

  it('NFR-04: redacts object keys', () => {
    expect(scrubClientText('upload failed for org/7/media/s9/chunk-1.webm')).toBe(
      'upload failed for [REDACTED_KEY]',
    );
    expect(scrubClientText('see s3://private-bucket/a/b')).toBe('see [REDACTED_URL]');
  });

  it('NFR-04: strips query strings and fragments from URLs in text', () => {
    const out = scrubClientText('at https://app.example.test/candidate/x?invite=abc&y=1#frag:10:5');
    expect(out).toBe('at https://app.example.test/candidate/x?[REDACTED]');
    expect(scrubClientUrl('https://app.example.test/p?a=1#z')).toBe('https://app.example.test/p');
    expect(scrubClientUrl('/p#frag')).toBe('/p');
  });

  it('NFR-04: redacts password pairs', () => {
    const out = scrubClientText('login failed password=hunter2 and "password": "swordfish"');
    expect(out).not.toContain('hunter2');
    expect(out).not.toContain('swordfish');
  });

  it('NFR-04: truncates after scrubbing and never splits a surrogate pair', () => {
    expect(scrubClientText('x'.repeat(50), 10)).toHaveLength(10);
    const out = scrubClientText('ab😀😀', 3);
    expect(out).toBe('ab');
  });

  it('NFR-04: handles unicode and empty input', () => {
    expect(scrubClientText('')).toBe('');
    expect(scrubClientText('Fehler: ungültig 日本語 ✓')).toBe('Fehler: ungültig 日本語 ✓');
  });

  it('NFR-04: runs in linear time on adversarial input (no catastrophic backtracking)', () => {
    const inputs = [
      'a'.repeat(100_000),
      'a@'.repeat(50_000),
      '@'.repeat(100_000),
      'a.'.repeat(50_000),
      'code 12345 '.repeat(10_000),
      'password'.repeat(12_000),
      ' '.repeat(100_000),
      'https://x/y?'.repeat(8_000),
      '1234567 '.repeat(12_000),
      `${'a'.repeat(23)}-`.repeat(4_000),
    ];
    for (const input of inputs) {
      const start = performance.now();
      scrubClientText(input);
      expect(performance.now() - start).toBeLessThan(100);
    }
  });
});
