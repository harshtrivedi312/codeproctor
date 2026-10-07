import { DirectMailSender } from './direct-mail.sender';
import { InProcessEmailQueue } from './in-process-email-queue';
import type { QueueLogger } from './in-process-email-queue';
import { MailProcessor } from './mail-processor';
import { MAX_ATTACHMENT_BYTES, MailError, MailTransport, ObjectReader } from './mail-transport';
import type { OutgoingMail } from './mail-transport';
import type { EmailJob } from './mail-templates';
import { QueuedMailPort } from './queued-mail.port';
import { SmtpDevMailTransport } from './smtp-dev-mail.transport';

// Unique planted values: none of them may show up in any log line, thrown error or in-memory
// record after a send, whether it succeeds or finally fails (CLAUDE.md, ADR 0003 section 6, C-31).
const OTP = '73519846';
const URL = 'https://app.example.com/candidate/start#token=PLANTEDTOKEN9d8f7a';
const TO = 'planted.recipient@example.org';
const KEY = 'consents/PLANTEDKEY-0042/signed.pdf';
const PLANTED = [OTP, 'PLANTEDTOKEN9d8f7a', TO, 'PLANTEDKEY-0042', 'planted.recipient'];

class FakeReader extends ObjectReader {
  read(key: string): Promise<Buffer> {
    return key === KEY
      ? Promise.resolve(Buffer.from('%PDF-planted'))
      : Promise.reject(new Error(key));
  }
}

function rig(transport: MailTransport) {
  const lines: string[] = [];
  const push = (m: string): void => void lines.push(m);
  const logger: QueueLogger = { log: push, warn: push, error: push };
  const out: string[] = [];
  const spies = [
    jest
      .spyOn(process.stdout, 'write')
      .mockImplementation((c: unknown) => (out.push(String(c)), true)),
    jest
      .spyOn(process.stderr, 'write')
      .mockImplementation((c: unknown) => (out.push(String(c)), true)),
  ];
  const queue = new InProcessEmailQueue(new MailProcessor(transport, new FakeReader()).handle, {
    maxAttempts: 2,
    baseBackoffMs: 1,
    logger,
  });
  return {
    queue,
    port: new QueuedMailPort(queue),
    lines,
    out,
    restore: () => spies.forEach((s) => s.mockRestore()),
  };
}

async function sendAll(port: QueuedMailPort): Promise<void> {
  await port.sendOtp(TO, { otp: OTP, minutes: 10 });
  await port.sendInvitation(TO, {
    inviteUrl: URL,
    windowStartsAt: new Date(),
    windowEndsAt: new Date(),
  });
  await port.sendConsentCopy(TO, { pdfKey: KEY });
}

/** Every field of the queue, with Map contents spread so held jobs would show up. */
function heldState(q: InProcessEmailQueue): string {
  const fields: Array<[string, unknown]> = Object.entries(q);
  const shown: unknown[] = fields.map(([k, v]): unknown => {
    const held: unknown = v instanceof Map ? Array.from((v as Map<unknown, unknown>).values()) : v;
    return [k, held];
  });
  return JSON.stringify(shown);
}

function expectClean(haystack: string): void {
  for (const p of PLANTED) expect(haystack).not.toContain(p);
}

