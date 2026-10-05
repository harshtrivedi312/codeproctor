'use client';

import { useEffect, useState } from 'react';
import type { Summary } from './api/_lib/mock-server';
import { DEMO_API_BASE } from './demo-key';

/** Live view of what the mock server received. Plain fetch (not the page's simulated drop). */
export function MockServerPanel({ sessionId }: { sessionId: string }) {
  const [s, setS] = useState<Summary | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    const poll = async (): Promise<void> => {
      try {
        const res = await fetch(`${DEMO_API_BASE}/state?session=${sessionId}`, {
          cache: 'no-store',
        });
        if (!res.ok) throw new Error(String(res.status));
        const j = (await res.json()) as Summary;
        if (alive) {
          setS(j);
          setError(null);
        }
      } catch {
        if (alive) setError('Mock server unreachable (offline?). Last numbers are kept.');
      }
    };
    void poll();
    const t = setInterval(() => void poll(), 1000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [sessionId]);

  const reset = async (): Promise<void> => {
    await fetch(`${DEMO_API_BASE}/state?session=${sessionId}`, { method: 'DELETE' });
  };

  return (
    <section aria-label="Mock server received" className="rounded border p-3 text-sm">
      <div className="flex items-center justify-between">
        <h2 className="font-medium">
          Mock server received (session {sessionId.slice(0, 8)}) - provisional, ADR 0013 (Proposed,
          PR #39)
        </h2>
        <button type="button" className="rounded border px-2 py-1" onClick={() => void reset()}>
          Reset server state
        </button>
      </div>
      {error && (
        <p role="status" className="text-amber-600">
          {error}
        </p>
      )}
      {s && (
        <dl className="mt-2 grid grid-cols-2 gap-x-6 gap-y-1">
          <dt>Heartbeats (with recorder/queue health)</dt>
          <dd>
            {s.heartbeats.count} ({s.heartbeats.withHealth}), last{' '}
            {s.heartbeats.lastAt?.slice(11, 19) ?? '-'}
          </dd>
          <dt>Event batches accepted / duplicate / SEQ_CONFLICT / rejected</dt>
          <dd>
            {s.batches.accepted} / {s.batches.duplicate} / {s.batches.conflict} /{' '}
            {s.batches.rejected} ({s.batches.events} events)
          </dd>
          <dt>Highest seq, missing seqs</dt>
          <dd>
            {s.seq.highest ?? '-'},{' '}
            {s.seq.missing.length ? s.seq.missing.join(', ') : 'none (no gap)'}
          </dd>
          <dt>Chunks presigned / uploaded / confirmed</dt>
          <dd>
            {s.chunks.presigned} / {s.chunks.uploaded} / {s.chunks.confirmed}
          </dd>
          <dt>Chunk bytes by stream</dt>
          <dd>
            {Object.entries(s.chunks.bytes)
              .map(([k, v]) => `${k} ${v}`)
              .join(', ') || '-'}
          </dd>
          <dt>Evidence presigned / uploaded / unissued names dropped</dt>
          <dd>
            {s.evidence.presigned} / {s.evidence.uploaded} / {s.evidence.namesDropped}
          </dd>
          <dt>Identity re-checks accepted (202) / server-written FACE_MISMATCH</dt>
          <dd>
            {s.identity.accepted} / {s.identity.serverFaceMismatch}
          </dd>
          <dt>Error codes returned</dt>
          <dd>
            {Object.entries(s.errors)
              .map(([k, v]) => `${k} ${v}`)
              .join(', ') || '-'}
          </dd>
          <dt>Events by type</dt>
          <dd>
            {Object.entries(s.eventTypes)
              .map(([k, v]) => `${k} ${v}`)
              .join(', ') || '-'}
          </dd>
        </dl>
      )}
      {s && s.recent.length > 0 && (
        <ol className="mt-2 text-xs">
          {s.recent.map((b, i) => (
            <li key={`${b.at}-${i}`}>
              {b.at.slice(11, 23)} {b.route} seq {b.seq ?? '?'} {b.status} ({b.events} events)
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
