/**
 * Downloads the MediaPipe runtime and hand-landmark model into ./vendor.
 *
 * The app loads these from a CDN in normal use; the local copies exist so the
 * test suite can exercise the real pipeline without reaching the network.
 * ./vendor is gitignored (~42 MB).
 */
import { mkdirSync, createWriteStream, existsSync, statSync } from 'fs';
import { pipeline } from 'stream/promises';
import { Readable } from 'stream';
import { execFileSync } from 'child_process';

const VERSION = '1.0.1';
const OUT = new URL('../vendor/', import.meta.url).pathname;
const MODEL_URL =
  'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task';
const POSE_MODEL_URL =
  'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task';

mkdirSync(OUT + 'wasm', { recursive: true });

async function download(url, dest) {
  if (existsSync(dest) && statSync(dest).size > 0) {
    console.log(`  exists  ${dest.replace(OUT, '')}`);
    return;
  }
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`);
  await pipeline(Readable.fromWeb(res.body), createWriteStream(dest));
  console.log(`  saved   ${dest.replace(OUT, '')}  (${(statSync(dest).size / 1048576).toFixed(1)} MB)`);
}

console.log(`Fetching @mediapipe/tasks-vision@${VERSION} from the npm registry...`);
execFileSync('npm', ['pack', `@mediapipe/tasks-vision@${VERSION}`, '--pack-destination', OUT], { stdio: 'inherit' });
execFileSync('tar', ['xzf', `${OUT}mediapipe-tasks-vision-${VERSION}.tgz`, '-C', OUT], { stdio: 'inherit' });
execFileSync('sh', ['-c', `cp ${OUT}package/vision_bundle.mjs ${OUT} && cp ${OUT}package/wasm/* ${OUT}wasm/ && rm -rf ${OUT}package ${OUT}*.tgz`]);
console.log('  saved   vision_bundle.mjs + wasm/');

console.log('Fetching the hand-landmark model...');
await download(MODEL_URL, OUT + 'hand_landmarker.task');

console.log('Fetching the pose-landmark model (Skeleton Mirror)...');
await download(POSE_MODEL_URL, OUT + 'pose_landmarker_lite.task');

// Photographs of real hands, used as the fake camera feed in the test suite.
// Downloaded rather than committed so we are not redistributing them.
console.log('Fetching test fixtures...');
mkdirSync(OUT + 'fixtures', { recursive: true });
for (const name of ['right_hands.jpg', 'pointing_up.jpg', 'pose.jpg']) {
  await download(`https://storage.googleapis.com/mediapipe-assets/${name}`, `${OUT}fixtures/${name}`);
}

console.log('\nDone. Run `npm test` to exercise the pipeline against ./vendor.');
