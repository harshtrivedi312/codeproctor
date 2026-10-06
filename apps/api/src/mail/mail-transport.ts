// Transport and object-reader seams of the mail module. The real transport is SES (C-31).

export interface OutgoingMail {
  to: string;
  subject: string;
  html: string;
  text: string;
  attachment?: { filename: string; contentType: string; content: Buffer };
}

export abstract class MailTransport {
  abstract send(mail: OutgoingMail): Promise<void>;
}

/**
 * Reads an object from storage with the server's own role (used for the consent PDF). No
 * S3-compatible storage port exists on main yet; the module that adds one implements this.
 */
export abstract class ObjectReader {
  abstract read(key: string): Promise<Buffer>;
}

export class UnconfiguredObjectReader extends ObjectReader {
  read(): Promise<Buffer> {
    return Promise.reject(new MailError('object reader is not configured'));
  }
}

/**
 * The only error type the mail path throws or logs. The message is fixed text and the cause is
 * kept as a class name only: SDK errors can carry the request (address, body) and must not leak.
 */
export class MailError extends Error {
  constructor(
    message: string,
    readonly causeName: string = 'none',
  ) {
    super(message);
    this.name = 'MailError';
  }
}

/** Wraps anything caught in the mail path into a MailError that holds no payload. */
export function scrub(e: unknown, message: string): MailError {
  return new MailError(message, e instanceof Error ? e.name : 'unknown');
}
