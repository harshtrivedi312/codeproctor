// A tiny in-memory S3 server for the backup tests (DB-07). Path-style only, no auth, no
// multipart: enough for `aws s3 cp` of small files, head-object, get-object, list-objects-v2 and
// delete-object. A PUT with `versioned: true` also keeps object versions (x-amz-version-id) and the
// x-amz-meta-* headers, like a versioned AWS bucket; objects put straight into `objects` have no
// version id, like Cloudflare R2.
// Not a test file. Binds to 127.0.0.1 on a random port.
import { createServer } from 'node:http';

const xml = (body) => `<?xml version="1.0" encoding="UTF-8"?>${body}`;
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');

/** @returns {Promise<{ port: number, faults: { failList: boolean }, objects: Map<string, Buffer>, versions: Map<string, Array<{ id: string, body: Buffer, meta: Record<string, string> }>>, metas: Map<string, Record<string, string>>, deletes: string[], puts: Array<{ path: string, conditional: boolean }>, close: () => Promise<void> }>} */
export async function startFakeS3({ versioned = false } = {}) {
  /** Set to true to make every listing fail with a 500. */
  const faults = { failList: false };
  /** @type {Map<string, Buffer>} key = "bucket/key" */
  const objects = new Map();
  /** @type {Map<string, Array<{ id: string, body: Buffer, meta: Record<string, string> }>>} */
  const versions = new Map();
  /** Metadata of the current object per key. */
  const metas = new Map();
  let counter = 0;
  /** Every DELETE request, as "bucket/key" (tests assert versioned backups issue none). */
  const deletes = [];
  /** Every accepted PUT, with whether it carried If-None-Match: * (tests assert the erasure list is written conditionally). */
  const puts = [];
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
        // A conditional create (If-None-Match: *): refused with 412 when the key already exists.
        if (req.headers['if-none-match'] === '*' && objects.has(path))
          return send(412, xml('<Error><Code>PreconditionFailed</Code></Error>'), {
            'content-type': 'application/xml',
          });
        puts.push({ path, conditional: req.headers['if-none-match'] === '*' });
        const body = Buffer.concat(chunks);
        const meta = {};
        for (const [h, v] of Object.entries(req.headers))
          if (h.startsWith('x-amz-meta-')) meta[h.slice('x-amz-meta-'.length)] = String(v);
        objects.set(path, body);
        metas.set(path, meta);
        if (!versioned) return send(200, '', { etag: '"fake"' });
        counter += 1;
        const id = `v${counter}`;
        versions.set(path, [...(versions.get(path) ?? []), { id, body, meta }]);
        return send(200, '', { etag: '"fake"', 'x-amz-version-id': id });
      }
      if (req.method === 'DELETE') {
        deletes.push(path);
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
        const wanted = url.searchParams.get('versionId');
        const history = versions.get(path) ?? [];
        const version = wanted ? history.find((v) => v.id === wanted) : history.at(-1);
        const body = wanted ? version?.body : (objects.get(path) ?? version?.body);
        if (!body)
          return send(404, xml('<Error><Code>NoSuchKey</Code></Error>'), {
            'content-type': 'application/xml',
          });
        const meta = wanted ? (version?.meta ?? {}) : (metas.get(path) ?? {});
        res.writeHead(200, {
          'content-length': body.length,
          etag: '"fake"',
          'last-modified': new Date().toUTCString(),
          'content-type': 'application/octet-stream',
          ...(version ? { 'x-amz-version-id': version.id } : {}),
          ...Object.fromEntries(Object.entries(meta).map(([k, v]) => [`x-amz-meta-${k}`, v])),
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
    versions,
    metas,
    deletes,
    puts,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
