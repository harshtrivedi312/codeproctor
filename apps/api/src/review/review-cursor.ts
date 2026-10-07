// Opaque queue cursor over (submittedAt, id). submittedAt is nullable, so the cursor carries null.
import { BadRequestException } from '@nestjs/common';

export interface QueueCursor {
  readonly t: string | null;
  readonly id: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function encodeCursor(c: QueueCursor): string {
  return Buffer.from(JSON.stringify(c), 'utf8').toString('base64url');
}

export function decodeCursor(raw: string): QueueCursor {
  const bad = new BadRequestException('Invalid cursor.');
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
  } catch {
    throw bad;
  }
  if (typeof parsed !== 'object' || parsed === null) throw bad;
  const { t, id } = parsed as Record<string, unknown>;
  if (typeof id !== 'string' || !UUID.test(id)) throw bad;
  if (t !== null && (typeof t !== 'string' || Number.isNaN(Date.parse(t)))) throw bad;
  return { t, id };
}
