import { createServer as createHttp } from 'node:http';
import type { Server as HttpServer } from 'node:http';
import { createServer as createTcp } from 'node:net';
import type { AddressInfo, Server as TcpServer } from 'node:net';
import { DirectMailSender } from '../mail/direct-mail.sender';
import { MailError } from '../mail/mail-transport';
import type { MailTransport, OutgoingMail } from '../mail/mail-transport';
import { SesMailTransport } from '../mail/ses-mail.transport';
import { SmtpDevMailTransport } from '../mail/smtp-dev-mail.transport';
import { MailBackedCandidateMailPort } from './mail-backed-candidate-mail.port';

// FR-106 (candidate OTP, TC-007 lockout notice), FR-401 / C-07 (consent copy), ADR 0003 section 6.
const CODE = '482916';
const TO = 'planted.candidate@example.org';
const PDF = Buffer.from('%PDF-1.4 planted-pdf-body');

function rig(transport: MailTransport | null) {
  const lines: string[] = [];
  const spies = [
    jest
      .spyOn(process.stdout, 'write')
      .mockImplementation((c: unknown) => (lines.push(String(c)), true)),
    jest
      .spyOn(process.stderr, 'write')
      .mockImplementation((c: unknown) => (lines.push(String(c)), true)),
  ];
  return {
    port: new MailBackedCandidateMailPort(new DirectMailSender(transport)),
    lines,
    restore: () => spies.forEach((s) => s.mockRestore()),
  };
}

function first(sent: OutgoingMail[]): OutgoingMail {
  const m = sent[0];
  if (!m) throw new Error('nothing was sent');
  return m;
}

function capture(): { sent: OutgoingMail[]; transport: MailTransport } {
  const sent: OutgoingMail[] = [];
  return { sent, transport: { send: (m) => (sent.push(m), Promise.resolve()) } };
}

describe('MailBackedCandidateMailPort (FR-106, FR-401)', () => {
  afterEach(() => jest.restoreAllMocks());

  it('FR-106: the OTP mail carries the code and test name, escaped, and the code never reaches logs', async () => {
    const { sent, transport } = capture();
    const r = rig(transport);
    await r.port.sendOtp(TO, {
      code: CODE,
      testName: 'Algo <b>1</b> & "co"',
      expiresInMinutes: 10,
    });
    r.restore();
    expect(sent).toHaveLength(1);
    expect(first(sent).to).toBe(TO);
    expect(first(sent).subject).toBe('Your verification code');
    expect(first(sent).text).toContain(CODE);
    expect(first(sent).html).toContain(CODE);
    expect(first(sent).html).toContain('Algo &lt;b&gt;1&lt;/b&gt; &amp; &quot;co&quot;');
    expect(first(sent).html).not.toContain('<b>1</b>');
    expect(first(sent).attachment).toBeUndefined();
    for (const l of r.lines) expect(l).not.toContain(CODE);
  });

  it('TC-007: the lockout mail names candidate and test, escaped, and logs nothing', async () => {
    const { sent, transport } = capture();
    const r = rig(transport);
    await r.port.sendOtpLockout(TO, {
      candidateName: 'Eve <script>',
      candidateEmail: 'eve@example.org',
      testName: 'Backend',
      blockedMinutes: 30,
    });
    r.restore();
    expect(first(sent).subject).toBe('A candidate link was blocked');
    expect(first(sent).text).toContain('Eve <script> (eve@example.org)');
    expect(first(sent).text).toContain('30 minutes');
    expect(first(sent).html).toContain('Eve &lt;script&gt;');
    expect(first(sent).html).not.toContain('<script>');
    for (const l of r.lines) {
      expect(l).not.toContain('eve@example.org');
      expect(l).not.toContain(TO);
    }
  });

  it('FR-401: the consent copy attaches the PDF under the given filename and logs nothing', async () => {
    const { sent, transport } = capture();
    const r = rig(transport);
    await r.port.sendConsentCopy(TO, {
      pdf: PDF,
      filename: 'consent-v3.pdf',
      documentVersion: 'v3',
      signedAt: new Date('2026-10-01T10:00:00Z'),
    });
    r.restore();
    expect(first(sent).subject).toBe('Your signed consent copy');
    expect(first(sent).attachment).toEqual({
      filename: 'consent-v3.pdf',
      contentType: 'application/pdf',
      content: PDF,
    });
    expect(first(sent).text).toContain('v3');
    expect(first(sent).text).toContain('2026-10-01 10:00 UTC');
    for (const l of r.lines) {
      expect(l).not.toContain('planted-pdf-body');
      expect(l).not.toContain(TO);
    }
  });

  it('FR-106: a transport failure rejects, so OTP_SENT / copy_emailed_at are not recorded', async () => {
    const failing: MailTransport = {
      send: () => Promise.reject(new MailError('mail transport failed', 'Error')),
    };
    const { port } = rig(failing);
    await expect(
      port.sendOtp(TO, { code: CODE, testName: 'T', expiresInMinutes: 10 }),
    ).rejects.toBeInstanceOf(MailError);
    await expect(
      port.sendOtpLockout(TO, {
        candidateName: 'a',
        candidateEmail: 'a@b.c',
        testName: 'T',
        blockedMinutes: 30,
      }),
    ).rejects.toBeInstanceOf(MailError);
    await expect(
      port.sendConsentCopy(TO, {
        pdf: PDF,
        filename: 'c.pdf',
        documentVersion: 'v1',
        signedAt: new Date(),
      }),
    ).rejects.toBeInstanceOf(MailError);
  });

  it('FR-106: with no transport bound (EMAIL_PROVIDER=noop) every method rejects instead of pretending', async () => {
    const { port } = rig(null);
    await expect(
      port.sendOtp(TO, { code: CODE, testName: 'T', expiresInMinutes: 10 }),
    ).rejects.toBeInstanceOf(MailError);
  });

  it('FR-401: an empty PDF is refused rather than mailed as "attached"', async () => {
    const { transport, sent } = capture();
    const { port } = rig(transport);
    await expect(
      port.sendConsentCopy(TO, {
        pdf: Buffer.alloc(0),
        filename: 'c.pdf',
        documentVersion: 'v1',
        signedAt: new Date(),
      }),
    ).rejects.toBeInstanceOf(MailError);
    expect(sent).toHaveLength(0);
  });
});

