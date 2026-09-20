/**
 * Covers smoothing, air drawing and the 3D hand panel.
 *
 * Drawing is exercised through a scripted pinch: rather than hunting for a
 * photo of a pinching hand, the detector's output is overridden for a few
 * frames with landmarks whose thumb and index tips are touching, which is
 * exactly what AirCanvas reads.
 */
import { chromium } from 'playwright';
import { readFileSync, existsSync, mkdirSync } from 'fs';

const ORIGIN = process.env.ORIGIN || 'http://localhost:8080';
const PHOTO = new URL('../vendor/fixtures/pointing_up.jpg', import.meta.url).pathname;
const SHOT_DIR = new URL('../.screenshots/', import.meta.url).pathname;

mkdirSync(SHOT_DIR, { recursive: true });
if (!existsSync(PHOTO)) {
  console.error(`Missing fixture: ${PHOTO}\nRun \`npm run setup:test\` first.`);
  process.exit(1);
}

const failures = [];
const check = (ok, label, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  -- ' + detail : ''}`);
  if (!ok) failures.push(label);
};

const photoB64 = 'data:image/jpeg;base64,' + readFileSync(PHOTO).toString('base64');

const browser = await chromium.launch({ args: ['--enable-unsafe-swiftshader'] });
const context = await browser.newContext({
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 2,
  isMobile: true,
  hasTouch: true,
  permissions: ['camera'],
});

await context.addInitScript(({ b64, W, H }) => {
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const c = canvas.getContext('2d');
  const img = new Image();
  let ready = false;
  img.onload = () => { ready = true; };
  img.src = b64;

  (function paint() {
    c.fillStyle = '#ffffff';
    c.fillRect(0, 0, W, H);
    if (ready) {
      const s = Math.min(W / img.width, H / img.height);
      const w = img.width * s;
      const h = img.height * s;
      c.drawImage(img, (W - w) / 2, (H - h) / 2, w, h);
    }
    requestAnimationFrame(paint);
  })();

  navigator.mediaDevices.getUserMedia = async (constraints) => {
    const stream = canvas.captureStream(30);
    const req = constraints?.video?.facingMode;
    const facing = (typeof req === 'string' ? req : req?.ideal || req?.exact) || 'user';
    stream.getVideoTracks()[0].getSettings = () => ({ width: W, height: H, facingMode: facing, frameRate: 30 });
    return stream;
  };
}, { b64: photoB64, W: 720, H: 1280 });

const page = await context.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

await page.goto(`${ORIGIN}/index.html?assets=local`, { waitUntil: 'load' });
await page.click('#btnStart');
await page.waitForFunction(() => document.getElementById('splash').classList.contains('gone'), null, { timeout: 90_000 });
await page.waitForFunction(() => (window.__handApp?.state?.latest?.hands?.length || 0) > 0, null, { timeout: 30_000 })
  .catch(() => {});

/* ------------------------------------------------------------- smoothing */

// Drive the filter directly with a known-noisy still point: the outcome is
// then a property of the filter, not of whatever the camera happened to see.
const jitter = await page.evaluate(() => {
  const { HandSmoother } = window.__handApp.smootherModule;
  const still = (x) => Array.from({ length: 21 }, () => ({ x, y: 0.5, z: 0 }));
  const measure = (strength) => {
    const s = new HandSmoother(strength);
    let t = 0;
    for (let i = 0; i < 90; i++) { t += 33; s.apply([still(0.5 + (Math.random() - 0.5) * 0.02)], [], ['Right'], t); }
    const xs = [];
    for (let i = 0; i < 90; i++) { t += 33; xs.push(s.apply([still(0.5 + (Math.random() - 0.5) * 0.02)], [], ['Right'], t).hands[0][0].x); }
    return (Math.max(...xs) - Math.min(...xs)) / 0.02;
  };
  return { light: measure(0.2), heavy: measure(1) };
});
check(jitter.heavy < 0.35, 'heavy smoothing removes most jitter', `${(jitter.heavy * 100).toFixed(0)}% retained`);
check(jitter.light > jitter.heavy, 'the amount slider actually changes smoothing', `light ${(jitter.light * 100).toFixed(0)}% vs heavy ${(jitter.heavy * 100).toFixed(0)}%`);

// A hand that disappears and comes back must not be interpolated across the gap.
const gap = await page.evaluate(() => {
  const { HandSmoother } = window.__handApp.smootherModule;
  const at = (x) => Array.from({ length: 21 }, () => ({ x, y: 0.5, z: 0 }));
  const s = new HandSmoother(1);
  let t = 0;
  for (let i = 0; i < 60; i++) { t += 33; s.apply([at(0.2)], [], ['Right'], t); }
  t += 2000;                                    // hand gone for two seconds
  return s.apply([at(0.8)], [], ['Right'], t).hands[0][0].x;
});
check(gap > 0.75, 'filter resets after the hand is lost, instead of sliding in', `x=${gap.toFixed(3)}`);

