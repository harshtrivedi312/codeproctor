// Synthetic identities and payloads. Nothing here is, or resembles, a real person, face or ID.
import crypto from 'node:crypto';

// Reserved or documentation-only domains: RFC 2606 / RFC 6761. Mail to them can never reach a
// real person. Anything else is refused.
const SAFE_DOMAIN =
  /^(?:[a-z0-9-]+\.)+(?:test|invalid|example)$|^(?:[a-z0-9-]+\.)?example\.(?:com|org|net)$/;

export function assertSyntheticDomain(domain) {
  if (!SAFE_DOMAIN.test(domain)) {
    throw new Error(
      'SEED_EMAIL_DOMAIN must be a reserved domain (*.test, *.invalid, *.example, example.com/org/net).',
    );
  }
  return domain;
}

export function newRunId(now = new Date()) {
  const ts = now.toISOString().replace(/[-:T]/g, '').slice(0, 14);
  return `k6seed-${ts}-${crypto.randomBytes(3).toString('hex')}`;
}

export const RUN_ID_RE = /^k6seed-\d{14}-[0-9a-f]{6}$/;

export function candidateFor(runId, index, domain) {
  const n = String(index + 1).padStart(3, '0');
  return {
    name: `K6SEED ${runId.slice(-6)} ${n}`,
    email: `${runId}-${n}@${domain}`,
  };
}

// Tiny labeled placeholder for the room-scan chunk. It is not a playable WebM and shows nothing.
export function placeholderChunk(bytes) {
  const label = Buffer.from('CODEPROCTOR-SYNTHETIC-K6SEED-PLACEHOLDER-NOT-A-VIDEO\n');
  const out = Buffer.alloc(bytes);
  for (let i = 0; i < bytes; i += label.length)
    label.copy(out, i, 0, Math.min(label.length, bytes - i));
  return out;
}
