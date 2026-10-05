import type { AiDetectorConfig } from './config';

/** A detector verdict for one event, before the session turns it into a signed event. */
export interface RuleEvent {
  type:
    | 'NO_FACE'
    | 'MULTIPLE_FACES'
    | 'GAZE_AWAY'
    | 'PHONE_DETECTED'
    | 'BOOK_DETECTED'
    | 'SPEECH_DETECTED';
  /** Start of the condition on the client clock (ms since epoch). */
  startedAtMs: number;
  durationMs?: number;
  confidence?: number;
  faceCount?: number;
}

/**
 * Fires once when `active` has been true for `afterMs` without a break, then stays quiet until the
 * condition clears and `cooldownMs` has passed since the last firing. A null sample (no data, for
 * example the detector skipped a frame) neither fires nor resets, but a long gap does reset.
 */
export class SustainedCondition {
  private since: number | null = null;
  private lastSample = 0;
  private fired = false;
  private lastFiredAt = -Infinity;

  constructor(
    private readonly afterMs: number,
    private readonly cooldownMs: number,
    /** If samples stop for longer than this, the run is not "continuous" any more. */
    private readonly maxGapMs = 5000,
  ) {}

  update(active: boolean, nowMs: number): { startedAtMs: number; durationMs: number } | null {
    if (this.since !== null && nowMs - this.lastSample > this.maxGapMs) this.reset();
    this.lastSample = nowMs;
    if (!active) {
      this.reset();
      return null;
    }
    this.since ??= nowMs;
    if (
      !this.fired &&
      nowMs - this.since >= this.afterMs &&
      nowMs - this.lastFiredAt >= this.cooldownMs
    ) {
      this.fired = true;
      this.lastFiredAt = nowMs;
      return { startedAtMs: this.since, durationMs: nowMs - this.since };
    }
    return null;
  }

  reset(): void {
    this.since = null;
    this.fired = false;
  }
}

/** True when the last `window` boolean samples contain at least `hits` trues (and enforces cooldown). */
export class WindowedHits {
  private readonly samples: boolean[] = [];
  private lastFiredAt = -Infinity;
  constructor(
    private readonly hits: number,
    private readonly window: number,
    private readonly cooldownMs: number,
  ) {}
  update(hit: boolean, nowMs: number): boolean {
    this.samples.push(hit);
    if (this.samples.length > this.window) this.samples.shift();
    const count = this.samples.filter(Boolean).length;
    if (count >= this.hits && nowMs - this.lastFiredAt >= this.cooldownMs) {
      this.lastFiredAt = nowMs;
      this.samples.length = 0;
      return true;
    }
    return false;
  }
}

// ---------- Face ----------

export interface FaceSample {
  /** Number of faces the detector found; null when the detector did not run or errored. */
  faceCount: number | null;
}

export class FaceRules {
  private readonly noFace: SustainedCondition;
  private readonly multi: WindowedHits;
  constructor(cfg: AiDetectorConfig) {
    this.noFace = new SustainedCondition(cfg.noFaceAfterMs, cfg.cooldownMs);
    this.multi = new WindowedHits(
      cfg.multipleFacesSamples,
      cfg.multipleFacesSamples,
      cfg.cooldownMs,
    );
  }
  process(s: FaceSample, nowMs: number): RuleEvent[] {
    if (s.faceCount === null) return [];
    const out: RuleEvent[] = [];
    const nf = this.noFace.update(s.faceCount === 0, nowMs);
    if (nf) out.push({ type: 'NO_FACE', ...nf });
    if (this.multi.update(s.faceCount >= 2, nowMs)) {
      out.push({
        type: 'MULTIPLE_FACES',
        startedAtMs: nowMs,
        faceCount: Math.min(32, s.faceCount),
      });
    }
    return out;
  }
}

// ---------- Gaze ----------

export interface GazeSample {
  yawDeg: number;
  pitchDeg: number;
  /** 0 = iris centred in both eyes, 0.5 = at the corner. */
  irisOffset: number;
}

export function isLookingAway(g: GazeSample, cfg: AiDetectorConfig): boolean {
  if (Math.abs(g.yawDeg) > cfg.gazeYawDeg) return true;
  // Positive pitch is looking up here; down is expected while typing, so it has a looser limit.
  if (g.pitchDeg > cfg.gazePitchUpDeg || g.pitchDeg < -cfg.gazePitchDownDeg) return true;
  return g.irisOffset > cfg.gazeIrisOffset;
}

