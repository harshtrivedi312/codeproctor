import { describe, expect, it } from 'vitest';
import { DEFAULT_AI_CONFIG, resolveModelUrls } from './config';
import {
  BOOK,
  GAZE_CENTERED,
  GAZE_EYES_ONLY,
  GAZE_KEYBOARD,
  GAZE_SIDE,
  NO_FACE_SEQUENCE,
  NOTHING,
  PHONE_STRONG,
  PHONE_WEAK,
  secondsOf,
} from './__fixtures__/samples';
import {
  FaceRules,
  GazeRules,
  ObjectRules,
  SpeechRules,
  SustainedCondition,
  headPoseFromMatrix,
  irisOffsetFromLandmarks,
  type RuleEvent,
} from './rules';

const cfg = DEFAULT_AI_CONFIG;
const T0 = 1_000_000;

function runFace(seq: number[], rules = new FaceRules(cfg)): { t: number; e: RuleEvent }[] {
  const out: { t: number; e: RuleEvent }[] = [];
  seq.forEach((count, i) => {
    for (const e of rules.process({ faceCount: count }, T0 + i * 1000)) out.push({ t: i, e });
  });
  return out;
}

describe('NO_FACE debouncing (FR-606)', () => {
  it('FR-606: fires once after 5 s without a face and ignores the shorter 3 s absence', () => {
    const got = runFace(NO_FACE_SEQUENCE).filter((x) => x.e.type === 'NO_FACE');
    expect(got).toHaveLength(1);
    expect(got[0]?.t).toBe(15); // absent from t=10, 5 s later
    expect(got[0]?.e.durationMs).toBe(5000);
    expect(got[0]?.e.startedAtMs).toBe(T0 + 10_000);
  });

  it('FR-606: does not repeat while the face stays away, and respects the cooldown', () => {
    const rules = new FaceRules(cfg);
    const seq = [...secondsOf(20, 0), 1, ...secondsOf(10, 0)];
    expect(runFace(seq, rules).filter((x) => x.e.type === 'NO_FACE')).toHaveLength(1);
  });

  it('FR-606: fires again after the cooldown', () => {
    const seq = [...secondsOf(8, 0), ...secondsOf(5, 1), ...secondsOf(40, 0)];
    expect(runFace(seq).filter((x) => x.e.type === 'NO_FACE')).toHaveLength(2);
  });

  it('FR-606: a skipped frame (null) is not a missing face', () => {
    const rules = new FaceRules(cfg);
    for (let i = 0; i < 20; i++)
      expect(rules.process({ faceCount: null }, T0 + i * 1000)).toEqual([]);
  });

  it('FR-606: a long gap in samples breaks "continuous"', () => {
    const c = new SustainedCondition(5000, 0, 3000);
    expect(c.update(true, 0)).toBeNull();
    expect(c.update(true, 2000)).toBeNull();
    expect(c.update(true, 9000)).toBeNull(); // gap of 7 s resets the run
    expect(c.update(true, 11_000)).toBeNull();
    expect(c.update(true, 14_000)).not.toBeNull();
  });
});

describe('MULTIPLE_FACES (FR-606)', () => {
  it('FR-606: needs two consecutive samples with 2+ faces', () => {
    const got = runFace([1, 2, 1, 2, 2, 1]).filter((x) => x.e.type === 'MULTIPLE_FACES');
    expect(got).toHaveLength(1);
    expect(got[0]?.t).toBe(4);
    expect(got[0]?.e.faceCount).toBe(2);
  });
  it('FR-606: cooldown stops a spam of events while a second person stays in frame', () => {
    const got = runFace(secondsOf(25, 3)).filter((x) => x.e.type === 'MULTIPLE_FACES');
    expect(got).toHaveLength(1);
    expect(got[0]?.e.faceCount).toBe(3);
  });
});

describe('gaze (FR-606, TC-060)', () => {
  const run = (samples: (typeof GAZE_SIDE | null)[]) => {
    const rules = new GazeRules(cfg);
    return samples.flatMap((s, i) => rules.process(s, T0 + i * 1000));
  };
  it('TC-060: looking away for 7 s logs GAZE_AWAY once, after 5 s', () => {
    const got = run([...secondsOf(3, GAZE_CENTERED), ...secondsOf(7, GAZE_SIDE)]);
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({ type: 'GAZE_AWAY', durationMs: 5000 });
  });
  it('TC-060: iris-only deviation counts as looking away', () => {
    expect(run(secondsOf(7, GAZE_EYES_ONLY))).toHaveLength(1);
  });
  it('FR-606: looking down at the keyboard is not gaze away', () => {
    expect(run(secondsOf(30, GAZE_KEYBOARD))).toHaveLength(0);
  });
  it('FR-606: glancing away for 3 s then back resets the run', () => {
    expect(
      run([...secondsOf(3, GAZE_SIDE), GAZE_CENTERED, ...secondsOf(3, GAZE_SIDE)]),
    ).toHaveLength(0);
  });
  it('FR-606: no face resets the run (that is NO_FACE territory)', () => {
    expect(run([...secondsOf(4, GAZE_SIDE), null, ...secondsOf(4, GAZE_SIDE)])).toHaveLength(0);
  });
  it('FR-606: thresholds are configurable', () => {
    const strict = new GazeRules({ ...cfg, gazeYawDeg: 10, gazeAwayAfterMs: 2000 });
    const got = secondsOf(4, { yawDeg: 15, pitchDeg: 0, irisOffset: 0 }).flatMap((s, i) =>
      strict.process(s, T0 + i * 1000),
    );
    expect(got).toHaveLength(1);
  });
});

