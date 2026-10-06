/**
 * Room scan capture and upload (FR-404; ADR 0013 section 5.5, stream ROOM_SCAN, state CONSENTED).
 *
 * The proctor SDK's recording pipeline covers SCREEN, WEBCAM and AUDIO for a running session and
 * has no ROOM_SCAN stream, so this small recorder sits behind an interface (see
 * docs/followups/frontend.md). The clip is video only, one `video/webm` chunk of at most 60 s
 * (the wire limit), held in memory until it is uploaded and then dropped.
 */
export const MAX_CLIP_MS = 60_000;
/** Stop a second early so the measured duration is never clamped to the wire limit. */
export const AUTO_STOP_MS = MAX_CLIP_MS - 1000;
/** About 1.2 Mbps: 60 s is then about 9 MiB, under the 16 MiB chunk limit (Chrome's default is higher). */
export const VIDEO_BITS_PER_SECOND = 1_200_000;
export const MAX_CLIP_BYTES = 16 * 1024 * 1024;

export interface RoomClip {
  blob: Blob;
  durationMs: number;
  startedAt: Date;
}

export interface RoomRecorder {
  /** Stops recording and resolves with the clip. */
  stop: () => Promise<RoomClip>;
}

export type UploadOutcome = 'ok' | 'exists' | 'failed';

export interface RoomScanDeps {
  /** Opens the webcam (rear camera preferred where there is one). Needs a click. */
  openCamera: () => Promise<MediaStream>;
  startRecording: (stream: MediaStream) => RoomRecorder;
  /** PUTs the clip to the presigned URL. 412 (already stored) is reported as `exists`. */
  upload: (url: string, headers: Record<string, string>, body: Blob) => Promise<UploadOutcome>;
}

function pickMime(): string | undefined {
  if (typeof MediaRecorder === 'undefined') return undefined;
  return ['video/webm;codecs=vp8', 'video/webm'].find((m) => MediaRecorder.isTypeSupported(m));
}

export const defaultRoomScanDeps: RoomScanDeps = {
  openCamera: () =>
    navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: { ideal: 'environment' },
        width: { ideal: 1280 },
        height: { ideal: 720 },
      },
      audio: false,
    }),
  startRecording: (stream) => {
    const mimeType = pickMime();
    const recorder = new MediaRecorder(stream, {
      videoBitsPerSecond: VIDEO_BITS_PER_SECOND,
      ...(mimeType ? { mimeType } : {}),
    });
    const parts: Blob[] = [];
    const startedAt = new Date();
    const t0 = performance.now();
    recorder.ondataavailable = (e) => {
      if (e.data.size > 0) parts.push(e.data);
    };
    recorder.start();
    return {
      stop: () =>
        new Promise<RoomClip>((resolve) => {
          recorder.onstop = () =>
            resolve({
              // The wire carries the bare type, with no codecs parameter (ADR 0013 section 5.5).
              blob: new Blob(parts, { type: 'video/webm' }),
              durationMs: Math.max(1, Math.min(MAX_CLIP_MS, Math.round(performance.now() - t0))),
              startedAt,
            });
          if (recorder.state !== 'inactive') recorder.stop();
          else recorder.onstop?.(new Event('stop'));
        }),
    };
  },
  upload: async (url, headers, body) => {
    try {
      const response = await fetch(url, {
        method: 'PUT',
        headers,
        body,
        credentials: 'omit',
        referrerPolicy: 'no-referrer',
      });
      if (response.status === 412) return 'exists';
      return response.ok ? 'ok' : 'failed';
    } catch {
      return 'failed';
    }
  },
};

/** Guided steps. Candidate-paced: nothing moves on a timer, so slower candidates are never rushed. */
export const ROTATE_STEPS = [
  'Point the camera at your desk and the area around it. Hold still for a moment.',
  'Slowly turn a quarter turn to your left and show what is there.',
  'Keep turning to the next quarter, until you face the wall behind you.',
  'Keep turning to the last quarter, on your right.',
  'Turn back to your desk. Slowly show the desk surface: your keyboard, your hands and everything on the desk.',
] as const;

/** For a candidate who cannot rotate the camera: a still view and the desk. */
export const STATIONARY_STEPS = [
  'From where you sit, hold the camera still and show as much of the room as you can.',
  'Now show the desk surface: your keyboard, your hands and everything on the desk.',
] as const;

/**
 * ROOM_SCAN chunk numbers. The server keeps `seq` unique and increasing per stream across segments
 * (database.md UNIQUE(session_id, stream, seq); ADR 0013 section 5.5 answers a reused seq with 409
 * SEQ_CONFLICT), so every clip gets a fresh number and segment = seq. The counter lives in memory
 * for the page's life, so it survives the step closing and reopening. After a reload it starts at 0
 * again; the sender then follows the server's answers (SEQ_CONFLICT, alreadyUploaded) and advances.
 */
let nextRoomSeq = 0;
export function currentRoomSeq(): number {
  return nextRoomSeq;
}
export function advanceRoomSeq(): number {
  nextRoomSeq = Math.min(9_999, nextRoomSeq + 1);
  return nextRoomSeq;
}
export function resetRoomSeq(): void {
  nextRoomSeq = 0;
}
