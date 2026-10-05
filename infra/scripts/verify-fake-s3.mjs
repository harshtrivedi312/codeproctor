// A tiny in-memory S3 server for the backup tests (DB-07). Path-style only, no auth, no
// multipart: enough for `aws s3 cp` of small files, head-object, list-objects-v2 and delete-object.
// Not a test file. Binds to 127.0.0.1 on a random port.
import { createServer } from 'node:http';

const xml = (body) => `<?xml version="1.0" encoding="UTF-8"?>${body}`;
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');

/** @returns {Promise<{ port: number, faults: { failList: boolean }, objects: Map<string, Buffer>, close: () => Promise<void> }>} */
export async function startFakeS3() {
  /** Set to true to make every listing fail with a 500. */
  const faults = { failList: false };
  /** @type {Map<string, Buffer>} key = "bucket/key" */
  const objects = new Map();
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    const path = decodeURIComponent(url.pathname.slice(1));
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const send = (status, body = '', headers = {}) => {
        res.writeHead(status, { 'content-length': Buffer.byteLength(body), ...headers });
        res.end(req.method === 'HEAD' ? undefined : body);
      };
      if (req.method === 'PUT') {
        objects.set(path, Buffer.concat(chunks));
        return send(200, '', { etag: '"fake"' });
      }
      if (req.method === 'DELETE') {
        objects.delete(path);
        return send(204);
      }
      if (req.method === 'GET' && url.searchParams.get('list-type') === '2') {
        if (faults.failList) return send(500, xml('<Error><Code>InternalError</Code></Error>'));
        const bucket = path.replace(/\/$/, '');
        const prefix = url.searchParams.get('prefix') ?? '';
        const keys = [...objects.keys()]
          .filter(
            (k) => k.startsWith(`${bucket}/`) && k.slice(bucket.length + 1).startsWith(prefix),
          )
          .map((k) => k.slice(bucket.length + 1))
          .sort();
        const items = keys
          .map(
            (k) =>
              `<Contents><Key>${esc(k)}</Key><Size>${objects.get(`${bucket}/${k}`).length}</Size></Contents>`,
          )
          .join('');
        return send(
          200,
          xml(
            `<ListBucketResult><Name>${bucket}</Name><Prefix>${esc(prefix)}</Prefix><KeyCount>${keys.length}</KeyCount><IsTruncated>false</IsTruncated>${items}</ListBucketResult>`,
          ),
          { 'content-type': 'application/xml' },
        );
      }
      if (req.method === 'GET' || req.method === 'HEAD') {
        const body = objects.get(path);
        if (!body)
          return send(404, xml('<Error><Code>NoSuchKey</Code></Error>'), {
            'content-type': 'application/xml',
          });
        res.writeHead(200, {
          'content-length': body.length,
          etag: '"fake"',
          'last-modified': new Date().toUTCString(),
          'content-type': 'application/octet-stream',
        });
        return res.end(req.method === 'HEAD' ? undefined : body);
      }
      return send(501);
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = /** @type {import('node:net').AddressInfo} */ (server.address());
  return {
    port,
    faults,
    objects,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