check(await page.evaluate(() => window.__handApp.state.smoothing), 'smoothing is on by default');

/* ---------------------------------------------------------- air drawing */

await page.evaluate(() => window.__handApp.setDrawing(true));
await page.waitForTimeout(250);
check(await page.isVisible('#drawbar'), 'palette appears with draw mode');

// Drive AirCanvas directly with a scripted pinch. Feeding frames through the
// live loop instead would race the detector, which overwrites the landmarks
// every time the camera produces a frame and would chop the stroke to pieces.
const drawn = await page.evaluate(() => {
  const { air, makeMapper } = window.__handApp;
  air.clear();

  const mapper = makeMapper({ videoW: 720, videoH: 1280, viewW: 390, viewH: 844, mirrored: false });

  // Landmarks 0 and 9 set the palm reference the pinch ratio is measured against.
  const hand = (x, spread) => {
    const pts = Array.from({ length: 21 }, () => ({ x, y: 0.5, z: 0 }));
    pts[0] = { x, y: 0.72, z: 0 };
    pts[9] = { x, y: 0.42, z: 0 };
    pts[4] = { x: x - spread / 2, y: 0.5, z: 0 };
    pts[8] = { x: x + spread / 2, y: 0.5, z: 0 };
    return pts;
  };

  const before = air.strokes.length;
  for (let i = 0; i <= 20; i++) {
    air.update([hand(0.25 + i * 0.022, 0.002)], ['Right'], mapper, true);
  }
  const points = air.strokes[air.strokes.length - 1]?.points.length || 0;
  const midStroke = air.strokes.length;

  // Open the fingers wide to release.
  for (let i = 0; i < 4; i++) air.update([hand(0.69, 0.30)], ['Right'], mapper, true);

  return { before, midStroke, after: air.strokes.length, points, stillActive: air.active.size };
});
check(drawn.midStroke === drawn.before + 1, 'a pinch starts exactly one stroke', `${drawn.before} -> ${drawn.midStroke}`);
check(drawn.points >= 15, 'the stroke follows the pinch across the frame', `${drawn.points} points`);
check(drawn.stillActive === 0, 'opening the fingers ends the stroke', `${drawn.stillActive} still active`);
check(drawn.after === drawn.before + 1, 'the finished stroke is kept', `${drawn.after} strokes`);

// A pinch that never moves is a tap, not a stroke, and should leave nothing.
const tap = await page.evaluate(() => {
  const { air, makeMapper } = window.__handApp;
  const mapper = makeMapper({ videoW: 720, videoH: 1280, viewW: 390, viewH: 844, mirrored: false });
  const hand = (spread) => {
    const pts = Array.from({ length: 21 }, () => ({ x: 0.5, y: 0.5, z: 0 }));
    pts[0] = { x: 0.5, y: 0.72, z: 0 };
    pts[9] = { x: 0.5, y: 0.42, z: 0 };
    pts[4] = { x: 0.5 - spread / 2, y: 0.5, z: 0 };
    pts[8] = { x: 0.5 + spread / 2, y: 0.5, z: 0 };
    return pts;
  };
  const before = air.strokes.length;
  for (let i = 0; i < 6; i++) air.update([hand(0.002)], ['Right'], mapper, true);
  for (let i = 0; i < 4; i++) air.update([hand(0.30)], ['Right'], mapper, true);
  return air.strokes.length - before;
});
check(tap === 0, 'a stationary pinch leaves no stray dot', `${tap} strokes added`);

// Render the ink on its own, so this measures AirCanvas and not the skeleton.
const painted = await page.evaluate(() => {
  const { air, makeMapper } = window.__handApp;
  const cv = document.createElement('canvas');
  cv.width = 390;
  cv.height = 844;
  const c = cv.getContext('2d');
  air.render(c, makeMapper({ videoW: 720, videoH: 1280, viewW: 390, viewH: 844, mirrored: false }));
  const d = c.getImageData(0, 0, cv.width, cv.height).data;
  let n = 0;
  for (let i = 3; i < d.length; i += 4) if (d[i] > 24) n++;
  return n;
});
check(painted > 500, 'ink is rendered', `${painted} px`);
await page.screenshot({ path: `${SHOT_DIR}feature-drawing.png` });

const afterUndo = await page.evaluate(() => { window.__handApp.air.undo(); return window.__handApp.air.strokes.length; });
check(afterUndo === drawn.before, 'undo removes the stroke', `${afterUndo} left`);

