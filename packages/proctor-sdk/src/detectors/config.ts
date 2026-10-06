/**
 * Owner decision C-08: the identity re-check is one JPEG, 640 px wide, every 2 minutes, kept by the
 * server only on a mismatch. The capture only scales DOWN (`scaledSize`), so a webcam narrower than
 * 640 px yields a narrower frame; the recorder asks the camera for 640x360, so this is the normal
 * width. Evidence snapshots for HIGH events use the same width.
 */
export const IDENTITY_FRAME_WIDTH_PX = 640;
export const IDENTITY_RECHECK_INTERVAL_MS = 120_000;

/** Thresholds and cadences for the in-browser AI detectors (FR-606, FR-607). All configurable. */
export interface AiDetectorConfig {
  /** Webcam frame analysis cadence (FR-606: every 1 s). */
  faceIntervalMs: number;
  gazeIntervalMs: number;
  objectIntervalMs: number;
  /** NO_FACE and GAZE_AWAY fire after this much continuous time (FR-606: over 5 s). */
  noFaceAfterMs: number;
  gazeAwayAfterMs: number;
  /** Do not repeat the same event type inside this window. */
  cooldownMs: number;
  /** MULTIPLE_FACES needs this many consecutive samples with 2 or more faces. */
  multipleFacesSamples: number;
  /** Gaze: head turned more than this (degrees) or iris off centre more than this ratio. */
  gazeYawDeg: number;
  gazePitchDownDeg: number;
  gazePitchUpDeg: number;
  gazeIrisOffset: number;
  /** COCO-SSD confidence thresholds. */
  phoneConfidence: number;
  bookConfidence: number;
  /** Object must be seen in this many of the last `objectWindow` detections. */
  objectHits: number;
  objectWindow: number;
  /** Speech shorter than this is ignored (coughs, clicks). */
  minSpeechMs: number;
  /** Identity re-check cadence (FR-606: periodic re-check against selfie). */
  identityIntervalMs: number;
  /** Max width of snapshot and re-check JPEGs (C-08: 640 px); images are never scaled up. */
  snapshotMaxWidth: number;
  snapshotQuality: number;
  /** Wait at most this long for evidence upload before sending the event without it. */
  evidenceTimeoutMs: number;
}

export const DEFAULT_AI_CONFIG: Readonly<AiDetectorConfig> = {
  faceIntervalMs: 1000,
  gazeIntervalMs: 1000,
  objectIntervalMs: 2000,
  noFaceAfterMs: 5000,
  gazeAwayAfterMs: 5000,
  cooldownMs: 30_000,
  multipleFacesSamples: 2,
  gazeYawDeg: 25,
  gazePitchDownDeg: 35, // looking down at the keyboard is normal while coding
  gazePitchUpDeg: 20,
  gazeIrisOffset: 0.18,
  phoneConfidence: 0.6,
  bookConfidence: 0.5,
  objectHits: 2,
  objectWindow: 3,
  minSpeechMs: 800,
  identityIntervalMs: IDENTITY_RECHECK_INTERVAL_MS,
  snapshotMaxWidth: IDENTITY_FRAME_WIDTH_PX,
  snapshotQuality: 0.7,
  evidenceTimeoutMs: 3000,
};

export interface ModelUrls {
  faceDetector: string;
  faceLandmarker: string;
  mediapipeWasm: string;
  cocoSsd: string;
  vadAssets: string;
  onnxWasm: string;
}

/**
 * Model files are self-hosted (no third-party CDN at test time). The base must be a same-origin
 * path or URL; a cross-origin base throws, so a misconfiguration fails loudly in staging instead
 * of silently calling a CDN with candidate traffic.
 */
export function resolveModelUrls(baseUrl: string, origin: string = location.origin): ModelUrls {
  const base = new URL(baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`, `${origin}/`);
  if (base.origin !== origin) {
    throw new Error('Model base URL must be same-origin (self-hosted models only).');
  }
  const u = (p: string): string => new URL(p, base).toString();
  return {
    faceDetector: u('mediapipe/blaze_face_short_range.tflite'),
    faceLandmarker: u('mediapipe/face_landmarker.task'),
    mediapipeWasm: u('mediapipe/wasm'),
    cocoSsd: u('coco-ssd/model.json'),
    vadAssets: u('vad/'),
    onnxWasm: u('vad/'),
  };
}
