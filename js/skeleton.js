/**
 * Hand skeleton rendering.
 *
 * MediaPipe gives us 21 landmarks per hand, normalised to the video frame:
 *
 *        8   12  16  20      <- finger tips
 *        |   |   |   |
 *        7   11  15  19
 *        |   |   |   |
 *        6   10  14  18
 *        |   |   |   |
 *    4   5   9   13  17      <- knuckles (MCP)
 *     \   \  |  /   /
 *      3   \ | /   /
 *       2   \|/   /
 *        1---0----          <- 0 is the wrist
 */

export const FINGERS = [
  { name: 'thumb',  color: '#fb7185', chain: [0, 1, 2, 3, 4] },
  { name: 'index',  color: '#fbbf24', chain: [0, 5, 6, 7, 8] },
  { name: 'middle', color: '#34d399', chain: [9, 10, 11, 12] },
  { name: 'ring',   color: '#22d3ee', chain: [13, 14, 15, 16] },
  { name: 'pinky',  color: '#a78bfa', chain: [0, 17, 18, 19, 20] },
];

// The knuckle line across the top of the palm.
const PALM_ARCH = [5, 9, 13, 17];

export const TIPS = [4, 8, 12, 16, 20];

export const STYLES = ['neon', 'minimal', 'xray'];

/**
 * Maps normalised landmarks (0..1 within the video frame) to canvas pixels,
 * reproducing the crop that `object-fit: cover` applies to the <video>.
 *
 * Without this the skeleton drifts away from the hand whenever the camera's
 * aspect ratio differs from the screen's, which on a phone it always does.
 */
export function makeMapper({ videoW, videoH, viewW, viewH, mirrored }) {
  const scale = Math.max(viewW / videoW, viewH / videoH);
  const drawnW = videoW * scale;
  const drawnH = videoH * scale;
  const offsetX = (viewW - drawnW) / 2;
  const offsetY = (viewH - drawnH) / 2;

  return (lm) => {
    const x = offsetX + lm.x * drawnW;
    return {
      x: mirrored ? viewW - x : x,
      y: offsetY + lm.y * drawnH,
    };
  };
}

/** Rough on-screen size of a hand, used to scale line weights with distance. */
function handScale(pts) {
  const span = Math.hypot(pts[9].x - pts[0].x, pts[9].y - pts[0].y);
  return Math.max(0.45, Math.min(3.2, span / 90));
}

function strokeChain(ctx, pts, chain, width) {
  ctx.lineWidth = width;
  ctx.beginPath();
  ctx.moveTo(pts[chain[0]].x, pts[chain[0]].y);
  for (let i = 1; i < chain.length; i++) ctx.lineTo(pts[chain[i]].x, pts[chain[i]].y);
  ctx.stroke();
}

function fillDot(ctx, p, r) {
  ctx.beginPath();
  ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
  ctx.fill();
}

/** Translucent webbing over the palm, which reads as "solid hand" at a glance. */
function paintPalm(ctx, pts, alpha) {
  ctx.globalAlpha = alpha;
  ctx.beginPath();
  ctx.moveTo(pts[0].x, pts[0].y);
  for (const i of [1, 5, 9, 13, 17]) ctx.lineTo(pts[i].x, pts[i].y);
  ctx.closePath();
  ctx.fill();
  ctx.globalAlpha = 1;
}

function drawNeon(ctx, pts, s) {
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  ctx.fillStyle = '#7dd3fc';
  paintPalm(ctx, pts, 0.1);

  // Two passes per finger: a wide blurred pass for the glow, then a crisp core.
  for (const pass of [
    { blur: 16 * s, width: 7 * s, alpha: 0.55 },
    { blur: 0,      width: 3 * s, alpha: 1 },
  ]) {
    ctx.globalAlpha = pass.alpha;
    for (const finger of FINGERS) {
      ctx.strokeStyle = finger.color;
      ctx.shadowColor = finger.color;
      ctx.shadowBlur = pass.blur;
      strokeChain(ctx, pts, finger.chain, pass.width);
    }
    ctx.strokeStyle = 'rgba(226, 240, 255, .85)';
    ctx.shadowColor = '#bae6fd';
    ctx.shadowBlur = pass.blur;
    strokeChain(ctx, pts, PALM_ARCH, pass.width * 0.8);
  }

  // Joints.
  ctx.globalAlpha = 1;
  ctx.shadowBlur = 8 * s;
  for (const finger of FINGERS) {
    ctx.fillStyle = finger.color;
    ctx.shadowColor = finger.color;
    for (const i of finger.chain) {
      if (i === 0) continue;
      fillDot(ctx, pts[i], (TIPS.includes(i) ? 5.4 : 3.6) * s);
    }
  }

  // Fingertips get a white centre so they pop.
  ctx.shadowBlur = 0;
  ctx.fillStyle = '#ffffff';
  for (const i of TIPS) fillDot(ctx, pts[i], 2.1 * s);

  // The wrist anchor.
  ctx.shadowColor = '#e0f2fe';
  ctx.shadowBlur = 14 * s;
  ctx.fillStyle = '#e0f2fe';
  fillDot(ctx, pts[0], 6 * s);
  ctx.shadowBlur = 0;
}

