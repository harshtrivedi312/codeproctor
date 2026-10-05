/// <reference lib="webworker" />
/**
 * Inference worker (FR-606): MediaPipe FaceDetector and FaceLandmarker, TensorFlow.js COCO-SSD.
 * Everything heavy runs here so the editor thread stays free. Models load from the self-hosted
 * URLs in the init message; nothing is fetched from a CDN. Only raw results leave the worker; the
 * thresholds and debouncing live in rules.ts on the main thread.
 */
import { FaceDetector, FaceLandmarker, FilesetResolver } from '@mediapipe/tasks-vision';
import * as cocoSsd from '@tensorflow-models/coco-ssd';
import '@tensorflow/tfjs-backend-cpu';
import '@tensorflow/tfjs-backend-webgl';
import { setBackend } from '@tensorflow/tfjs-core';
import type { FromWorker, InferenceTask, InitMessage, ResultMessage, ToWorker } from '../protocol';
import { headPoseFromMatrix, irisOffsetFromLandmarks } from '../rules';

const ctx = self as unknown as DedicatedWorkerGlobalScope;

let detector: FaceDetector | null = null;
let landmarker: FaceLandmarker | null = null;
let coco: cocoSsd.ObjectDetection | null = null;

async function withDelegateFallback<T>(make: (delegate: 'GPU' | 'CPU') => Promise<T>): Promise<T> {
  try {
    return await make('GPU');
  } catch {
    return make('CPU');
  }
}

async function init(msg: InitMessage): Promise<void> {
  const loaded: Record<InferenceTask, boolean> = { face: false, gaze: false, objects: false };
  const wanted = new Set(msg.tasks);
  if (wanted.has('face') || wanted.has('gaze')) {
    const fileset = await FilesetResolver.forVisionTasks(msg.urls.mediapipeWasm);
    if (wanted.has('face')) {
      try {
        detector = await withDelegateFallback((delegate) =>
          FaceDetector.createFromOptions(fileset, {
            baseOptions: { modelAssetPath: msg.urls.faceDetector, delegate },
            runningMode: 'IMAGE',
          }),
        );
        loaded.face = true;
      } catch {
        loaded.face = false;
      }
    }
    if (wanted.has('gaze')) {
      try {
        landmarker = await withDelegateFallback((delegate) =>
          FaceLandmarker.createFromOptions(fileset, {
            baseOptions: { modelAssetPath: msg.urls.faceLandmarker, delegate },
            runningMode: 'IMAGE',
            numFaces: 1,
            outputFacialTransformationMatrixes: true,
          }),
        );
        loaded.gaze = true;
      } catch {
        loaded.gaze = false;
      }
    }
  }
  if (wanted.has('objects')) {
    try {
      try {
        await setBackend('webgl');
      } catch {
        await setBackend('cpu');
      }
      coco = await cocoSsd.load({ base: 'lite_mobilenet_v2', modelUrl: msg.urls.cocoSsd });
      loaded.objects = true;
    } catch {
      loaded.objects = false;
    }
  }
  post({ type: 'ready', loaded });
}

function post(m: FromWorker): void {
  ctx.postMessage(m);
}

function toImageData(bitmap: ImageBitmap): ImageData {
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const g = canvas.getContext('2d');
  if (!g) throw new Error('no 2d context');
  g.drawImage(bitmap, 0, 0);
  return g.getImageData(0, 0, bitmap.width, bitmap.height);
}

async function frame(id: number, bitmap: ImageBitmap, tasks: InferenceTask[]): Promise<void> {
  const t0 = performance.now();
  const out: ResultMessage = { type: 'result', id, busyMs: 0 };
  const failed: InferenceTask[] = [];
  try {
    if (tasks.includes('face') && detector) {
      try {
        out.faceCount = detector.detect(bitmap).detections.length;
      } catch {
        failed.push('face');
      }
    }
    if (tasks.includes('gaze') && landmarker) {
      try {
        const r = landmarker.detect(bitmap);
        const lm = r.faceLandmarks[0];
        const matrix = r.facialTransformationMatrixes[0];
        const iris = lm ? irisOffsetFromLandmarks(lm) : null;
        out.gaze =
          lm && matrix && iris !== null
            ? { ...headPoseFromMatrix(matrix.data), irisOffset: iris }
            : null;
      } catch {
        failed.push('gaze');
      }
    }
    if (tasks.includes('objects') && coco) {
      try {
        const dets = await coco.detect(toImageData(bitmap), 10, 0.3);
        out.objects = dets.map((d) => ({ class: d.class, score: d.score }));
      } catch {
        failed.push('objects');
      }
    }
  } finally {
    bitmap.close();
  }
  out.busyMs = performance.now() - t0;
  if (failed.length) out.failed = failed;
  post(out);
}

ctx.onmessage = (e: MessageEvent<ToWorker>) => {
  const m = e.data;
  if (m.type === 'init') void init(m);
  else void frame(m.id, m.bitmap, m.tasks);
};
