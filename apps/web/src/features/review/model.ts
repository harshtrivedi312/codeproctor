import type { Schemas } from '@/lib/api/client';
import { humanizeEventType } from '@/features/admin/format';

/*
 * The ONE place that knows the review API shapes (openapi: ReviewQueue, ReviewSession,
 * ReviewPlayback; the read routes are REAL, apps/api/src/review). Screens use these types and helpers only, so a change in the real API is a
 * change here. Candidate-written text (answers, notes) is only ever rendered as text.
 */

export type QueueItem = Schemas['ReviewQueue']['items'][number];
export type ReviewSession = Schemas['ReviewSession'];
export type ReviewAnswer = Schemas['ReviewAnswer'];
export type ReviewEvent = Schemas['ReviewEvent'];
export type ReviewRecording = Schemas['ReviewRecording'];
export type ReviewPlayback = Schemas['ReviewPlayback'];
export type Verdict = Schemas['SetVerdict']['verdict'];

/** The verdict object is present but empty until a verdict is set. */
export function verdictOf(
  s: ReviewSession,
): { verdict: Verdict; notes: string | null; completedAt: string | null } | null {
  const v = s.verdict;
  return v && v.verdict ? { verdict: v.verdict, notes: v.notes, completedAt: v.completedAt } : null;
}

export const VERDICTS: readonly Verdict[] = ['CLEAN', 'SUSPICIOUS', 'VIOLATION'];
export const VERDICT_LABEL: Record<Verdict, string> = {
  CLEAN: 'Clean',
  SUSPICIOUS: 'Suspicious',
  VIOLATION: 'Violation',
};

export const KIND_LABEL: Record<ReviewRecording['kind'], string> = {
  SCREEN: 'Screen',
  WEBCAM: 'Webcam',
  AUDIO: 'Audio',
};

export const TYPE_LABEL: Record<ReviewAnswer['type'], string> = {
  CODING: 'Coding',
  MCQ: 'Multiple choice',
  SHORT_ANSWER: 'Short answer',
};

/** A missing value is shown as a dash, never hides the row. */
export const DASH = '-';

/** Unknown event types (the API sends the stored string) are shown humanised, never rejected. */
export const eventLabel = (type: string): string => humanizeEventType(type);

export type SeverityTone = 'neutral' | 'warning' | 'error';
export function severityTone(severity: string | null): SeverityTone {
  if (severity === 'HIGH') return 'error';
  if (severity === 'MEDIUM') return 'warning';
  return 'neutral';
}
export const severityLabel = (severity: string | null): string =>
  severity === null ? DASH : severity.charAt(0) + severity.slice(1).toLowerCase();

export function riskLabel(score: number | null): string {
  return score === null ? DASH : String(Math.round(score));
}
export function riskTone(score: number | null): SeverityTone {
  if (score === null) return 'neutral';
  return score >= 60 ? 'error' : score >= 30 ? 'warning' : 'neutral';
}

/** mm:ss (or h:mm:ss) since the session started. Events before the start show as 00:00. */
export function relativeTime(at: string, startedAt: string | null): string {
  if (!startedAt) return new Date(at).toLocaleTimeString();
  const total = Math.max(0, Math.floor((Date.parse(at) - Date.parse(startedAt)) / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const two = (n: number): string => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${two(m)}:${two(s)}` : `${two(m)}:${two(s)}`;
}

export function formatDuration(ms: number): string {
  return relativeTime(new Date(ms).toISOString(), new Date(0).toISOString());
}

export function formatDateTime(iso: string | null): string {
  return iso ? new Date(iso).toLocaleString() : DASH;
}

export function formatScore(score: number | null): string {
  return score === null ? DASH : String(score);
}

export type AnswerBody =
  | { kind: 'text'; text: string }
  | { kind: 'options'; ids: readonly string[] }
  | { kind: 'code'; language: string; code: string };

export function answerBody(answer: ReviewAnswer): AnswerBody {
  const a = answer.answer;
  if (a === null || a === undefined) return { kind: 'text', text: '' };
  if (typeof a === 'string') return { kind: 'text', text: a };
  if (Array.isArray(a)) return { kind: 'options', ids: a.map((x) => String(x)) };
  if (typeof a === 'object') {
    const o = a as Record<string, unknown>;
    if (Array.isArray(o['selectedOptionIds'])) {
      return { kind: 'options', ids: o['selectedOptionIds'].map((x) => String(x)) };
    }
    if (typeof o['code'] === 'string') {
      return {
        kind: 'code',
        language: typeof o['language'] === 'string' ? o['language'] : '',
        code: o['code'],
      };
    }
  }
  return { kind: 'text', text: JSON.stringify(a) };
}

export type ScoringState = 'auto' | 'pending' | 'manual';
export function scoringState(a: ReviewAnswer): ScoringState {
  return a.scoring === 'MANUAL_PENDING' ? 'pending' : a.scoring === 'MANUAL' ? 'manual' : 'auto';
}
export const canScoreManually = (a: ReviewAnswer): boolean =>
  a.type === 'SHORT_ANSWER' && a.scoring !== 'AUTO';

/**
 * Scoring and the verdict apply only to a session UNDER_REVIEW with no verdict yet
 * (docs/api-contract.md section 7: GRADED, COMPLETED and APPEALED sessions are 409).
 */
export const isDecidable = (s: ReviewSession): boolean =>
  s.session.status === 'UNDER_REVIEW' && verdictOf(s) === null;

export const pendingCount = (s: ReviewSession): number =>
  s.answers.filter((a) => a.scoring === 'MANUAL_PENDING').length;

export interface PlaybackPart {
  url: string;
  durationMs: number | null;
}
/** The playback answer carries one url or ordered parts; both become an ordered list. */
export function playbackParts(p: ReviewPlayback): PlaybackPart[] {
  if (p.parts && p.parts.length > 0) {
    return [...p.parts]
      .sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0))
      .map((x) => ({ url: x.url, durationMs: x.durationMs }));
  }
  return p.url ? [{ url: p.url, durationMs: null }] : [];
}
