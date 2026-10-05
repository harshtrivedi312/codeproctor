// Run by a human at build or deploy time, never in the candidate browser:
//   node scripts/fetch-models.mjs <outDir>      e.g. apps/web/public/models/proctor
// Copies the vad-web and onnxruntime assets from node_modules and downloads the two MediaPipe
// model files, so the app serves every model file itself (no third-party CDN at test time).
// COCO-SSD weights (coco-ssd/model.json plus its shards) are NOT handled here; see
// docs/followups/proctor-sdk.md.
import { cp, mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

const out = process.argv[2];
if (!out) throw new Error('usage: fetch-models.mjs <outDir>');
const require = createRequire(import.meta.url);

const MEDIAPIPE = {
  'mediapipe/blaze_face_short_range.tflite':
    'https://storage.googleapis.com/mediapipe-models/face_detector/blaze_face_short_range/float16/1/blaze_face_short_range.tflite',
  'mediapipe/face_landmarker.task':
    'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task',
};

for (const [rel, url] of Object.entries(MEDIAPIPE)) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: ${res.status}`);
  const dest = join(out, rel);
  await mkdir(dirname(dest), { recursive: true });
  await writeFile(dest, Buffer.from(await res.arrayBuffer()));
}

const tasksVision = dirname(require.resolve('@mediapipe/tasks-vision/package.json'));
await cp(join(tasksVision, 'wasm'), join(out, 'mediapipe/wasm'), { recursive: true });

const vadDist = dirname(require.resolve('@ricky0123/vad-web/package.json'));
await cp(join(vadDist, 'dist'), join(out, 'vad'), { recursive: true });
console.log(`models written to ${out}`);