function drawMinimal(ctx, pts, s) {
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.shadowBlur = 0;
  ctx.strokeStyle = 'rgba(255, 255, 255, .92)';

  for (const finger of FINGERS) strokeChain(ctx, pts, finger.chain, 2 * s);
  strokeChain(ctx, pts, PALM_ARCH, 2 * s);

  ctx.fillStyle = '#ffffff';
  for (let i = 0; i < 21; i++) fillDot(ctx, pts[i], (i === 0 ? 4 : 2.6) * s);
}

function drawXray(ctx, pts, s) {
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  ctx.fillStyle = '#22d3ee';
  paintPalm(ctx, pts, 0.14);

  // Thick soft "bone" underlay with a thin bright line running through it.
  ctx.shadowColor = '#22d3ee';
  ctx.shadowBlur = 10 * s;
  ctx.strokeStyle = 'rgba(186, 230, 253, .34)';
  for (const finger of FINGERS) strokeChain(ctx, pts, finger.chain, 11 * s);
  strokeChain(ctx, pts, PALM_ARCH, 11 * s);

  ctx.shadowBlur = 0;
  ctx.strokeStyle = 'rgba(240, 253, 255, .95)';
  for (const finger of FINGERS) strokeChain(ctx, pts, finger.chain, 1.5 * s);
  strokeChain(ctx, pts, PALM_ARCH, 1.5 * s);

  // Hollow joints, like ball sockets.
  ctx.lineWidth = 1.6 * s;
  ctx.strokeStyle = '#ecfeff';
  ctx.fillStyle = 'rgba(8, 32, 45, .75)';
  for (let i = 0; i < 21; i++) {
    const r = (i === 0 ? 6 : TIPS.includes(i) ? 4.4 : 3.2) * s;
    ctx.beginPath();
    ctx.arc(pts[i].x, pts[i].y, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  }
}

const RENDERERS = { neon: drawNeon, minimal: drawMinimal, xray: drawXray };

/** Small "Left"/"Right" tag floating just above the wrist. */
function drawLabel(ctx, pts, text, s) {
  const size = Math.max(11, Math.min(20, 13 * s));
  const x = pts[0].x;
  const y = pts[0].y + 26 * s;

  ctx.font = `600 ${size}px -apple-system, BlinkMacSystemFont, system-ui, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  const padX = size * 0.62;
  const w = ctx.measureText(text).width + padX * 2;
  const h = size * 1.75;

  ctx.shadowBlur = 0;
  ctx.fillStyle = 'rgba(6, 12, 24, .6)';
  ctx.beginPath();
  ctx.roundRect(x - w / 2, y - h / 2, w, h, h / 2);
  ctx.fill();

  ctx.fillStyle = 'rgba(234, 240, 255, .95)';
  ctx.fillText(text, x, y + 0.5);
}

/**
 * Draw every detected hand.
 *
 * @param hands  array of landmark arrays (21 each), normalised
 * @param labels array of "Left"/"Right" strings, parallel to `hands`
 */
export function drawHands(ctx, hands, labels, mapper, { style = 'neon', showLabels = true } = {}) {
  const render = RENDERERS[style] || drawNeon;

  hands.forEach((landmarks, i) => {
    const pts = landmarks.map(mapper);
    const s = handScale(pts);

    ctx.save();
    render(ctx, pts, s);
    ctx.shadowBlur = 0;
    ctx.globalAlpha = 1;
    if (showLabels && labels[i]) drawLabel(ctx, pts, labels[i], s);
    ctx.restore();
  });
}