describe('MailBackedCandidateMailPort reaches both transports (FR-106, DL-54, C-31)', () => {
  let smtp: TcpServer;
  let smtpPort: number;
  const smtpData: string[] = [];
  let ses: HttpServer;
  let sesEndpoint: string;
  let sesHits = 0;
  const saved: Record<string, string | undefined> = {};

  beforeAll(async () => {
    for (const k of ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY']) saved[k] = process.env[k];
    process.env.AWS_ACCESS_KEY_ID = 'AKIAFAKEFAKEFAKEFAKE';
    process.env.AWS_SECRET_ACCESS_KEY = 'fake-secret-for-tests-only';
    smtp = createTcp((socket) => {
      let inData = false;
      socket.write('220 sink ESMTP\r\n');
      socket.on('data', (chunk: Buffer) => {
        const text = chunk.toString('utf8');
        smtpData.push(text);
        if (inData) {
          if (text.includes('\r\n.\r\n')) {
            inData = false;
            socket.write('250 queued\r\n');
          }
          return;
        }
        for (const line of text.split('\r\n').filter(Boolean)) {
          const cmd = line.slice(0, 4).toUpperCase();
          if (cmd === 'EHLO') socket.write('250-sink\r\n250 8BITMIME\r\n');
          else if (cmd === 'DATA') {
            inData = true;
            socket.write('354 go\r\n');
          } else if (cmd === 'QUIT') socket.end('221 bye\r\n');
          else socket.write('250 ok\r\n');
        }
      });
    });
    await new Promise<void>((res) => smtp.listen(0, '127.0.0.1', res));
    smtpPort = (smtp.address() as AddressInfo).port;
    ses = createHttp((req, res) => {
      req.resume();
      req.on('end', () => {
        sesHits++;
        res.setHeader('content-type', 'application/json');
        res.end('{"MessageId":"stub"}');
      });
    });
    await new Promise<void>((res) => ses.listen(0, '127.0.0.1', res));
    sesEndpoint = `http://127.0.0.1:${(ses.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise((r) => smtp.close(r));
    await new Promise((r) => ses.close(r));
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it('FR-106: smtp-dev delivers the OTP and the consent PDF to the SMTP sink; a dead port rejects', async () => {
    const t = new SmtpDevMailTransport({
      host: '127.0.0.1',
      port: smtpPort,
      fromAddress: 'no-reply@codeproctor.local',
    });
    const port = new MailBackedCandidateMailPort(new DirectMailSender(t));
    await port.sendOtp(TO, { code: CODE, testName: 'T', expiresInMinutes: 10 });
    await port.sendConsentCopy(TO, {
      pdf: PDF,
      filename: 'consent.pdf',
      documentVersion: 'v1',
      signedAt: new Date(),
    });
    const all = smtpData.join('');
    expect(all).toContain('RCPT TO');
    expect(all).toContain('consent.pdf');
    const dead = new MailBackedCandidateMailPort(
      new DirectMailSender(
        new SmtpDevMailTransport({ host: '127.0.0.1', port: 1, fromAddress: 'a@b.c' }),
      ),
    );
    await expect(
      dead.sendOtp(TO, { code: CODE, testName: 'T', expiresInMinutes: 10 }),
    ).rejects.toBeInstanceOf(MailError);
  });

  it('FR-106: SES delivers the OTP and the consent copy through the same port', async () => {
    const t = new SesMailTransport({
      region: 'eu-west-1',
      fromAddress: 'no-reply@example.org',
      endpoint: sesEndpoint,
    });
    const port = new MailBackedCandidateMailPort(new DirectMailSender(t));
    await port.sendOtp(TO, { code: CODE, testName: 'T', expiresInMinutes: 10 });
    await port.sendConsentCopy(TO, {
      pdf: PDF,
      filename: 'consent.pdf',
      documentVersion: 'v1',
      signedAt: new Date(),
    });
    expect(sesHits).toBe(2);
  });
});