await page.evaluate(() => window.__handApp.air.clear());
check(await page.evaluate(() => window.__handApp.air.isEmpty), 'clear empties the canvas');

// Strokes are stored in frame coordinates, so a rotation must not lose them.
await page.evaluate(() => {
  const { air } = window.__handApp;
  air.strokes.push({ color: '#22d3ee', width: 6, points: [{ x: 0.3, y: 0.4 }, { x: 0.6, y: 0.6 }] });
});
await page.setViewportSize({ width: 844, height: 390 });
await page.waitForTimeout(700);
check(await page.evaluate(() => window.__handApp.air.strokes.length === 1), 'drawings survive rotation');
await page.setViewportSize({ width: 390, height: 844 });
await page.waitForTimeout(500);
await page.evaluate(() => window.__handApp.air.clear());
await page.evaluate(() => window.__handApp.setDrawing(false));

/* ------------------------------------------------------------ 3D panel */

check(await page.evaluate(() => !!document.getElementById('panel3d').hidden), '3D panel is off by default');

await page.evaluate(() => window.__handApp.setShow3d(true));
await page.waitForTimeout(1200);
check(await page.isVisible('#panel3d'), '3D panel appears when enabled');

const world = await page.evaluate(() => {
  const w = window.__handApp.state.latest.world;
  if (!w?.length) return null;
  const ys = w[0].map((p) => p.y);
  return { hands: w.length, points: w[0].length, spanMetres: Math.max(...ys) - Math.min(...ys) };
});
check(world && world.points === 21, 'world landmarks are available to the 3D view', JSON.stringify(world));
check(world && world.spanMetres > 0.05 && world.spanMetres < 0.4, 'world landmarks are in plausible metres', `${world?.spanMetres.toFixed(3)} m`);

const inked3d = await page.evaluate(() => {
  const cv = document.getElementById('hand3d');
  const d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data;
  let n = 0;
  for (let i = 3; i < d.length; i += 4) if (d[i] > 24) n++;
  return n;
});
check(inked3d > 200, '3D hand is actually drawn', `${inked3d} px`);

// Orientation guard: the fixture points upward, so in the projected model the
// index fingertip must sit above the wrist. Negating world y inverts the hand,
// which is easy to do and hard to notice in a 132px panel.
const upright = await page.evaluate(() => {
  const { view3d, state } = window.__handApp;
  const hand = state.latest.world?.[0];
  if (!hand) return null;
  const saved = view3d.yaw;
  view3d.yaw = 0;
  const pts = view3d.project(hand, 132, 132, false);
  view3d.yaw = saved;
  return { wristY: pts[0].y, indexTipY: pts[8].y };
});
check(
  upright && upright.indexTipY < upright.wristY,
  '3D model is the right way up for a pointing-up hand',
  upright ? `index tip y=${upright.indexTipY.toFixed(1)} vs wrist y=${upright.wristY.toFixed(1)}` : 'no world landmarks'
);

// Auto-rotation should change the projection over time.
const spun = await page.evaluate(async () => {
  const before = window.__handApp.view3d.yaw;
  await new Promise((r) => setTimeout(r, 600));
  return window.__handApp.view3d.yaw - before;
});
check(Math.abs(spun) > 0.05, '3D view auto-rotates', `yaw moved ${spun.toFixed(3)} rad`);

const dragged = await page.evaluate(() => {
  const v = window.__handApp.view3d;
  const before = v.yaw;
  v.nudge(60);
  return { delta: v.yaw - before, spin: v.spin };
});
check(dragged.delta > 0.1 && dragged.spin === false, 'dragging turns the hand and stops auto-spin', JSON.stringify(dragged));
await page.screenshot({ path: `${SHOT_DIR}feature-3d.png` });

/* ------------------------------------------------------------ settings */

const persisted = await page.evaluate(() => {
  try { return JSON.parse(localStorage.getItem('hand-skeleton.settings')); } catch { return null; }
});
check(persisted && persisted.show3d === true, 'settings are persisted to localStorage', JSON.stringify(persisted));

await page.reload({ waitUntil: 'load' });
const restored = await page.evaluate(() => ({
  show3d: window.__handApp.state.show3d,
  checked: document.getElementById('opt3d').checked,
}));
check(restored.show3d === true && restored.checked === true, 'settings are restored on reload', JSON.stringify(restored));

check(errors.length === 0, 'no console or page errors', errors.slice(0, 3).join(' | '));

await browser.close();
console.log(`\n${failures.length ? 'FAILURES: ' + failures.join(', ') : 'All checks passed.'}`);
process.exit(failures.length ? 1 : 0);
