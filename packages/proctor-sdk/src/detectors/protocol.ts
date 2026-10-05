import type { ObjectDetection, Point } from './rules';

export type InferenceTask = 'face' | 'gaze' | 'objects';

export interface InitMessage {
  type: 'init';
  tasks: InferenceTask[];
  urls: { faceDetector: string; faceLandmarker: string; mediapipeWasm: string; cocoSsd: string };
}
export interface FrameMessage {
  type: 'frame';
  id: number;
  bitmap: ImageBitmap;
  tasks: InferenceTask[];
}
export type ToWorker = InitMessage | FrameMessage;

export interface ReadyMessage {
  type: 'ready';
  /** Per task: true when the model loaded. A false is reported as DETECTOR_UNAVAILABLE. */
  loaded: Record<InferenceTask, boolean>;
}
export interface ResultMessage {
  type: 'result';
  id: number;
  faceCount?: number;
  gaze?: { yawDeg: number; pitchDeg: number; irisOffset: number } | null;
  objects?: ObjectDetection[];
  /** Time spent in inference inside the worker, for CPU reporting. */
  busyMs: number;
  /** Tasks that threw at runtime. */
  failed?: InferenceTask[];
}
export type FromWorker = ReadyMessage | ResultMessage;

export type { Point };
