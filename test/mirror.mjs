/**
 * Regression test for the overlay/preview mirror agreement.
 *
 * The selfie camera is shown mirrored, so the skeleton has to be mirrored the
 * same way. Get one of the two wrong and the skeleton is drawn flipped -- but
 * if the hand happens to sit near the middle of frame, a flip lands the
 * skeleton almost on top of it and the mistake is easy to miss by eye.
 *
 * So the fake sensor is deliberately lopsided: the hand goes in the LEFT half
 * and the RIGHT half is filled solid blue. Wherever the blue ends up on screen,
 * the skeleton has to be in the other half. That invariant holds for both
 * cameras and fails loudly under a flip, no matter where the hand is.
 */
import { chromium } from 'playwright';
import { readFileSync, existsSync, mkdirSync } from 'fs';

const ORIGIN = process.env.ORIGIN || 'http://localhost:8080';
const PHOTO = process.env.PHOTO || new URL('../vendor/fixtures/pointing_up.jpg', import.meta.url).pathname;
const SHOT_DIR = new URL('../.screenshots/', import.meta.url).pathname;

const SENSOR_W = 720;
const SENSOR_H = 1280;

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

    // Right half: a solid colour nothing else in the scene produces.
    c.fillStyle = '#0000ff';
    c.fillRect(W / 2, 0, W / 2, H);

    if (ready) {
      // Hand in the left half, inset so the cover-crop cannot eat it.
      const boxW = W * 0.42;
      const s = boxW / img.width;
      const w = img.width * s;
      const h = img.height * s;
      c.drawImage(img, W * 0.29 - w / 2, H / 2 - h / 2, w, h);
    }
    requestAnimationFrame(paint);
  })();

  navigator.mediaDevices.getUserMedia = async (constraints) => {
    // A fresh stream per call, like the real thing: switching cameras stops the
    // tracks of the old one, so handing back the same stream twice yields a
    // dead track and no frames.
    const stream = canvas.captureStream(30);

    // Honour the requested camera so the flip button exercises the rear path.
    const req = constraints?.video?.facingMode;
    const facing = (typeof req === 'string' ? req : req?.ideal || req?.exact) || 'user';
    const track = stream.getVideoTracks()[0];
    track.getSettings = () => ({ width: W, height: H, facingMode: facing, frameRate: 30 });
    return stream;
  };
}, { b64: photoB64, W: SENSOR_W, H: SENSOR_H });

const page = await context.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

await page.goto(`${ORIGIN}/index.html?assets=local`, { waitUntil: 'load' });
await page.click('#btnStart');
await page.waitForFunction(() => document.getElementById('splash').classList.contains('gone'), null, { timeout: 90_000 });
await page.waitForFunction(() => (window.__handApp?.state?.latest?.hands?.length || 0) > 0, null, { timeout: 30_000 })
  .catch(() => {});

/** Horizontal centre of mass of everything painted on the overlay, as 0..1. */
async function skeletonCentre() {
  return page.evaluate(() => {
    const cv = document.getElementById('overlay');
    const { width: w, height: h } = cv;
    const d = cv.getContext('2d').getImageData(0, 0, w, h).data;
    let sum = 0;
    let n = 0;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (d[(y * w + x) * 4 + 3] > 40) { sum += x; n++; }
      }
    }
    return n ? { x: sum / n / w, lit: n } : null;
  });
}

/**
 * Where the blue half of the sensor ends up on screen, judged from a real
 * screenshot so the CSS transform is genuinely accounted for. The PNG is
 * handed back to the page to decode, since node has no image decoder here.
 */
async function bluePosition() {
  const shot = (await page.screenshot()).toString('base64');
  return page.evaluate(async (b64) => {
    const img = await new Promise((res) => {
      const i = new Image();
      i.onload = () => res(i);
      i.src = 'data:image/png;base64,' + b64;
    });
    const c = document.createElement('canvas');
    c.width = img.width;
    c.height = img.height;
    const x = c.getContext('2d');
    x.drawImage(img, 0, 0);

    // Middle band only, to stay clear of the HUD and the control buttons.
    const y0 = Math.floor(img.height * 0.3);
    const y1 = Math.floor(img.height * 0.7);
    const d = x.getImageData(0, y0, img.width, y1 - y0).data;

    let left = 0;
    let right = 0;
    const mid = img.width / 2;
    for (let i = 0; i < d.length; i += 4) {
      const px = (i / 4) % img.width;
      // Strongly blue: high B, low R and G.
      if (d[i] < 90 && d[i + 1] < 90 && d[i + 2] > 160) {
        if (px < mid) left++; else right++;
      }
    }
    return { left, right, side: left > right ? 'left' : 'right', total: left + right };
  }, shot);
}

async function assertOpposite(label) {
  const skel = await skeletonCentre();
  const blue = await bluePosition();

  if (!skel) {
    check(false, `${label}: skeleton was drawn`, 'nothing painted on the overlay');
    return;
  }
  check(blue.total > 2000, `${label}: blue half of the sensor is visible`, `${blue.total} px`);

  const skelSide = skel.x < 0.5 ? 'left' : 'right';
  check(
    skelSide !== blue.side,
    `${label}: skeleton sits opposite the blue half`,
    `skeleton ${skelSide} (x=${skel.x.toFixed(3)}), blue ${blue.side}`
  );
}

// Front camera: preview is mirrored, so the hand (sensor-left) shows on the right.
const facingA = await page.evaluate(() => window.__handApp.state.facing);
const transformA = await page.evaluate(() => getComputedStyle(document.getElementById('video')).transform);
check(facingA === 'user', 'front camera reported', facingA);
check(/matrix\(-1/.test(transformA), 'front camera preview is mirrored in CSS', transformA);
await assertOpposite('front camera');
await page.screenshot({ path: `${SHOT_DIR}mirror-front.png` });

// Rear camera: no mirroring, so the hand stays on the left.
await page.click('#btnFlip');
await page.waitForFunction(() => window.__handApp.state.facing === 'environment', null, { timeout: 20_000 })
  .catch(() => {});
await page.waitForTimeout(1500);

const facingB = await page.evaluate(() => window.__handApp.state.facing);
const transformB = await page.evaluate(() => getComputedStyle(document.getElementById('video')).transform);
check(facingB === 'environment', 'rear camera reported', facingB);
check(transformB === 'none' || /matrix\(1[,)]/.test(transformB), 'rear camera preview is not mirrored', transformB);
await assertOpposite('rear camera');
await page.screenshot({ path: `${SHOT_DIR}mirror-rear.png` });

check(errors.length === 0, 'no console or page errors', errors.slice(0, 3).join(' | '));

await browser.close();
console.log(`\n${failures.length ? 'FAILURES: ' + failures.join(', ') : 'All checks passed.'}`);
process.exit(failures.length ? 1 : 0);
