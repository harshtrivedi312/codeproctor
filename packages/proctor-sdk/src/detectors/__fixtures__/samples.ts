import type { GazeSample, ObjectDetection } from '../rules';

/** One entry per second, like the 1 s webcam cadence (FR-606). */
export const secondsOf = <T>(n: number, v: T): T[] => Array.from({ length: n }, () => v);

export const FACE_PRESENT = 1;
export const FACE_ABSENT = 0;

/** Recorded-style sequence: candidate leans out of frame for 7 s, comes back, leaves for 3 s. */
export const NO_FACE_SEQUENCE: number[] = [
  ...secondsOf(10, FACE_PRESENT),
  ...secondsOf(7, FACE_ABSENT),
  ...secondsOf(5, FACE_PRESENT),
  ...secondsOf(3, FACE_ABSENT),
  ...secondsOf(5, FACE_PRESENT),
];

export const GAZE_CENTERED: GazeSample = { yawDeg: 3, pitchDeg: -5, irisOffset: 0.05 };
export const GAZE_KEYBOARD: GazeSample = { yawDeg: 2, pitchDeg: -28, irisOffset: 0.08 };
export const GAZE_SIDE: GazeSample = { yawDeg: 38, pitchDeg: 0, irisOffset: 0.1 };
export const GAZE_EYES_ONLY: GazeSample = { yawDeg: 4, pitchDeg: 0, irisOffset: 0.3 };

export const PHONE_STRONG: ObjectDetection[] = [{ class: 'cell phone', score: 0.82 }];
export const PHONE_WEAK: ObjectDetection[] = [{ class: 'cell phone', score: 0.41 }];
export const BOOK: ObjectDetection[] = [{ class: 'book', score: 0.58 }];
export const NOTHING: ObjectDetection[] = [{ class: 'cup', score: 0.9 }];
