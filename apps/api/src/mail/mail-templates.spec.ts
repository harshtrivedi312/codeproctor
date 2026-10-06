import { escapeHtml, renderMail, stripHeader } from './mail-templates';
import type { EmailJob } from './mail-templates';

const URL_WITH_TOKEN = 'https://app.example.com/candidate/start#token=abc123SECRET';

const allJobs: EmailJob[] = [
  { template: 'password-reset', to: 'a@example.com', params: { resetUrl: URL_WITH_TOKEN } },
  { template: 'staff-invite', to: 'a@example.com', params: { inviteUrl: URL_WITH_TOKEN } },
  {
    template: 'staff-account-locked',
    to: 'a@example.com',
    params: { lockedEmail: 'x@example.com', lockedName: 'X', minutes: 15 },
  },
  {
    template: 'invitation',
    to: 'a@example.com',
    params: {
      inviteUrl: URL_WITH_TOKEN,
      windowStartsAt: '2026-10-07T09:00:00.000Z',
      windowEndsAt: '2026-10-14T09:00:00.000Z',
    },
  },
  {
    template: 'reminder',
    to: 'a@example.com',
    params: { inviteUrl: URL_WITH_TOKEN, windowEndsAt: '2026-10-14T09:00:00.000Z' },
  },
  { template: 'results', to: 'a@example.com', params: {} },
  { template: 'otp', to: 'a@example.com', params: { otp: '482913', minutes: 10 } },
  {
    template: 'otp-lockout',
    to: 'r@example.com',
    params: { candidateEmail: 'c@example.com', minutes: 30 },
  },
  { template: 'consent-copy', to: 'a@example.com', params: { pdfKey: 'consents/x/y.pdf' } },
  {
    template: 'erasure-delayed',
    to: 'a@example.com',
    params: { delayedUntil: '2026-11-01T00:00:00.000Z' },
  },
];

function pick(id: EmailJob['template']): EmailJob {
  const j = allJobs.find((x) => x.template === id);
  if (!j) throw new Error('missing');
  return j;
}

describe('FR-303 / C-31 mail templates', () => {
  it.each(allJobs.map((j) => [j.template, j] as const))(
    'C-31: %s has a subject without URL or token, a non-empty html and a plain-text part',
    (_id, job) => {
      const m = renderMail(job);
      expect(m.subject).not.toMatch(/https?:|token|SECRET|\d{6}/);
      expect(m.subject).not.toMatch(/[\r\n]/);
      expect(m.html.length).toBeGreaterThan(0);
      expect(m.text.length).toBeGreaterThan(0);
      expect(m.text).not.toMatch(/<[a-z]/i);
    },
  );

  it('FR-303: the invitation carries the link and the window in both parts', () => {
    const m = renderMail(pick('invitation'));
    expect(m.text).toContain(URL_WITH_TOKEN);
    expect(m.html).toContain(URL_WITH_TOKEN);
    expect(m.text).toContain('2026-10-07 09:00 UTC');
    expect(m.text).toContain('2026-10-14 09:00 UTC');
  });

  it('C-31: escapes <, >, &, double and single quotes in every interpolated value', () => {
    expect(escapeHtml(`<a href="x" onclick='y'>&`)).toBe(
      '&lt;a href=&quot;x&quot; onclick=&#39;y&#39;&gt;&amp;',
    );
    const m = renderMail({
      template: 'staff-account-locked',
      to: 'a@example.com',
      params: {
        lockedEmail: 'x@example.com',
        lockedName: `<script>alert("x")</script> & 'o'`,
        minutes: 5,
      },
    });
    expect(m.html).not.toContain('<script>');
    expect(m.html).toContain('&lt;script&gt;');
    expect(m.html).toContain('&amp;');
    const link = renderMail({
      template: 'staff-invite',
      to: 'a@example.com',
      params: { inviteUrl: 'https://x.example.com/a?b=1&c="2"' },
    });
    expect(link.html).toContain('href="https://x.example.com/a?b=1&amp;c=&quot;2&quot;"');
  });

  it('C-31: CR and LF are stripped from header fields and names', () => {
    expect(stripHeader('Hi\r\nBcc: evil@example.com')).toBe('Hi Bcc: evil@example.com');
    expect(stripHeader('a\nb\rc\u0000d')).toBe('a b c d');
    const m = renderMail({
      template: 'staff-account-locked',
      to: 'a@example.com',
      params: {
        lockedEmail: 'x@example.com',
        lockedName: 'Eve\r\nBcc: evil@example.com',
        minutes: 5,
      },
    });
    expect(m.subject).not.toMatch(/[\r\n]/);
    expect(m.text).not.toMatch(/Eve\r?\nBcc/);
  });

  it('C-31: consent-copy attaches by object key, never carries bytes or the key in the body', () => {
    const m = renderMail(pick('consent-copy'));
    expect(m.attachmentKey).toBe('consents/x/y.pdf');
    expect(m.html + m.text + m.subject).not.toContain('consents/x/y.pdf');
  });

  it('FR-303: the results mail is a notification only', () => {
    const m = renderMail(pick('results'));
    expect(m.text).not.toMatch(/score|verdict|pass|fail/i);
  });

  it('C-31: only https links are accepted (http only when allowed); javascript: and data: never', () => {
    const withUrl = (inviteUrl: string): EmailJob => ({
      template: 'staff-invite',
      to: 'a@example.com',
      params: { inviteUrl },
    });
    expect(() => renderMail(withUrl('https://app.example.com/x'))).not.toThrow();
    expect(() => renderMail(withUrl('http://localhost:3000/x'))).toThrow('unsafe link');
    expect(() => renderMail(withUrl('http://localhost:3000/x'), { allowHttp: true })).not.toThrow();
    for (const bad of [
      'javascript:alert(1)',
      'data:text/html,x',
      'JaVaScRiPt:x',
      '//evil.com',
      'not a url',
      '',
    ]) {
      expect(() => renderMail(withUrl(bad), { allowHttp: true })).toThrow('unsafe link');
    }
    expect(() =>
      renderMail({
        template: 'password-reset',
        to: 'a@example.com',
        params: { resetUrl: 'javascript:1' },
      }),
    ).toThrow('unsafe link');
  });

  it('C-31: stripHeader removes C1 controls, U+0085, U+2028 and U+2029', () => {
    expect(stripHeader('a\u0085b\u2028c\u2029d\u0080e\u009ff\u007fg')).toBe('a b c d e f g');
  });
});
