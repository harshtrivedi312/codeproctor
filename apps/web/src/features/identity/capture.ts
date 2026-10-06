/**
 * Image capture and upload helpers for the identity step (FR-403, ADR 0004, ADR 0013 section 5.6).
 * Images are JPEG, at most 5 MiB, and are held in memory only until they are uploaded: never in
 * storage of any kind, never logged. Upload URLs are never logged.
 */
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_EDGE_PX = 1600;

export const LIVENESS_PROMPTS = [
  { id: 'BLINK', text: 'Look at the camera and blink twice.' },
  { id: 'TURN_LEFT', text: 'Slowly turn your head to your left, then face the camera again.' },
  { id: 'TURN_RIGHT', text: 'Slowly turn your head to your right, then face the camera again.' },
] as const;

export interface IdentityDeps {
  /** Opens the webcam. Must be called from a click. */
  openCamera: () => Promise<MediaStream>;
  /** Takes a JPEG from a playing video. */
  snapshot: (video: HTMLVideoElement) => Promise<Blob>;
  /** Turns a chosen file (ID photo only) into a JPEG within the size limit. */
  fileToJpeg: (file: File) => Promise<Blob>;
  /** PUTs the image to the presigned URL. Returns false on any failure. */
  upload: (url: string, headers: Record<string, string>, body: Blob) => Promise<boolean>;
}

function canvasToJpeg(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error('encode'))),
      'image/jpeg',
      0.9,
    );
  });
}

function scaled(w: number, h: number): { w: number; h: number } {
  const ratio = Math.min(1, MAX_EDGE_PX / Math.max(w, h));
  return { w: Math.max(1, Math.round(w * ratio)), h: Math.max(1, Math.round(h * ratio)) };
}

export const defaultIdentityDeps: IdentityDeps = {
  openCamera: () =>
    navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: false,
    }),
  snapshot: async (video) => {
    const { w, h } = scaled(video.videoWidth || 640, video.videoHeight || 480);
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    canvas.getContext('2d')?.drawImage(video, 0, 0, w, h);
    return canvasToJpeg(canvas);
  },
  fileToJpeg: async (file) => {
    const bitmap = await createImageBitmap(file);
    const { w, h } = scaled(bitmap.width, bitmap.height);
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    canvas.getContext('2d')?.drawImage(bitmap, 0, 0, w, h);
    bitmap.close();
    return canvasToJpeg(canvas);
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
      return response.ok;
    } catch {
      return false;
    }
  },
};
