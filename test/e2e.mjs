/**
 * End-to-end check for the hand-skeleton app.
 *
 * Chromium's built-in fake camera only produces a rolling test pattern, which
 * contains no hands. So instead we stub getUserMedia with a canvas stream that
 * continuously paints a real photograph of hands. Everything downstream of that
 * -- the <video>, HandLandmarker.detectForVideo, the cover-crop mapper and the
 * renderer -- is the real application code.
 */
import { chromium } from 'playwright';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';

const ORIGIN = process.env.ORIGIN || 'http://localhost:8080';
const SHOT_DIR = process.env.SHOT_DIR || new URL('../.screenshots/', import.meta.url).pathname;
const PHOTO = process.env.PHOTO || new URL('../vendor/fixtures/right_hands.jpg', import.meta.url).pathname;

// Dimensions of the simulated camera sensor, and how many hands the fixture has.
const SENSOR_W = +(process.env.SENSOR_W || 1280);
const SENSOR_H = +(process.env.SENSOR_H || 720);
const EXPECT_HANDS = +(process.env.EXPECT_HANDS || 2);
const PREFIX = process.env.PREFIX || '';

mkdirSync(SHOT_DIR, { recursive: true });

if (!existsSync(PHOTO)) {
  console.error(`Missing test fixture: ${PHOTO}\nRun \`npm run setup:test\` first.`);
  process.exit(1);
}

const photoB64 = 'data:image/jpeg;base64,' + readFileSync(PHOTO).toString('base64');

// Mirrors MAX_DPR in js/app.js: the overlay is capped at 2x regardless of screen DPR.
const DPR = 2;

const failures = [];
const check = (ok, label, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  -- ' + detail : ''}`);
  if (!ok) failures.push(label);
};

const browser = await chromium.launch({
  args: ['--use-fake-ui-for-media-stream', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});

const context = await browser.newContext({
  viewport: { width: 390, height: 844 },      // iPhone 14-ish portrait
  deviceScaleFactor: 3,
  isMobile: true,
  hasTouch: true,
  permissions: ['camera'],
});

// Replace the camera with a canvas that paints the photo every frame.
await context.addInitScript(({ b64, W, H }) => {
  const canvas = document.createElement('canvas');
  canvas.width = W; canvas.height = H;
  const c = canvas.getContext('2d');
  const img = new Image();
  let ready = false;
  img.onload = () => { ready = true; };
  img.src = b64;

  (function paint() {
    c.fillStyle = '#ffffff';
    c.fillRect(0, 0, W, H);
    if (ready) {
      // letterbox the photo into the 1280x720 "sensor"
      const s = Math.min(W / img.width, H / img.height);
      const w = img.width * s, h = img.height * s;
      c.drawImage(img, (W - w) / 2, (H - h) / 2, w, h);
    }
    requestAnimationFrame(paint);
  })();

  navigator.mediaDevices.getUserMedia = async (constraints) => {
    // A fresh stream per call, like the real thing: switching cameras stops the
    // tracks of the old one, so handing back the same stream twice yields a
    // dead track and no frames.
    const stream = canvas.captureStream(30);
    const req = constraints?.video?.facingMode;
    const facing = (typeof req === 'string' ? req : req?.ideal || req?.exact) || 'user';
    stream.getVideoTracks()[0].getSettings = () => ({ width: W, height: H, facingMode: facing, frameRate: 30 });
    return stream;
  };
  navigator.mediaDevices.enumerateDevices = async () => ([
    { kind: 'videoinput', deviceId: 'fake-front', label: 'Fake Front', groupId: 'g' },
    { kind: 'videoinput', deviceId: 'fake-back', label: 'Fake Back', groupId: 'g' },
  ]);
}, { b64: photoB64, W: SENSOR_W, H: SENSOR_H });

const page = await context.newPage();

const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text());
  if (process.env.VERBOSE) console.log(`   [console.${m.type()}] ${m.text()}`);
});

await page.goto(`${ORIGIN}/index.html?assets=local`, { waitUntil: 'load' });

check(await page.isVisible('#splash'), 'splash screen is shown on load');

await page.click('#btnStart');

// The model is ~8 MB off local disk; give it room.
await page.waitForFunction(() => document.getElementById('splash').classList.contains('hidden'), null, { timeout: 90_000 })
  .then(() => check(true, 'camera started and splash dismissed'))
  .catch(async () => {
    check(false, 'camera started and splash dismissed', await page.textContent('#splashMsg'));
    console.log('\nStartup failed, aborting. Console errors:\n  ' + (errors.join('\n  ') || '(none)'));
    await browser.close();
    process.exit(1);
  });

