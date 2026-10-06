import { createServer } from 'node:http';
import type { IncomingHttpHeaders, Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { MailError } from './mail-transport';
import { SesMailTransport } from './ses-mail.transport';

interface Captured {
  url: string;
  method: string;
  headers: IncomingHttpHeaders;
  body: Record<string, unknown>;
}

describe('C-31 SesMailTransport against a local stub (never real AWS)', () => {
  let server: Server;
  let endpoint: string;
  let seen: Captured[];
  let status = 200;
  const saved: Record<string, string | undefined> = {};

  beforeAll(async () => {
    // Fake static credentials, TEST ONLY. The transport itself has no key option.
    for (const k of ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN']) {
      saved[k] = process.env[k];
    }
    process.env.AWS_ACCESS_KEY_ID = 'AKIAFAKEFAKEFAKEFAKE';
    process.env.AWS_SECRET_ACCESS_KEY = 'fake-secret-for-tests-only';
    delete process.env.AWS_SESSION_TOKEN;
    server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        seen.push({
          url: req.url ?? '',
          method: req.method ?? '',
          headers: req.headers,
          body: JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>,
        });
        res.setHeader('content-type', 'application/json');
        res.statusCode = status;
        res.end(
          status === 200
            ? JSON.stringify({ MessageId: 'stub-1' })
            : JSON.stringify({ message: 'rejected victim@example.com TOKENBODY' }),
        );
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    await new Promise<void>((r) => server.close(() => r()));
  });
  beforeEach(() => {
    seen = [];
    status = 200;
  });

  const make = (extra: object = {}): SesMailTransport =>
    new SesMailTransport({
      region: 'us-east-1',
      fromAddress: 'no-reply@example.com',
      endpoint,
      ...extra,
    });

  it('C-31: normal mail is a Simple SendEmail in the configured region with a fixed From', async () => {
    await make({ configurationSet: 'cp-set' }).send({
      to: 'cand@example.com',
      subject: 'Your verification code',
      html: '<p>hi</p>',
      text: 'hi',
    });
    expect(seen).toHaveLength(1);
    const r = seen[0];
    if (!r) throw new Error('no request');
    expect(r.method).toBe('POST');
    expect(r.url).toBe('/v2/email/outbound-emails');
    expect(String(r.headers.authorization)).toContain('/us-east-1/ses/aws4_request');
    expect(r.body['FromEmailAddress']).toBe('"CodeProctor" <no-reply@example.com>');
    expect(r.body['Destination']).toEqual({ ToAddresses: ['cand@example.com'] });
    expect(r.body['ConfigurationSetName']).toBe('cp-set');
    const simple = (r.body['Content'] as { Simple: { Subject: { Data: string }; Body: object } })
      .Simple;
    expect(simple.Subject.Data).toBe('Your verification code');
    expect(simple.Body).toHaveProperty('Text');
    expect(simple.Body).toHaveProperty('Html');
  });

  it('C-31: the region comes from config', async () => {
    await make({ region: 'eu-west-1' }).send({
      to: 'a@example.com',
      subject: 's',
      html: 'h',
      text: 't',
    });
    expect(String(seen[0]?.headers.authorization)).toContain('/eu-west-1/ses/aws4_request');
  });

  it('FR-303 / D-17: an attachment goes as Raw MIME with the PDF and a stripped subject', async () => {
    const pdf = Buffer.from('%PDF-1.4 test pdf bytes');
    await make().send({
      to: 'cand@example.com',
      subject: 'Your signed consent copy\r\nBcc: evil@example.com',
      html: '<p>copy</p>',
      text: 'copy',
      attachment: { filename: 'consent.pdf', contentType: 'application/pdf', content: pdf },
    });
    const content = seen[0]?.body['Content'] as { Raw: { Data: string } };
    expect(seen[0]?.body['Content']).not.toHaveProperty('Simple');
    const mime = Buffer.from(content.Raw.Data, 'base64').toString('utf8');
    expect(mime).toMatch(/^From: "?CodeProctor"? <no-reply@example.com>/m);
    expect(mime).toMatch(/^To: cand@example.com/m);
    expect(mime).toMatch(/^Subject: Your signed consent copy Bcc: evil@example.com/m);
    expect(mime).not.toMatch(/^Bcc:/m);
    expect(mime).toContain('Content-Type: application/pdf');
    expect(mime).toContain('filename=consent.pdf');
    expect(mime).toContain(pdf.toString('base64'));
    expect(mime).toContain('multipart/');
  });

  it('C-31: a recipient with CR/LF or extra addresses is refused without echoing it', async () => {
    for (const to of [
      'a@example.com\r\nBcc: x@example.com',
      'a@example.com, b@example.com',
      'nope',
    ]) {
      let caught: unknown;
      try {
        await make().send({ to, subject: 's', html: 'h', text: 't' });
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(MailError);
      expect(String(caught)).not.toContain('example.com');
    }
    expect(seen).toHaveLength(0);
  });

  it('C-31: an SES error is scrubbed to a class name, no address or body', async () => {
    status = 400;
    let caught: unknown;
    try {
      await make().send({ to: 'victim@example.com', subject: 's', html: 'h', text: 't' });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(MailError);
    const text = String(caught) + JSON.stringify(caught) + String((caught as Error).stack);
    expect(text).not.toContain('victim@example.com');
    expect(text).not.toContain('TOKENBODY');
    expect((caught as Error & { cause?: unknown }).cause).toBeUndefined();
  });
});