describe('C-31 planted secrets stay out of logs, errors and records', () => {
  it('C-31: success path logs only template id and job id', async () => {
    const sent: OutgoingMail[] = [];
    const t: MailTransport = {
      send: (m) => (sent.push(m), Promise.resolve()),
    };
    const r = rig(t);
    try {
      await sendAll(r.port);
      await r.queue.idle();
    } finally {
      r.restore();
    }
    expect(sent).toHaveLength(3);
    expect(sent[2]?.attachment?.content.toString()).toBe('%PDF-planted');
    expect(r.lines.length).toBe(3);
    expectClean(r.lines.join('\n') + r.out.join(''));
    expect(r.queue.size()).toBe(0);
    expectClean(heldState(r.queue));
  });

  it('C-31: final failure (transport error carrying every secret) leaks nothing and keeps no record', async () => {
    const leaky = new Error(`SES said no to ${TO} body=${OTP} ${URL} key=${KEY}`);
    leaky.name = 'LeakyError';
    const t: MailTransport = { send: () => Promise.reject(leaky) };
    const r = rig(t);
    try {
      await sendAll(r.port);
      await r.queue.idle();
    } finally {
      r.restore();
    }
    expect(r.lines.some((l) => l.includes('dropped after 2 attempts'))).toBe(true);
    expectClean(r.lines.join('\n') + r.out.join(''));
    expect(r.queue.size()).toBe(0);
    expectClean(heldState(r.queue));
  });

  it('C-31: a failing attachment read is scrubbed to a fixed error without the key', async () => {
    const processor = new MailProcessor(
      { send: () => Promise.resolve() },
      { read: () => Promise.reject(new Error(`no such key ${KEY}`)) },
    );
    let caught: unknown;
    try {
      await processor.handle({ template: 'consent-copy', to: TO, params: { pdfKey: KEY } });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(MailError);
    expectClean(String(caught) + JSON.stringify(caught) + String((caught as Error).stack));
  });

  it('FU-BE-89: the port reports failed when the queue refuses', async () => {
    const full = new QueuedMailPort({ enqueue: () => Promise.resolve('rejected') });
    expect(await full.sendOtp(TO, { otp: OTP, minutes: 10 })).toBe('failed');
    const broken = new QueuedMailPort({ enqueue: () => Promise.reject(new Error(TO)) });
    expect(await broken.sendOtp(TO, { otp: OTP, minutes: 10 })).toBe('failed');
  });

  it('FU-BE-89: the void methods throw a fixed MailError when the queue refuses', async () => {
    const full = new QueuedMailPort({ enqueue: () => Promise.resolve('rejected') });
    for (const call of [
      () => full.sendPasswordReset(TO, URL),
      () => full.sendStaffInvite(TO, URL),
      () => full.sendStaffAccountLocked(TO, { email: TO, name: 'n', minutes: 1 }),
    ]) {
      let caught: unknown;
      try {
        await call();
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(MailError);
      expectClean(String(caught) + JSON.stringify(caught));
    }
  });

  it('D-17: consent-copy without a key is refused by the port and fails in the processor', async () => {
    const enqueued: unknown[] = [];
    const port = new QueuedMailPort({
      enqueue: (j) => (enqueued.push(j), Promise.resolve('accepted')),
    });
    expect(await port.sendConsentCopy(TO, { pdfKey: '' })).toBe('failed');
    expect(enqueued).toHaveLength(0);
    const sent: OutgoingMail[] = [];
    const processor = new MailProcessor(
      { send: (m) => (sent.push(m), Promise.resolve()) },
      new FakeReader(),
    );
    await expect(
      processor.handle({ template: 'consent-copy', to: TO, params: { pdfKey: '' } }),
    ).rejects.toMatchObject({ message: 'attachment key missing', permanent: true });
    expect(sent).toHaveLength(0);
  });

  it('D-17: an oversized or empty attachment is refused with a fixed permanent error', async () => {
    const sent: OutgoingMail[] = [];
    const t: MailTransport = { send: (m) => (sent.push(m), Promise.resolve()) };
    const big = new MailProcessor(t, {
      read: () => Promise.resolve(Buffer.alloc(MAX_ATTACHMENT_BYTES + 1)),
    });
    await expect(
      big.handle({ template: 'consent-copy', to: TO, params: { pdfKey: KEY } }),
    ).rejects.toMatchObject({ message: 'attachment too large', permanent: true });
    const empty = new MailProcessor(t, { read: () => Promise.resolve(Buffer.alloc(0)) });
    await expect(
      empty.handle({ template: 'consent-copy', to: TO, params: { pdfKey: KEY } }),
    ).rejects.toMatchObject({ message: 'attachment empty' });
    const exact = new MailProcessor(t, {
      read: () => Promise.resolve(Buffer.alloc(MAX_ATTACHMENT_BYTES, 1)),
    });
    await exact.handle({ template: 'consent-copy', to: TO, params: { pdfKey: KEY } });
    expect(sent).toHaveLength(1);
  });

  it('C-31: the reader is asked for at most the attachment cap', async () => {
    let asked = 0;
    const p = new MailProcessor(
      { send: () => Promise.resolve() },
      {
        read: (_k: string, max: number) => ((asked = max), Promise.resolve(Buffer.from('%PDF'))),
      },
    );
    await p.handle({ template: 'consent-copy', to: TO, params: { pdfKey: KEY } });
    expect(asked).toBe(MAX_ATTACHMENT_BYTES);
  });

  it('C-31: the direct candidate templates (otp, otp-lockout, consent-copy) leak nothing on a failed send', async () => {
    const real = new SmtpDevMailTransport({ host: '127.0.0.1', port: 1, fromAddress: 'a@b.c' });
    const sender = new DirectMailSender(real);
    const jobs: EmailJob[] = [
      { template: 'otp', to: TO, params: { otp: OTP, minutes: 10 } },
      {
        template: 'otp-lockout',
        to: TO,
        params: { candidateEmail: TO, candidateName: 'PLANTEDNAME', minutes: 30 },
      },
      { template: 'consent-copy', to: TO, params: { documentVersion: 'v1' } },
    ];
    const out: string[] = [];
    const spies = [
      jest
        .spyOn(process.stdout, 'write')
        .mockImplementation((c: unknown) => (out.push(String(c)), true)),
      jest
        .spyOn(process.stderr, 'write')
        .mockImplementation((c: unknown) => (out.push(String(c)), true)),
    ];
    const caught: unknown[] = [];
    try {
      for (const job of jobs) {
        try {
          await sender.send(job, { filename: 'c.pdf', content: Buffer.from('%PDF-planted') });
        } catch (e) {
          caught.push(e);
        }
      }
    } finally {
      spies.forEach((s) => s.mockRestore());
    }
    expect(caught).toHaveLength(3);
    for (const e of caught) {
      expect(e).toBeInstanceOf(MailError);
      expectClean(String(e) + JSON.stringify(e) + String((e as Error).stack));
      expect(String(e)).not.toContain('PLANTEDNAME');
      expect(String(e)).not.toContain('PLANTEDTEST');
    }
    expectClean(out.join(''));
  });
});