// Let detection settle.
await page.waitForFunction(() => (window.__handApp?.state?.latest?.hands?.length || 0) > 0, null, { timeout: 30_000 })
  .catch(() => {});

const info = await page.evaluate(() => {
  const s = window.__handApp.state;
  return {
    hands: s.latest.hands.length,
    labels: s.latest.labels,
    landmarksPerHand: s.latest.hands.map((h) => h.length),
    running: s.running,
    facing: s.facing,
    videoW: document.getElementById('video').videoWidth,
    videoH: document.getElementById('video').videoHeight,
    canvasW: document.getElementById('overlay').width,
    canvasH: document.getElementById('overlay').height,
    fps: document.getElementById('statFps').textContent,
    handsText: document.getElementById('handsText').textContent,
  };
});

console.log('   detector state:', JSON.stringify(info));

check(info.hands === EXPECT_HANDS, `detected ${EXPECT_HANDS} hand(s)`, `got ${info.hands}`);
if (EXPECT_HANDS === 2) check(JSON.stringify(info.labels) === '["Right","Right"]', 'handedness labels match the two-right-hands fixture', JSON.stringify(info.labels));
check(info.landmarksPerHand.length === EXPECT_HANDS && info.landmarksPerHand.every((n) => n === 21), 'each hand has 21 landmarks', JSON.stringify(info.landmarksPerHand));
check(info.videoW === SENSOR_W && info.videoH === SENSOR_H, 'video stream resolution', `${info.videoW}x${info.videoH}`);
check(info.canvasW === 390 * DPR && info.canvasH === 844 * DPR, 'overlay canvas sized to DPR', `${info.canvasW}x${info.canvasH}`);
check(/^\d+ fps$/.test(info.fps) && parseInt(info.fps) > 0, 'render loop is producing frames', info.fps);
check(info.handsText === (EXPECT_HANDS === 1 ? '1 hand' : `${EXPECT_HANDS} hands`), 'HUD hand count', info.handsText);

// The overlay must actually have ink on it.
const ink = await page.evaluate(() => {
  const cv = document.getElementById('overlay');
  const d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data;
  let n = 0;
  for (let i = 3; i < d.length; i += 4) if (d[i] > 24) n++;
  return { lit: n, total: d.length / 4 };
});
const inkPct = (ink.lit / ink.total) * 100;
check(inkPct > 0.4, 'skeleton is drawn onto the overlay', `${inkPct.toFixed(2)}% of pixels painted`);

// Screenshot each style.
for (const style of ['neon', 'minimal', 'xray']) {
  await page.evaluate((s) => { window.__handApp.state.style = s; }, style);
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${SHOT_DIR}/${PREFIX}style-${style}.png` });
}
check(true, 'captured a screenshot of each skeleton style');

// Camera-only view (video dimmed).
await page.evaluate(() => { window.__handApp.state.style = 'neon'; });
await page.click('#btnVideo');
await page.waitForTimeout(400);
await page.screenshot({ path: `${SHOT_DIR}/${PREFIX}skeleton-only.png` });
check(await page.evaluate(() => document.body.classList.contains('video-dim')), 'camera-dim toggle works');
await page.click('#btnVideo');

// Landscape: the cover-crop maths has to survive a rotation.
await page.setViewportSize({ width: 844, height: 390 });
await page.waitForTimeout(900);
const land = await page.evaluate(() => ({
  hands: window.__handApp.state.latest.hands.length,
  w: document.getElementById('overlay').width,
  h: document.getElementById('overlay').height,
}));
check(land.w === 844 * DPR && land.h === 390 * DPR, 'canvas resizes on rotation', `${land.w}x${land.h}`);
check(land.hands === EXPECT_HANDS, 'tracking survives rotation', `${land.hands} hands`);
await page.screenshot({ path: `${SHOT_DIR}/${PREFIX}landscape.png` });
await page.setViewportSize({ width: 390, height: 844 });
await page.waitForTimeout(600);

// Camera flip.
await page.click('#btnFlip');
await page.waitForTimeout(2500);
const flipped = await page.evaluate(() => ({
  facing: window.__handApp.state.facing,
  running: window.__handApp.state.running,
  hands: window.__handApp.state.latest.hands.length,
}));
check(flipped.running, 'still running after camera flip', JSON.stringify(flipped));
check(flipped.facing === 'environment', 'flip switched to the rear camera', flipped.facing);
check(flipped.hands === EXPECT_HANDS, 'tracking resumes after camera flip', `${flipped.hands} hands`);

check(errors.length === 0, 'no console or page errors', errors.slice(0, 4).join(' | '));

await browser.close();

console.log(`\n${failures.length ? 'FAILURES: ' + failures.join(', ') : 'All checks passed.'}`);
process.exit(failures.length ? 1 : 0);
