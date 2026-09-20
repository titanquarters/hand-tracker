/**
 * A small rotating 3D view of the hand, drawn from MediaPipe's world landmarks.
 *
 * These are different from the ones the overlay uses: the overlay's landmarks
 * are normalised to the picture, so they carry perspective and tell you where
 * the hand appears. World landmarks are in metres, centred on the hand itself,
 * and describe its actual shape in space -- which is what you need to turn it
 * around and look at it from another angle.
 */

import { FINGERS, TIPS } from './skeleton.js';

const PALM_ARCH = [5, 9, 13, 17];

// Camera distance in metres. A hand spans roughly 0.18 m, so this gives a
// little perspective without the near knuckles ballooning.
const EYE = 0.42;

// Tilt the view down slightly; a dead-on hand reads flat.
const PITCH = -0.25;

// Half-angle of the idle rocking motion, in radians (about 43 degrees).
const SWAY = 0.75;

export class Hand3DView {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.yaw = 0.6;
    this.spin = true;
    this.phase = 0;
    this.lastFrame = 0;
  }

  setSpin(on) {
    this.spin = on;
  }

  /** Drag support: nudge the yaw by a horizontal pixel delta. */
  nudge(dxPixels) {
    this.yaw += dxPixels * 0.012;
    this.spin = false;
  }

  resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    if (!w || !h) return false;

    const bw = Math.round(w * dpr);
    const bh = Math.round(h * dpr);
    if (this.canvas.width !== bw || this.canvas.height !== bh) {
      this.canvas.width = bw;
      this.canvas.height = bh;
    }
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return true;
  }

  /**
   * @param worldHands metric landmark arrays from HandLandmarker
   * @param mirrored   true on the selfie camera, so the model matches the preview
   */
  render(worldHands, mirrored, now) {
    if (!this.resize()) return;

    const ctx = this.ctx;
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    ctx.clearRect(0, 0, w, h);

    if (this.spin) {
      // Sway rather than spin. A full revolution spends a second of every cycle
      // edge-on, where a hand is unreadable at this size; rocking through a
      // three-quarter view shows the depth without ever hiding the shape.
      const dt = this.lastFrame ? (now - this.lastFrame) / 1000 : 0;
      this.phase += Math.min(dt, 0.1) * 0.9;
      this.yaw = SWAY * Math.sin(this.phase);
    }
    this.lastFrame = now;

    const hand = worldHands && worldHands[0];
    if (!hand || !hand.length) {
      this.drawPlaceholder(ctx, w, h);
      return;
    }

    const pts = this.project(hand, w, h, mirrored);
    this.drawBones(ctx, pts);
  }

  drawPlaceholder(ctx, w, h) {
    ctx.save();
    ctx.fillStyle = 'rgba(141, 155, 189, .75)';
    ctx.font = '600 11px -apple-system, BlinkMacSystemFont, system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('no hand', w / 2, h / 2);
    ctx.restore();
  }

  /** Rotate into view space, apply perspective, and fit the result to the box. */
  project(landmarks, w, h, mirrored) {
    const cy = Math.cos(this.yaw);
    const sy = Math.sin(this.yaw);
    const cp = Math.cos(PITCH);
    const sp = Math.sin(PITCH);

    const view = landmarks.map((p) => {
      // World landmarks follow the image convention -- +y is down, matching the
      // canvas, and -z is toward the camera. Verified against the pointing-up
      // fixture, whose index tip comes back at y=-0.08 against a wrist at
      // y=+0.09. No flip: negating y here turns the hand upside down.
      const x0 = mirrored ? -p.x : p.x;
      const y0 = p.y;
      const z0 = p.z;

      const x1 = x0 * cy + z0 * sy;
      const z1 = -x0 * sy + z0 * cy;

      const y2 = y0 * cp - z1 * sp;
      const z2 = y0 * sp + z1 * cp;

      const depth = EYE + z2;
      const k = EYE / Math.max(depth, 0.05);
      return { x: x1 * k, y: y2 * k, z: z2 };
    });

    // Scale from the hand's extent in 3D, not from the projected points. The
    // projected extent shrinks as the hand turns edge-on, so fitting to it
    // would make the model pulse in and out with every sway.
    const reach = landmarks.reduce((m, p) => Math.max(m, Math.hypot(p.x, p.y, p.z)), 0);
    const scale = (Math.min(w, h) * 0.46) / Math.max(reach, 0.06);

    const zs = view.map((p) => p.z);
    const zMin = Math.min(...zs);
    const zMax = Math.max(...zs);
    const zSpan = Math.max(zMax - zMin, 1e-4);

    return view.map((p) => ({
      x: w / 2 + p.x * scale,
      y: h / 2 + p.y * scale,
      // 0 = farthest from the eye, 1 = nearest.
      depth: 1 - (p.z - zMin) / zSpan,
    }));
  }

  drawBones(ctx, pts) {
    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    const segments = [];
    for (const finger of FINGERS) {
      for (let i = 0; i < finger.chain.length - 1; i++) {
        segments.push([finger.chain[i], finger.chain[i + 1], finger.color]);
      }
    }
    for (let i = 0; i < PALM_ARCH.length - 1; i++) {
      segments.push([PALM_ARCH[i], PALM_ARCH[i + 1], 'rgba(226, 240, 255, .9)']);
    }

    // Painter's algorithm: far bones first, so near ones overlap them.
    segments.sort((a, b) => (pts[a[0]].depth + pts[a[1]].depth) - (pts[b[0]].depth + pts[b[1]].depth));

    for (const [a, b, color] of segments) {
      const depth = (pts[a].depth + pts[b].depth) / 2;
      ctx.globalAlpha = 0.35 + 0.65 * depth;
      ctx.lineWidth = 1.6 + 2.4 * depth;
      ctx.strokeStyle = color;
      ctx.beginPath();
      ctx.moveTo(pts[a].x, pts[a].y);
      ctx.lineTo(pts[b].x, pts[b].y);
      ctx.stroke();
    }

    const order = pts.map((p, i) => i).sort((a, b) => pts[a].depth - pts[b].depth);
    for (const i of order) {
      const p = pts[i];
      ctx.globalAlpha = 0.4 + 0.6 * p.depth;
      ctx.fillStyle = i === 0 ? '#e0f2fe' : TIPS.includes(i) ? '#ffffff' : '#bae6fd';
      ctx.beginPath();
      ctx.arc(p.x, p.y, (i === 0 ? 3.2 : TIPS.includes(i) ? 2.6 : 1.9) * (0.6 + 0.6 * p.depth), 0, Math.PI * 2);
      ctx.fill();
    }

    ctx.restore();
  }
}