/**
 * Head pose from MediaPipe's 4x4 facial transformation matrix (column-major, 16 numbers).
 * Returns degrees; yaw positive when the head turns to the camera's left, pitch positive when
 * looking up. The sign of yaw does not matter for the rules (absolute value).
 */
export function headPoseFromMatrix(m: ArrayLike<number>): { yawDeg: number; pitchDeg: number } {
  const r00 = m[0] ?? 1;
  const r10 = m[1] ?? 0;
  const r20 = m[2] ?? 0;
  const r21 = m[6] ?? 0;
  const r22 = m[10] ?? 1;
  const deg = 180 / Math.PI;
  const yaw = Math.atan2(-r20, Math.hypot(r00, r10)) * deg;
  const pitch = Math.atan2(r21, r22) * deg;
  return { yawDeg: yaw, pitchDeg: pitch };
}

export interface Point {
  x: number;
  y: number;
}

/**
 * Horizontal iris position inside each eye, as distance from centre over eye width, averaged.
 * Landmarks (478-point model): right eye corners 33/133, iris 468; left eye corners 362/263, iris 473.
 */
export function irisOffsetFromLandmarks(lm: readonly Point[]): number | null {
  const at = (i: number): Point | undefined => lm[i];
  const side = (outer: number, inner: number, iris: number): number | null => {
    const o = at(outer);
    const n = at(inner);
    const c = at(iris);
    if (!o || !n || !c) return null;
    const width = n.x - o.x;
    if (Math.abs(width) < 1e-6) return null;
    return Math.abs((c.x - o.x) / width - 0.5);
  };
  const a = side(33, 133, 468);
  const b = side(362, 263, 473);
  if (a === null || b === null) return null;
  return (a + b) / 2;
}

export class GazeRules {
  private readonly away: SustainedCondition;
  constructor(private readonly cfg: AiDetectorConfig) {
    this.away = new SustainedCondition(cfg.gazeAwayAfterMs, cfg.cooldownMs);
  }
  /** `null` means no face this sample: that is NO_FACE's job, so the gaze run resets. */
  process(g: GazeSample | null, nowMs: number): RuleEvent[] {
    if (g === null) {
      this.away.reset();
      return [];
    }
    const r = this.away.update(isLookingAway(g, this.cfg), nowMs);
    return r ? [{ type: 'GAZE_AWAY', ...r }] : [];
  }
}

// ---------- Objects ----------

export interface ObjectDetection {
  class: string;
  score: number;
}

export class ObjectRules {
  private readonly phone: WindowedHits;
  private readonly book: WindowedHits;
  constructor(private readonly cfg: AiDetectorConfig) {
    this.phone = new WindowedHits(cfg.objectHits, cfg.objectWindow, cfg.cooldownMs);
    this.book = new WindowedHits(cfg.objectHits, cfg.objectWindow, cfg.cooldownMs);
  }
  process(dets: readonly ObjectDetection[], nowMs: number): RuleEvent[] {
    const best = (cls: string, min: number): number | null => {
      let b: number | null = null;
      for (const d of dets) if (d.class === cls && d.score >= min) b = Math.max(b ?? 0, d.score);
      return b;
    };
    const phone = best('cell phone', this.cfg.phoneConfidence);
    const book = best('book', this.cfg.bookConfidence);
    const out: RuleEvent[] = [];
    if (this.phone.update(phone !== null, nowMs)) {
      out.push({
        type: 'PHONE_DETECTED',
        startedAtMs: nowMs,
        confidence: phone ?? this.cfg.phoneConfidence,
      });
    }
    if (this.book.update(book !== null, nowMs)) {
      out.push({
        type: 'BOOK_DETECTED',
        startedAtMs: nowMs,
        confidence: book ?? this.cfg.bookConfidence,
      });
    }
    return out;
  }
}

// ---------- Speech ----------

export class SpeechRules {
  private lastFiredAt = -Infinity;
  constructor(private readonly cfg: AiDetectorConfig) {}
  /** Called when a speech segment ends. Returns SPEECH_DETECTED with its duration. */
  onSegment(startedAtMs: number, endedAtMs: number): RuleEvent[] {
    const durationMs = endedAtMs - startedAtMs;
    if (durationMs < this.cfg.minSpeechMs) return [];
    // Short cooldown so a long conversation is a handful of events, not hundreds.
    if (endedAtMs - this.lastFiredAt < Math.min(this.cfg.cooldownMs, 10_000)) return [];
    this.lastFiredAt = endedAtMs;
    return [{ type: 'SPEECH_DETECTED', startedAtMs, durationMs }];
  }
}