describe('pose maths (FR-606)', () => {
  const rotY = (deg: number): number[] => {
    const a = (deg * Math.PI) / 180;
    // column-major 4x4, rotation about Y
    return [
      Math.cos(a),
      0,
      -Math.sin(a),
      0,
      0,
      1,
      0,
      0,
      Math.sin(a),
      0,
      Math.cos(a),
      0,
      0,
      0,
      0,
      1,
    ];
  };
  const rotX = (deg: number): number[] => {
    const a = (deg * Math.PI) / 180;
    return [
      1,
      0,
      0,
      0,
      0,
      Math.cos(a),
      Math.sin(a),
      0,
      0,
      -Math.sin(a),
      Math.cos(a),
      0,
      0,
      0,
      0,
      1,
    ];
  };
  it('FR-606: recovers yaw and pitch from the transformation matrix', () => {
    expect(headPoseFromMatrix(rotY(30)).yawDeg).toBeCloseTo(30, 5);
    expect(headPoseFromMatrix(rotY(-20)).yawDeg).toBeCloseTo(-20, 5);
    expect(headPoseFromMatrix(rotX(15)).pitchDeg).toBeCloseTo(15, 5);
    expect(headPoseFromMatrix(rotX(0)).pitchDeg).toBeCloseTo(0, 5);
  });
  it('FR-606: iris offset is 0 centred and grows toward the corner', () => {
    const lm = (iris: number, iris2: number) => {
      const pts = Array.from({ length: 478 }, () => ({ x: 0, y: 0 }));
      pts[33] = { x: 0.3, y: 0.5 };
      pts[133] = { x: 0.4, y: 0.5 };
      pts[468] = { x: iris, y: 0.5 };
      pts[362] = { x: 0.6, y: 0.5 };
      pts[263] = { x: 0.7, y: 0.5 };
      pts[473] = { x: iris2, y: 0.5 };
      return pts;
    };
    expect(irisOffsetFromLandmarks(lm(0.35, 0.65))).toBeCloseTo(0, 5);
    expect(irisOffsetFromLandmarks(lm(0.39, 0.69))).toBeCloseTo(0.4, 5);
    expect(irisOffsetFromLandmarks([])).toBeNull();
  });
});

describe('objects (FR-606)', () => {
  const run = (frames: Parameters<ObjectRules['process']>[0][], c = cfg) => {
    const rules = new ObjectRules(c);
    return frames.flatMap((f, i) => rules.process(f, T0 + i * 2000));
  };
  it('FR-606: a single noisy frame is not a phone', () => {
    expect(run([NOTHING, PHONE_STRONG, NOTHING, NOTHING])).toHaveLength(0);
  });
  it('FR-606: 2 of 3 detections above the threshold logs PHONE_DETECTED with confidence', () => {
    const got = run([PHONE_STRONG, NOTHING, PHONE_STRONG]);
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({ type: 'PHONE_DETECTED', confidence: 0.82 });
  });
  it('FR-606: low-confidence detections are ignored, and the threshold is configurable', () => {
    expect(run(secondsOf(5, PHONE_WEAK))).toHaveLength(0);
    expect(run(secondsOf(3, PHONE_WEAK), { ...cfg, phoneConfidence: 0.4 })).toHaveLength(1);
  });
  it('FR-606: a book logs BOOK_DETECTED', () => {
    expect(run(secondsOf(3, BOOK)).map((e) => e.type)).toEqual(['BOOK_DETECTED']);
  });
});

describe('speech (FR-607, TC-061)', () => {
  it('TC-061: a 10 s segment logs SPEECH_DETECTED with its duration', () => {
    const r = new SpeechRules(cfg);
    expect(r.onSegment(T0, T0 + 10_000)).toEqual([
      { type: 'SPEECH_DETECTED', startedAtMs: T0, durationMs: 10_000 },
    ]);
  });
  it('FR-607: very short sounds are ignored and bursts are rate limited', () => {
    const r = new SpeechRules(cfg);
    expect(r.onSegment(T0, T0 + 300)).toEqual([]);
    expect(r.onSegment(T0 + 1000, T0 + 3000)).toHaveLength(1);
    expect(r.onSegment(T0 + 4000, T0 + 6000)).toHaveLength(0);
    expect(r.onSegment(T0 + 20_000, T0 + 22_000)).toHaveLength(1);
  });
});

describe('self-hosted models (FR-606, no third-party CDN)', () => {
  it('FR-606: resolves model files under the same-origin base', () => {
    const u = resolveModelUrls('/models/proctor', 'https://app.example.com');
    expect(u.faceLandmarker).toBe(
      'https://app.example.com/models/proctor/mediapipe/face_landmarker.task',
    );
    expect(u.cocoSsd).toBe('https://app.example.com/models/proctor/coco-ssd/model.json');
  });
  it('FR-606: refuses a cross-origin base', () => {
    expect(() =>
      resolveModelUrls('https://cdn.jsdelivr.net/npm/x/', 'https://app.example.com'),
    ).toThrow();
    expect(() =>
      resolveModelUrls('//storage.googleapis.com/m', 'https://app.example.com'),
    ).toThrow();
  });
});
