import type { Options } from 'pino-http';
import { LOG_REDACT } from './log-redaction';
import { resolveRequestId } from './request-id';

/** The pinoHttp options the app logs with (NFR-09). Exported so a test can check the redact list. */
export function buildPinoHttpOptions(level: string): Options {
  return {
    level,
    // Per-request trace ID (NFR-09): honour a well-formed inbound id, else generate one
    // (never on the public /client-errors route, FU-BE-95).
    genReqId: (req, res) => {
      const id = resolveRequestId(
        req.headers['x-request-id'],
        (req as { originalUrl?: string }).originalUrl ?? req.url,
      );
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
