// Pure mapping helpers of the reviewer read API. Nothing here touches the database.

/** A short, safe event description from scalar columns only. The payload column is never read. */
export function eventDetail(durationMs: number | null, confidence: number | null): string | null {
  const parts: string[] = [];
  if (durationMs !== null) parts.push(`duration ${durationMs} ms`);
  if (confidence !== null) parts.push(`confidence ${confidence.toFixed(2)}`);
  return parts.length > 0 ? parts.join(', ') : null;
}

export interface RunTest {
  name: string;
  status: string;
}

const clip = (s: string): string => (s.length > 64 ? s.slice(0, 64) : s);

/**
 * `submissions.results` is `{ testCaseId | testId, passed, status | verdict, ... }[]` (ADR 0013).
 * Only a name and a status are kept: never stdout, stdin, expected output or messages. Anything
 * that does not look like that is skipped.
 */
export function runTests(results: unknown): RunTest[] {
  if (!Array.isArray(results)) return [];
  const out: RunTest[] = [];
  results.forEach((r: unknown, i) => {
    if (typeof r !== 'object' || r === null) return;
    const o = r as Record<string, unknown>;
    const id = typeof o['testCaseId'] === 'string' ? o['testCaseId'] : o['testId'];
    const st = typeof o['status'] === 'string' ? o['status'] : o['verdict'];
    let status = 'UNKNOWN';
    if (typeof st === 'string') status = st;
    else if (typeof o['passed'] === 'boolean') status = o['passed'] ? 'PASSED' : 'FAILED';
    out.push({ name: clip(typeof id === 'string' ? id : `test ${i + 1}`), status: clip(status) });
  });
  return out;
}

export const RECORDING_KINDS = ['SCREEN', 'WEBCAM', 'AUDIO'] as const;
export type RecordingKind = (typeof RECORDING_KINDS)[number];

/** A recording is one recorder run: the chunks of one stream and segment (database.md media_chunks). */
export function recordingId(kind: RecordingKind, segment: number): string {
  return `${kind}-${segment}`;
}

export function parseRecordingId(id: string): { kind: RecordingKind; segment: number } | null {
  const m = /^(SCREEN|WEBCAM|AUDIO)-(\d{1,9})$/.exec(id);
  return m ? { kind: m[1] as RecordingKind, segment: Number(m[2]) } : null;
}

export const contentTypeOf = (kind: RecordingKind): string =>
  kind === 'AUDIO' ? 'audio/webm' : 'video/webm';
