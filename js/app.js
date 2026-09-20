import { drawHands, makeMapper, STYLES } from './skeleton.js';
import { HandSmoother } from './smoothing.js';
import { AirCanvas, PALETTE } from './drawing.js';
import { Hand3DView } from './hand3d.js';

/* ------------------------------------------------------------------ config */

const MEDIAPIPE_VERSION = '1.0.1';
const CDN = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MEDIAPIPE_VERSION}`;

// `?assets=local` swaps the CDN for the copies under /vendor, which is how the
// test harness runs the whole pipeline without network access.
const assetsParam = new URLSearchParams(location.search).get('assets');
const LOCAL = assetsParam === 'local';

// Resolve against the document, not this module: a bare './vendor/...' inside
// js/app.js would resolve to /js/vendor/...
const local = (path) => new URL(path, document.baseURI).href;

const ASSETS = {
  bundle: LOCAL ? local('vendor/vision_bundle.mjs') : `${CDN}/vision_bundle.mjs`,
  wasm: LOCAL ? local('vendor/wasm') : `${CDN}/wasm`,
  model: LOCAL
    ? local('vendor/hand_landmarker.task')
    : 'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task',
};

const MAX_HANDS = 2;

// Phones report a DPR of 3; rendering the overlay at 2x is visually
// indistinguishable for soft glowing strokes and leaves fill-rate headroom.
const MAX_DPR = 2;

const SETTINGS_KEY = 'hand-skeleton.settings';

/* ------------------------------------------------------------------- state */

const el = {
  video: document.getElementById('video'),
  canvas: document.getElementById('overlay'),
  splash: document.getElementById('splash'),
  splashMsg: document.getElementById('splashMsg'),
  splashFine: document.getElementById('splashFine'),
  btnStart: document.getElementById('btnStart'),
  btnFlip: document.getElementById('btnFlip'),
  btnDraw: document.getElementById('btnDraw'),
  btnVideo: document.getElementById('btnVideo'),
  btnSettings: document.getElementById('btnSettings'),
  hud: document.getElementById('hud'),
  controls: document.getElementById('controls'),
  statHands: document.getElementById('statHands'),
  handsText: document.getElementById('handsText'),
  statFps: document.getElementById('statFps'),
  panel3d: document.getElementById('panel3d'),
  hand3d: document.getElementById('hand3d'),
  drawbar: document.getElementById('drawbar'),
  swatches: document.getElementById('swatches'),
  btnUndo: document.getElementById('btnUndo'),
  btnClear: document.getElementById('btnClear'),
  settings: document.getElementById('settings'),
  scrim: document.getElementById('scrim'),
  optSmoothing: document.getElementById('optSmoothing'),
  optSmoothAmount: document.getElementById('optSmoothAmount'),
  opt3d: document.getElementById('opt3d'),
  optLabels: document.getElementById('optLabels'),
  styleGroup: document.getElementById('styleGroup'),
  btnCloseSettings: document.getElementById('btnCloseSettings'),
  rowSmoothAmount: document.getElementById('rowSmoothAmount'),
};

const ctx = el.canvas.getContext('2d');

const smoother = new HandSmoother(0.5);
const air = new AirCanvas();
const view3d = new Hand3DView(el.hand3d);

const state = {
  landmarker: null,
  stream: null,
  facing: 'user',        // 'user' = selfie camera, 'environment' = rear
  style: 'neon',
  showVideo: true,
  running: false,
  rafId: 0,
  lastVideoTime: -1,
  lastTimestamp: -1,
  latest: { hands: [], world: [], labels: [], raw: [] },
  wakeLock: null,

  // User settings, persisted.
  smoothing: true,
  smoothAmount: 0.5,
  show3d: false,
  showLabels: true,
  drawing: false,
};

/* ---------------------------------------------------------------- settings */

function loadSettings() {
  let saved = null;
  try {
    saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) || 'null');
  } catch { /* private mode, or blocked site data */ }

  if (saved && typeof saved === 'object') {
    if (typeof saved.smoothing === 'boolean') state.smoothing = saved.smoothing;
    if (typeof saved.smoothAmount === 'number') state.smoothAmount = saved.smoothAmount;
    if (typeof saved.show3d === 'boolean') state.show3d = saved.show3d;
    if (typeof saved.showLabels === 'boolean') state.showLabels = saved.showLabels;
    if (STYLES.includes(saved.style)) state.style = saved.style;
    if (PALETTE.includes(saved.color)) air.setColor(saved.color);
  }
}

function saveSettings() {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify({
      smoothing: state.smoothing,
      smoothAmount: state.smoothAmount,
      show3d: state.show3d,
      showLabels: state.showLabels,
      style: state.style,
      color: air.color,
    }));
  } catch { /* nothing we can do, and nothing that matters */ }
}

/* ------------------------------------------------------------------ canvas */

/** Size the backing store to the device pixel ratio so lines stay crisp. */
function resizeCanvas() {
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
}

/* ------------------------------------------------------------------- model */

async function loadModel() {
  const { FilesetResolver, HandLandmarker } = await import(ASSETS.bundle);
  const fileset = await FilesetResolver.forVisionTasks(ASSETS.wasm);

  const options = (delegate) => ({
    baseOptions: { modelAssetPath: ASSETS.model, delegate },
    runningMode: 'VIDEO',
    numHands: MAX_HANDS,
    minHandDetectionConfidence: 0.5,
    minHandPresenceConfidence: 0.5,
    minTrackingConfidence: 0.5,
  });

  try {
    return await HandLandmarker.createFromOptions(fileset, options('GPU'));
  } catch (err) {
    // Some older iOS builds fail to bring up the WebGL delegate; CPU still works.
    console.warn('GPU delegate unavailable, falling back to CPU:', err);
    return await HandLandmarker.createFromOptions(fileset, options('CPU'));
  }
}

/* ------------------------------------------------------------------ camera */

async function startCamera(facing) {
  stopCamera();

  const constraints = {
    audio: false,
    video: {
      facingMode: { ideal: facing },
      width: { ideal: 1280 },
      height: { ideal: 720 },
      frameRate: { ideal: 30 },
    },
  };

  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia(constraints);
  } catch (err) {
    // A device with only one camera rejects an exact/ideal facingMode on some
    // browsers -- retry with the plainest possible request before giving up.
    if (err && (err.name === 'OverconstrainedError' || err.name === 'NotFoundError')) {
      stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: true });
    } else {
      throw err;
    }
  }

  state.stream = stream;
  el.video.srcObject = stream;

  await new Promise((resolve) => {
    if (el.video.readyState >= 2 && el.video.videoWidth) return resolve();
    el.video.addEventListener('loadedmetadata', resolve, { once: true });
  });

  await el.video.play();

  // Trust the track's own facing mode when the browser reports it.
  const actual = stream.getVideoTracks()[0]?.getSettings?.().facingMode;
  state.facing = actual || facing;

  // Must stay in lockstep with the `mirrored` flag handed to makeMapper below,
  // otherwise the skeleton is drawn flipped relative to the picture.
  applyMirror();

  // Filter history belongs to the old camera's geometry.
  smoother.reset();

  resizeCanvas();
}

function stopCamera() {
  if (state.stream) {
    for (const track of state.stream.getTracks()) track.stop();
    state.stream = null;
  }
  el.video.srcObject = null;
}

/** True when the preview is mirrored, i.e. we are on the selfie camera. */
function isMirrored() {
  return state.facing === 'user';
}

function applyMirror() {
  el.video.classList.toggle('mirrored', isMirrored());
}

/* -------------------------------------------------------------- wake lock */

async function acquireWakeLock() {
  try {
    if ('wakeLock' in navigator) {
      state.wakeLock = await navigator.wakeLock.request('screen');
    }
  } catch { /* not critical -- the screen may just dim */ }
}

function releaseWakeLock() {
  state.wakeLock?.release?.().catch(() => {});
  state.wakeLock = null;
}

/* -------------------------------------------------------------- main loop */

let frames = 0;
let fpsClock = 0;

function loop() {
  state.rafId = requestAnimationFrame(loop);
  if (!state.running) return;

  const now = performance.now();
  resizeCanvas();

  const vw = el.video.videoWidth;
  const vh = el.video.videoHeight;
  if (!vw || !vh) return;

  // Only run inference when the camera has actually produced a new frame.
  if (el.video.currentTime !== state.lastVideoTime) {
    state.lastVideoTime = el.video.currentTime;

    // detectForVideo demands strictly increasing timestamps.
    const ts = now > state.lastTimestamp ? now : state.lastTimestamp + 1;
    state.lastTimestamp = ts;

    try {
      const result = state.landmarker.detectForVideo(el.video, ts);
      const raw = result.landmarks || [];
      const world = result.worldLandmarks || [];
      // The detector always sees raw, unmirrored sensor frames: the selfie
      // mirroring is applied downstream, to the preview (CSS) and the overlay
      // (the mapper), never to the pixels fed in here. MediaPipe reports
      // anatomically correct handedness for an unmirrored view (verified
      // against its own right_hands.jpg fixture), so the label is already
      // right for both cameras and must not be flipped.
      const labels = (result.handedness || []).map((h) => h?.[0]?.categoryName || '');

      const smoothed = state.smoothing
        ? smoother.apply(raw, world, labels, now)
        : { hands: raw, world };

      state.latest = { hands: smoothed.hands, world: smoothed.world, labels, raw };
    } catch (err) {
      console.error('detection failed', err);
    }
  }

  // Render.
  const viewW = el.canvas.clientWidth;
  const viewH = el.canvas.clientHeight;
  ctx.clearRect(0, 0, viewW, viewH);

  const mapper = makeMapper({
    videoW: vw,
    videoH: vh,
    viewW,
    viewH,
    mirrored: isMirrored(),
  });

  const cursors = air.update(state.latest.hands, state.latest.labels, mapper, state.drawing);

  // Ink sits under the skeleton, so the hand always reads on top of its trail.
  air.render(ctx, mapper);
  drawHands(ctx, state.latest.hands, state.latest.labels, mapper, {
    style: state.style,
    showLabels: state.showLabels,
  });
  if (state.drawing) air.renderCursors(ctx, cursors);

  if (state.show3d) view3d.render(state.latest.world, isMirrored(), now);

  // HUD, refreshed about twice a second.
  frames++;
  if (now - fpsClock >= 500) {
    const fps = Math.round((frames * 1000) / (now - fpsClock));
    el.statFps.textContent = `${fps} fps`;
    frames = 0;
    fpsClock = now;

    const n = state.latest.hands.length;
    el.handsText.textContent = n === 1 ? '1 hand' : `${n} hands`;
    el.statHands.classList.toggle('live', n > 0);
    el.btnUndo.disabled = air.isEmpty;
    el.btnClear.disabled = air.isEmpty;
  }
}

function startLoop() {
  if (state.rafId) cancelAnimationFrame(state.rafId);
  state.running = true;
  frames = 0;
  fpsClock = performance.now();
  state.rafId = requestAnimationFrame(loop);
}

/* --------------------------------------------------------------- controls */

async function flipCamera() {
  const next = state.facing === 'user' ? 'environment' : 'user';
  el.btnFlip.disabled = true;
  try {
    state.running = false;
    await startCamera(next);
    state.lastVideoTime = -1;
    state.running = true;
  } catch (err) {
    console.error('camera switch failed', err);
    try { await startCamera(state.facing); state.running = true; } catch { /* nothing left to try */ }
  } finally {
    el.btnFlip.disabled = false;
  }
}

function toggleVideo() {
  state.showVideo = !state.showVideo;
  document.body.classList.toggle('video-dim', !state.showVideo);
  el.btnVideo.classList.toggle('off', !state.showVideo);
}

/** Show or hide an element that is both `hidden` and opacity-animated. */
function reveal(node, on) {
  if (on) {
    node.hidden = false;
    // Let the browser lay it out before starting the fade.
    requestAnimationFrame(() => node.classList.remove('hidden'));
  } else {
    node.classList.add('hidden');
    setTimeout(() => { if (node.classList.contains('hidden')) node.hidden = true; }, 320);
  }
}

function setDrawing(on) {
  state.drawing = on;
  el.btnDraw.classList.toggle('on', on);
  el.btnDraw.setAttribute('aria-pressed', String(on));
  reveal(el.drawbar, on);
}

function setShow3d(on) {
  state.show3d = on;
  reveal(el.panel3d, on);
  // Keep the switch honest even when this is called from somewhere other than
  // the switch's own change handler.
  syncSettingsUI();
  saveSettings();
}

function openSettings(on) {
  reveal(el.scrim, on);
  reveal(el.settings, on);
}

/* ------------------------------------------------------------- settings UI */

function buildSwatches() {
  for (const color of PALETTE) {
    const b = document.createElement('button');
    b.className = 'swatch';
    b.style.background = color;
    b.setAttribute('aria-label', `Pen colour ${color}`);
    b.setAttribute('aria-pressed', String(color === air.color));
    b.addEventListener('click', () => {
      air.setColor(color);
      for (const other of el.swatches.children) {
        other.setAttribute('aria-pressed', String(other === b));
      }
      saveSettings();
    });
    el.swatches.appendChild(b);
  }
}

function buildStyleGroup() {
  for (const style of STYLES) {
    const b = document.createElement('button');
    b.textContent = style;
    b.setAttribute('aria-pressed', String(style === state.style));
    b.addEventListener('click', () => {
      state.style = style;
      for (const other of el.styleGroup.children) {
        other.setAttribute('aria-pressed', String(other === b));
      }
      saveSettings();
    });
    el.styleGroup.appendChild(b);
  }
}

function syncSettingsUI() {
  el.optSmoothing.checked = state.smoothing;
  el.optSmoothAmount.value = String(state.smoothAmount);
  el.optSmoothAmount.disabled = !state.smoothing;
  el.rowSmoothAmount.style.opacity = state.smoothing ? '1' : '.45';
  el.opt3d.checked = state.show3d;
  el.optLabels.checked = state.showLabels;
}

/* ---------------------------------------------------------------- startup */

function failSplash(message) {
  el.splashMsg.textContent = message;
  el.splashMsg.classList.add('error');
  el.btnStart.classList.remove('loading');
  el.btnStart.disabled = false;
  el.btnStart.textContent = 'Try again';
}

async function start() {
  el.btnStart.disabled = true;
  el.btnStart.classList.add('loading');
  el.splashMsg.classList.remove('error');

  if (!window.isSecureContext) {
    return failSplash('Camera access needs a secure connection. Open this page over HTTPS (or on localhost).');
  }
  if (!navigator.mediaDevices?.getUserMedia) {
    return failSplash('This browser does not expose a camera API. On iPhone, try Safari.');
  }

  try {
    el.splashFine.textContent = 'Loading the hand-tracking model…';
    if (!state.landmarker) state.landmarker = await loadModel();

    el.splashFine.textContent = 'Waiting for camera permission…';
    await startCamera(state.facing);
  } catch (err) {
    console.error(err);
    const name = err?.name;
    if (name === 'NotAllowedError' || name === 'SecurityError') {
      return failSplash('Camera permission was denied. Allow camera access for this site, then try again.');
    }
    if (name === 'NotFoundError' || name === 'OverconstrainedError') {
      return failSplash('No camera was found on this device.');
    }
    if (name === 'NotReadableError') {
      return failSplash('The camera is busy. Close other apps or tabs using it, then try again.');
    }
    return failSplash(`Could not start: ${err?.message || err}`);
  }

  // Reveal the live view.
  el.splash.classList.add('hidden');
  setTimeout(() => el.splash.classList.add('gone'), 400);
  el.hud.classList.remove('hidden');
  el.controls.classList.remove('hidden');
  if (state.show3d) reveal(el.panel3d, true);

  acquireWakeLock();
  startLoop();
}

/* ----------------------------------------------------------------- events */

el.btnStart.addEventListener('click', start);
el.btnFlip.addEventListener('click', flipCamera);
el.btnVideo.addEventListener('click', toggleVideo);
el.btnDraw.addEventListener('click', () => setDrawing(!state.drawing));
el.btnSettings.addEventListener('click', () => openSettings(true));
el.btnCloseSettings.addEventListener('click', () => openSettings(false));
el.scrim.addEventListener('click', () => openSettings(false));

el.btnUndo.addEventListener('click', () => air.undo());
el.btnClear.addEventListener('click', () => air.clear());

el.optSmoothing.addEventListener('change', () => {
  state.smoothing = el.optSmoothing.checked;
  smoother.reset();
  syncSettingsUI();
  saveSettings();
});

el.optSmoothAmount.addEventListener('input', () => {
  state.smoothAmount = Number(el.optSmoothAmount.value);
  smoother.setStrength(state.smoothAmount);
  saveSettings();
});

el.opt3d.addEventListener('change', () => setShow3d(el.opt3d.checked));

el.optLabels.addEventListener('change', () => {
  state.showLabels = el.optLabels.checked;
  saveSettings();
});

// Drag the 3D panel to turn the hand by hand.
let dragX = null;
el.panel3d.addEventListener('pointerdown', (e) => {
  dragX = e.clientX;
  el.panel3d.setPointerCapture(e.pointerId);
});
el.panel3d.addEventListener('pointermove', (e) => {
  if (dragX === null) return;
  view3d.nudge(e.clientX - dragX);
  dragX = e.clientX;
});
for (const type of ['pointerup', 'pointercancel']) {
  el.panel3d.addEventListener(type, () => { dragX = null; });
}

window.addEventListener('resize', resizeCanvas);
window.addEventListener('orientationchange', () => setTimeout(resizeCanvas, 250));

// iOS tears the camera down when the tab goes to the background.
document.addEventListener('visibilitychange', async () => {
  if (document.hidden) {
    state.running = false;
    releaseWakeLock();
    return;
  }
  // Nothing to resume if the user never got past the start screen.
  if (!state.landmarker || !el.splash.classList.contains('gone')) return;

  const track = state.stream?.getVideoTracks?.()[0];
  if (!track || track.readyState === 'ended') {
    try { await startCamera(state.facing); } catch (err) { console.error(err); }
  }
  state.lastVideoTime = -1;
  smoother.reset();
  state.running = true;
  acquireWakeLock();
});

window.addEventListener('pagehide', () => {
  state.running = false;
  stopCamera();
  releaseWakeLock();
});

// Safari added roundRect in 16.4; keep older iOS from throwing.
if (!CanvasRenderingContext2D.prototype.roundRect) {
  CanvasRenderingContext2D.prototype.roundRect = function (x, y, w, h, r) {
    const rad = Math.min(typeof r === 'number' ? r : 0, w / 2, h / 2);
    this.moveTo(x + rad, y);
    this.arcTo(x + w, y, x + w, y + h, rad);
    this.arcTo(x + w, y + h, x, y + h, rad);
    this.arcTo(x, y + h, x, y, rad);
    this.arcTo(x, y, x + w, y, rad);
    this.closePath();
    return this;
  };
}

if ('serviceWorker' in navigator && location.protocol === 'https:') {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  });
}

loadSettings();
smoother.setStrength(state.smoothAmount);
buildSwatches();
buildStyleGroup();
syncSettingsUI();

// Test hook: lets the suites inspect detector state and drive the features.
window.__handApp = {
  state, el, resizeCanvas, drawHands, makeMapper,
  smoother, air, view3d, setDrawing, setShow3d,
  smootherModule: { HandSmoother },
};
