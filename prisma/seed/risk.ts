// Severity and risk-score rules from ADR 0005 section 2 and FR-804, for the event types the seed
// uses. The plan computes each seeded session's risk score from its events with these rules, so the
// stored score always matches the stored events. packages/shared holds the contract (DEFAULT_*
// constants, riskBandForScore); a seed test checks these copies against it.
export type Severity = 'LOW' | 'MEDIUM' | 'HIGH';
export type RiskBand = 'LOW' | 'MEDIUM' | 'HIGH';

/** Default severity per event type (ADR 0005 section 2). Only the types the seed uses. */
export const SEEDED_EVENT_SEVERITY = {
  FULLSCREEN_EXIT: 'MEDIUM',
  FULLSCREEN_RESTORED: 'LOW',
  TAB_SWITCH: 'MEDIUM',
  FOCUS_LOST: 'MEDIUM',
  GAZE_AWAY: 'MEDIUM',
  PASTE_ATTEMPT: 'LOW',
  COPY_ATTEMPT: 'LOW',
  RIGHT_CLICK: 'LOW',
  SCREEN_SHARE_STOPPED: 'HIGH',
  SCREEN_SHARE_RESUMED: 'LOW',
  DISCONNECTED: 'LOW',
  RECONNECTED: 'LOW',
  PASTE_BURST: 'HIGH',
  CODE_SIMILARITY: 'HIGH',
} as const satisfies Record<string, Severity>;

export type SeededEventType = keyof typeof SEEDED_EVENT_SEVERITY;

/** Informational and resume types count for nothing in the score (weight 0). */
export const ZERO_WEIGHT_SEEDED_TYPES: readonly SeededEventType[] = [
  'DISCONNECTED',
  'RECONNECTED',
  'FULLSCREEN_RESTORED',
  'SCREEN_SHARE_RESUMED',
];

const POINTS: Readonly<Record<Severity, number>> = { LOW: 2, MEDIUM: 8, HIGH: 20 };
const CAP_PER_TYPE = 3;

/** score = min(100, sum over types of min(count, cap) x points[severity] x weight[type]). */
export function riskScore(types: readonly SeededEventType[]): number {
  const counts = new Map<SeededEventType, number>();
  for (const type of types) counts.set(type, (counts.get(type) ?? 0) + 1);
  let score = 0;
  for (const [type, count] of counts) {
    if (ZERO_WEIGHT_SEEDED_TYPES.includes(type)) continue;
    score += Math.min(count, CAP_PER_TYPE) * POINTS[SEEDED_EVENT_SEVERITY[type]];
  }
  return Math.min(100, score);
}

/** FR-804: 0-29 LOW, 30-59 MEDIUM, 60-100 HIGH. */
export function riskBand(score: number): RiskBand {
  if (score >= 60) return 'HIGH';
  if (score >= 30) return 'MEDIUM';
  return 'LOW';
}
