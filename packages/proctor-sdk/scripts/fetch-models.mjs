// Run by a human at build or deploy time, never in the candidate browser:
//   node scripts/fetch-models.mjs <outDir>      e.g. apps/web/public/dev-proctor-models (gitignored)
// Copies the vad-web and onnxruntime assets from node_modules and downloads the two MediaPipe
// model files and COCO-SSD (lite_mobilenet_v2), so the app serves every model file itself (no third-party CDN at test time).
import { cp, mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { safeChildPath } from './safe-path.mjs';

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

const tasksVision = dirname(require.resolve('@mediapipe/tasks-vision'));
await cp(join(tasksVision, 'wasm'), join(out, 'mediapipe/wasm'), { recursive: true });

const vadDist = dirname(require.resolve('@ricky0123/vad-web/package.json'));
await cp(join(vadDist, 'dist'), join(out, 'vad'), { recursive: true });
// vad-web loads onnxruntime-web wasm/mjs from the same folder (onnxWASMBasePath).
const ortDist = dirname(require.resolve('onnxruntime-web', { paths: [vadDist] }));
await cp(ortDist, join(out, 'vad'), {
  recursive: true,
  filter: (src) => src === ortDist || /\.(wasm|mjs)$/.test(src),
});
// COCO-SSD (lite_mobilenet_v2): model.json plus the weight shards it lists.
const COCO_BASE = 'https://storage.googleapis.com/tfjs-models/savedmodel/ssdlite_mobilenet_v2/';
const cocoRes = await fetch(`${COCO_BASE}model.json`);
if (!cocoRes.ok) throw new Error(`coco model.json: ${cocoRes.status}`);
const cocoJson = Buffer.from(await cocoRes.arrayBuffer());
await mkdir(join(out, 'coco-ssd'), { recursive: true });
await writeFile(join(out, 'coco-ssd/model.json'), cocoJson);
const manifest = JSON.parse(cocoJson.toString('utf8')).weightsManifest;
for (const group of manifest) {
  for (const path of group.paths) {
    // The manifest comes from a remote server: never let it choose where we write.
    const dest = safeChildPath(join(out, 'coco-ssd'), path);
    const r = await fetch(`${COCO_BASE}${path}`);
    if (!r.ok) throw new Error(`${path}: ${r.status}`);
    await writeFile(dest, Buffer.from(await r.arrayBuffer()));
  }
}
console.log(`models written to ${out}`);
