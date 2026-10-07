// Where the invitation token and the email OTP come from. They are only ever sent by email
// (FR-303, FR-106), so a staging mail sink is a dependency of seeding. This adapter reads a
// Mailpit-compatible HTTP API (GET /api/v1/search, GET /api/v1/message/:id). Synthetic recipients
// on a reserved domain only. Message bodies are parsed in memory and never logged.
import { SeedError } from './redact.mjs';

export const DEFAULT_LINK_RE = '/(?:invite|i|start)/([A-Za-z0-9_-]{32,})'; // ASSUMED link format
export const OTP_RE = /(?<![\d])(\d{6})(?![\d])/;

export function createMailpitSource({
  client,
  linkRe = DEFAULT_LINK_RE,
  sleep,
  timeoutMs = 30000,
  pollMs = 1000,
}) {
  const tokenRe = new RegExp(linkRe);

  async function findMessage(email, since, accept) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const q = encodeURIComponent(`to:${email}`);
      const { json } = await client.request('GET', `/api/v1/search?query=${q}&limit=20`, {
        step: 'mail search',
      });
      const messages = (json?.messages ?? [])
        .filter((m) => Date.parse(m.Created) >= since - 2000)
        .sort((a, b) => Date.parse(b.Created) - Date.parse(a.Created));
      for (const m of messages) {
        const { json: full } = await client.request(
          'GET',
          `/api/v1/message/${encodeURIComponent(m.ID)}`,
          { step: 'mail read' },
        );
        const hit = accept(`${full?.Text ?? ''}\n${full?.HTML ?? ''}`);
        if (hit) return hit;
      }
      if (Date.now() > deadline) {
        throw new SeedError('mail sink: expected message did not arrive in time.', {
          step: 'mail',
        });
      }
      await sleep(pollMs);
    }
  }

  return {
    getInviteToken: (email, since) =>
      findMessage(email, since, (text) => tokenRe.exec(text)?.[1] ?? null),
    // The OTP email carries no invitation link; a six-digit number is the first match not inside it.
    getOtp: (email, since) =>
      findMessage(email, since, (text) =>
        tokenRe.test(text) ? null : (OTP_RE.exec(text.replace(/<[^>]*>/g, ' '))?.[1] ?? null),
      ),
  };
}
