import { createServer } from 'node:net';
import type { Server } from 'node:net';
import type { AddressInfo } from 'node:net';
import { MailError } from './mail-transport';
import { SmtpDevMailTransport } from './smtp-dev-mail.transport';

// A minimal plain-SMTP sink standing in for Mailpit. Records commands, never real mail.
function startSink(): Promise<{ server: Server; port: number; data: string[] }> {
  const data: string[] = [];
  const server = createServer((socket) => {
    let inData = false;
    let tail = '';
    socket.write('220 sink ESMTP\r\n');
    socket.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8');
      data.push(text);
      if (inData) {
        // The end-of-data marker can be split across TCP chunks: look at the joined tail.
        const seen = tail + text;
        if (seen.includes('\r\n.\r\n')) {
          inData = false;
          tail = '';
          socket.write('250 queued\r\n');
        } else {
          tail = seen.slice(-8);
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
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, port: (server.address() as AddressInfo).port, data });
    });
  });
}

describe('DL-54 SmtpDevMailTransport (plain SMTP, no auth, no TLS)', () => {
  let sink: Awaited<ReturnType<typeof startSink>>;
  beforeAll(async () => {
    sink = await startSink();
  });
  afterAll(() => {
    sink.server.close();
  });

  it('DL-54/FR-102: delivers a message over plain SMTP without STARTTLS or AUTH', async () => {
    const t = new SmtpDevMailTransport({
      host: '127.0.0.1',
      port: sink.port,
      fromAddress: 'no-reply@codeproctor.local',
    });
    await t.send({ to: 'cand@example.com', subject: 'Hi', html: '<p>x</p>', text: 'x' });
    const wire = sink.data.join('');
    expect(wire).toContain('RCPT TO:<cand@example.com>');
    expect(wire).not.toMatch(/STARTTLS|AUTH /i);
  });

  it('DL-54: an invalid recipient is a permanent MailError', async () => {
    const t = new SmtpDevMailTransport({
      host: '127.0.0.1',
      port: sink.port,
      fromAddress: 'a@b.c',
    });
    await expect(
      t.send({ to: 'not an address', subject: 's', html: 'h', text: 't' }),
    ).rejects.toMatchObject({ permanent: true });
  });

  it('DL-54: a refused connection throws a scrubbed MailError without the address', async () => {
    const t = new SmtpDevMailTransport({ host: '127.0.0.1', port: 1, fromAddress: 'a@b.c' });
    const err: unknown = await t
      .send({ to: 'secret-person@example.com', subject: 's', html: 'h', text: 'OTP 123456' })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MailError);
    expect(String(err)).not.toContain('secret-person');
    expect(String(err)).not.toContain('123456');
  });
});
