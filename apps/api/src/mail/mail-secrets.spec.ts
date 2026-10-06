import { InProcessEmailQueue } from './in-process-email-queue';
import type { QueueLogger } from './in-process-email-queue';
import { MailProcessor } from './mail-processor';
import { MailError, MailTransport, ObjectReader } from './mail-transport';
import type { OutgoingMail } from './mail-transport';
import { QueuedMailPort } from './queued-mail.port';

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
    expectClean(JSON.stringify(Object.entries(r.queue)));
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
    expectClean(JSON.stringify(Object.entries(r.queue)));
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
});
