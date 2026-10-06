import { randomUUID } from 'node:crypto';
import type { Options } from 'pino-http';
import { LOG_REDACT } from './log-redaction';

/** The pinoHttp options the app logs with (NFR-09). Exported so a test can check the redact list. */
export function buildPinoHttpOptions(level: string): Options {
  return {
    level,
    // Per-request trace ID (NFR-09): honour a well-formed inbound id, else generate one.
    genReqId: (req, res) => {
      const inbound = req.headers['x-request-id'];
      const id =
        typeof inbound === 'string' && /^[A-Za-z0-9._-]{8,64}$/.test(inbound)
          ? inbound
          : randomUUID();
      res.setHeader('x-request-id', id);
      return id;
    },
    // Never log credentials, tokens, cookies or secret body fields.
    redact: LOG_REDACT,
    // The query string may carry tokens, so log the path only.
    serializers: {
      req: (req: { id: string; method: string; url: string }) => ({
        id: req.id,
        method: req.method,
        url: req.url.split('?')[0],
      }),
    },
  };
}
