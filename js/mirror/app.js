import { HandSmoother } from '../smoothing.js';
import { FloorEstimator } from './floor.js';
import { Skeleton3D, P } from './skeleton3d.js';
import { StillnessWatch } from './stillness.js';

/* ------------------------------------------------------------------ config */

const MEDIAPIPE_VERSION = '1.0.1';
const CDN = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MEDIAPIPE_VERSION}`;
const LOCAL = new URLSearchParams(location.search).get('assets') === 'local';
const here = (path) => new URL(path, document.baseURI).href;

const ASSETS = {
  bundle: LOCAL ? here('vendor/vision_bundle.mjs') : `${CDN}/vision_bundle.mjs`,
  wasm: LOCAL ? here('vendor/wasm') : `${CDN}/wasm`,
  model: LOCAL
    ? here('vendor/pose_landmarker_lite.task')
    : 'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task',
};

const MAX_PEOPLE = 3;
const MAX_DPR = 2;

/* ------------------------------------------------------------------- state */

const el = {
  video: document.getElementById('video'),
  canvas: document.getElementById('stage'),
  gl: document.getElementById('gl'),
  mask: document.getElementById('maskbuf'),
  splash: document.getElementById('splash'),
  splashMsg: document.getElementById('splashMsg'),
  btnStart: document.getElementById('btnStart'),
  idle: document.getElementById('idle'),
  hud: document.getElementById('hud'),
  stat: document.getElementById('stat'),
};

const ctx = el.canvas.getContext('2d');
const maskCtx = el.mask.getContext('2d', { willReadFrequently: true });

const smoother = new HandSmoother(0.6);
const worldSmoother = new HandSmoother(0.6);
const skeleton = new Skeleton3D(el.gl, { maxPeople: MAX_PEOPLE });
const floor = new FloorEstimator();
const stillness = new StillnessWatch();

const state = {
  model: null,
  stream: null,
  facing: 'user',
  running: false,
  lastVideoTime: -1,
  lastTimestamp: -1,
  lastFrame: 0,
  people: [],            // [{ key, pts, world, span, floorY }]
  eraseBody: true,
  maskReady: false,
  showVideo: true,
  debugFloor: false,
};

/* ------------------------------------------------------------------ canvas */

function resize() {
  const dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR);
  const w = el.canvas.clientWidth;
  const h = el.canvas.clientHeight;
  if (!w || !h) return;
  const bw = Math.round(w * dpr);
  const bh = Math.round(h * dpr);
  if (el.canvas.width !== bw || el.canvas.height !== bh) {
    el.canvas.width = bw;
    el.canvas.height = bh;
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  skeleton.resize(w, h, dpr);
}

const isMirrored = () => state.facing === 'user';

/** Reproduces the `object-fit: cover` crop the browser applies to the video. */
function makeMapper(videoW, videoH, viewW, viewH) {
  const scale = Math.max(viewW / videoW, viewH / videoH);
  const drawnW = videoW * scale;
  const drawnH = videoH * scale;
  const offsetX = (viewW - drawnW) / 2;
  const offsetY = (viewH - drawnH) / 2;
  const mirrored = isMirrored();
  return (lm) => {
    const x = offsetX + lm.x * drawnW;
    return { x: mirrored ? viewW - x : x, y: offsetY + lm.y * drawnH };
  };
}

/* ------------------------------------------------------------------- model */

async function loadModel() {
  const { FilesetResolver, PoseLandmarker } = await import(ASSETS.bundle);
  const fileset = await FilesetResolver.forVisionTasks(ASSETS.wasm);

  const options = (delegate) => ({
    baseOptions: { modelAssetPath: ASSETS.model, delegate },
    runningMode: 'VIDEO',
    numPoses: MAX_PEOPLE,
    outputSegmentationMasks: true,
    minPoseDetectionConfidence: 0.5,
    minPosePresenceConfidence: 0.5,
    minTrackingConfidence: 0.5,
  });

  try {
    return await PoseLandmarker.createFromOptions(fileset, options('GPU'));
  } catch (err) {
    console.warn('GPU delegate unavailable, falling back to CPU:', err);
    return await PoseLandmarker.createFromOptions(fileset, options('CPU'));
  }
}

/* ------------------------------------------------------------------ camera */

async function startCamera(facing) {
  stopCamera();
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { facingMode: { ideal: facing }, width: { ideal: 1280 }, height: { ideal: 720 } },
    });
  } catch (err) {
    if (err?.name === 'OverconstrainedError' || err?.name === 'NotFoundError') {
      stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: true });
    } else throw err;
  }

  state.stream = stream;
  el.video.srcObject = stream;
  await new Promise((r) => {
    if (el.video.readyState >= 2 && el.video.videoWidth) return r();
    el.video.addEventListener('loadedmetadata', r, { once: true });
  });
  await el.video.play();

  state.facing = stream.getVideoTracks()[0]?.getSettings?.().facingMode || facing;
  el.video.classList.toggle('mirrored', isMirrored());
  smoother.reset();
  floor.reset();
  resize();
}

function stopCamera() {
  if (state.stream) for (const t of state.stream.getTracks()) t.stop();
  state.stream = null;
  el.video.srcObject = null;
}

/* -------------------------------------------------------------- body erase */

/**
 * Paint the tracked people out of the picture.
 *
 * This is what sells the illusion: the room stays visible, but where a person
 * is standing there is a person-shaped hole, with bones inside it. Drawing
 * bones over an ordinary video just looks like a filter.
 */
/**
 * Bake the frame's masks into a reusable canvas.
 *
 * This has to happen inside the detection branch: MediaPipe's mask objects are
 * only valid until the next detect call, and the render loop draws on every
 * frame, not just the ones that produced a new detection. Reading them later
 * silently yields nothing, which is why the body stayed visible.
 */
function bakeMask(masks) {
  if (!masks || !masks.length) { state.maskReady = false; return; }

  const mw = masks[0].width;
  const mh = masks[0].height;
  if (!mw || !mh) { state.maskReady = false; return; }

  if (el.mask.width !== mw || el.mask.height !== mh) {
    el.mask.width = mw;
    el.mask.height = mh;
  }

  const image = maskCtx.createImageData(mw, mh);
  const out = image.data;

  for (const mask of masks) {
    // Uint8 where the runtime offers it; the float path is the fallback.
    const arr = mask.getAsUint8Array ? mask.getAsUint8Array() : mask.getAsFloat32Array();
    const scale = arr instanceof Float32Array ? 255 : 1;
    for (let i = 0; i < arr.length; i++) {
      const a = arr[i] * scale;
      const at = i * 4 + 3;
      if (a > out[at]) out[at] = a;          // rgb stays 0, so the body goes black
    }
    mask.close?.();
  }

  maskCtx.putImageData(image, 0, 0);
  state.maskReady = true;
}

/** Paint the baked silhouette over the picture, cover-fitted and mirrored. */
function eraseBodies(viewW, viewH) {
  if (!state.maskReady) return;

  const mw = el.mask.width;
  const mh = el.mask.height;
  const scale = Math.max(viewW / mw, viewH / mh);
  const dw = mw * scale;
  const dh = mh * scale;

  ctx.save();
  if (isMirrored()) {
    ctx.translate(viewW, 0);
    ctx.scale(-1, 1);
  }
  ctx.globalAlpha = 0.97;
  ctx.drawImage(el.mask, (viewW - dw) / 2, (viewH - dh) / 2, dw, dh);
  ctx.restore();
}

/* -------------------------------------------------------------- main loop */

function loop() {
  requestAnimationFrame(loop);
  if (!state.running) return;

  const now = performance.now();
  const dtMs = state.lastFrame ? now - state.lastFrame : 16;
  state.lastFrame = now;
  resize();

  const vw = el.video.videoWidth;
  const vh = el.video.videoHeight;
  if (!vw || !vh) return;

  const viewW = el.canvas.clientWidth;
  const viewH = el.canvas.clientHeight;

  if (el.video.currentTime !== state.lastVideoTime) {
    state.lastVideoTime = el.video.currentTime;
    const ts = now > state.lastTimestamp ? now : state.lastTimestamp + 1;
    state.lastTimestamp = ts;

    try {
      const result = state.model.detectForVideo(el.video, ts);
      bakeMask(result.segmentationMasks);

      const raw = result.landmarks || [];
      const rawWorld = result.worldLandmarks || [];
      // Pose results have no identity, so index is the only stable key we get.
      const keys = raw.map((_, i) => `p${i}`);
      const smoothed = smoother.apply(raw, [], keys, now);
      // The metric landmarks drive the 3D rig and need the same steadying, but
      // they live in a different space, so they get their own filter bank.
      const smoothedWorld = worldSmoother.apply(rawWorld, [], keys, now);

      const mapper = makeMapper(vw, vh, viewW, viewH);
      state.people = smoothed.hands.map((landmarks, i) => {
        const pts = landmarks.map(mapper);
        // Torso span in screen pixels: the scale everything else is measured in.
        const spanPx = Math.hypot(
          (pts[P.shoulderL].x + pts[P.shoulderR].x) / 2 - (pts[P.hipL].x + pts[P.hipR].x) / 2,
          (pts[P.shoulderL].y + pts[P.shoulderR].y) / 2 - (pts[P.hipL].y + pts[P.hipR].y) / 2,
        ) || 1;
        const f = floor.update(keys[i], landmarks, now);
        const floorPx = f ? mapper({ x: 0.5, y: f.y }).y : viewH;
        return {
          key: keys[i], landmarks, pts, world: smoothedWorld.hands[i],
          span: spanPx, floorY: floorPx, floorSource: f?.source,
        };
      });
      floor.prune(now);
    } catch (err) {
      console.error('pose detection failed', err);
    }
  }

  /* ---- draw ---- */
  ctx.clearRect(0, 0, viewW, viewH);
  if (state.eraseBody) eraseBodies(viewW, viewH);

  let posed = 0;
  for (const person of state.people) {
    const world = person.world;
    if (!world || world.length < 33) continue;

    /* Fit the 3D rig onto the person in the picture.
     *
     * The world landmarks describe the body's shape in metres but say nothing
     * about where it sits on screen. So the torso gives the conversion: however
     * many pixels the shoulder-to-hip span covers in the video is how many
     * pixels a metre is worth, and the rig is then pushed to whatever distance
     * makes that true and slid so the hips line up. */
    const torsoMetres = Math.hypot(
      (world[P.shoulderL].x + world[P.shoulderR].x) / 2 - (world[P.hipL].x + world[P.hipR].x) / 2,
      (world[P.shoulderL].y + world[P.shoulderR].y) / 2 - (world[P.hipL].y + world[P.hipR].y) / 2,
      (world[P.shoulderL].z + world[P.shoulderR].z) / 2 - (world[P.hipL].z + world[P.hipR].z) / 2,
    );
    if (!(torsoMetres > 0.05)) continue;

    const hipX = (person.pts[P.hipL].x + person.pts[P.hipR].x) / 2;
    const hipY = (person.pts[P.hipL].y + person.pts[P.hipR].y) / 2;

    skeleton.pose(posed, world, {
      pixelsPerMetre: person.span / torsoMetres,
      screenX: hipX,
      screenY: hipY,
      viewW,
      viewH,
      mirrored: isMirrored(),
    });
    posed++;

    if (state.debugFloor) {
      ctx.save();
      ctx.strokeStyle = 'rgba(0,255,170,.6)';
      ctx.setLineDash([8, 8]);
      ctx.beginPath();
      ctx.moveTo(0, person.floorY);
      ctx.lineTo(viewW, person.floorY);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = 'rgba(0,255,170,.9)';
      ctx.font = '12px system-ui';
      ctx.fillText(`floor: ${person.floorSource}`, 12, person.floorY - 8);
      ctx.restore();
    }
  }

  skeleton.hideFrom(posed);
  skeleton.render();

  el.idle.classList.toggle('hidden', state.people.length > 0);
  if (el.hud && !el.hud.classList.contains('hidden')) {
    el.stat.textContent = `${state.people.length} ${state.people.length === 1 ? 'body' : 'bodies'}`;
  }
}

/* ---------------------------------------------------------------- startup */

async function start() {
  el.btnStart.disabled = true;
  el.btnStart.classList.add('loading');

  if (!window.isSecureContext) {
    return fail('Camera access needs HTTPS (or localhost).');
  }
  try {
    el.splashMsg.textContent = 'Waking the dead…';
    // The skeleton is a 13 MB anatomical model; load it alongside the detector
    // rather than after it, so first paint is never a body with no bones.
    const [model] = await Promise.all([
      state.model || loadModel(),
      skeleton.ready,
    ]);
    state.model = model;
    el.splashMsg.textContent = 'Waiting for camera permission…';
    await startCamera(state.facing);
  } catch (err) {
    console.error(err);
    return fail(err?.name === 'NotAllowedError'
      ? 'Camera permission denied. Allow it for this site and try again.'
      : `Could not start: ${err?.message || err}`);
  }

  el.splash.classList.add('hidden');
  setTimeout(() => el.splash.classList.add('gone'), 500);
  el.hud.classList.remove('hidden');
  state.running = true;
  state.lastFrame = performance.now();
  requestAnimationFrame(loop);
}

function fail(message) {
  el.splashMsg.textContent = message;
  el.splashMsg.classList.add('error');
  el.btnStart.disabled = false;
  el.btnStart.classList.remove('loading');
  el.btnStart.textContent = 'Try again';
}

el.btnStart.addEventListener('click', start);
window.addEventListener('resize', resize);

// Keys for running the installation: v toggles the camera, b the body erase,
// f the floor debug line, c forces a collapse.
window.addEventListener('keydown', (e) => {
  if (e.key === 'v') { state.showVideo = !state.showVideo; document.body.classList.toggle('no-video', !state.showVideo); }
  if (e.key === 'b') state.eraseBody = !state.eraseBody;
  if (e.key === 'f') state.debugFloor = !state.debugFloor;
  // 'c' will force a collapse once the 3D version of it lands.
});

window.__mirror = { state, floor, smoother, worldSmoother, stillness, skeleton, makeMapper, el };
