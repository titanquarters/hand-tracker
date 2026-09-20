/**
 * Air drawing: pinch thumb and index together to leave a trail.
 *
 * Pinch is measured as the thumb-to-index distance divided by the length of
 * the palm, so it reads the same whether the hand is close to the lens or far
 * away. The ratio is computed in mapped screen pixels rather than normalised
 * landmark units -- normalised x and y are divided by different numbers
 * (frame width and height), so a distance taken directly from them is skewed
 * by the aspect ratio and a pinch would register differently depending on
 * which way the hand was oriented.
 */

export const PALETTE = ['#22d3ee', '#fbbf24', '#fb7185', '#34d399', '#a78bfa', '#ffffff'];

// Separate thresholds so a hand hovering near the boundary does not rapidly
// start and stop strokes.
const PINCH_CLOSE = 0.32;
const PINCH_OPEN = 0.48;

const THUMB_TIP = 4;
const INDEX_TIP = 8;
const WRIST = 0;
const MIDDLE_MCP = 9;

// Ignore sub-pixel wobble so a held pinch does not pile up thousands of points.
const MIN_STEP_PX = 1.5;

const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

export class AirCanvas {
  constructor() {
    this.strokes = [];
    this.active = new Map();   // hand key -> stroke being drawn
    this.color = PALETTE[0];
    this.width = 6;
  }

  get isEmpty() {
    return this.strokes.length === 0 && this.active.size === 0;
  }

  setColor(color) {
    this.color = color;
  }

  setWidth(width) {
    this.width = width;
  }

  undo() {
    // Anything mid-stroke is the most recent thing drawn, so it goes first.
    if (this.active.size) {
      for (const stroke of this.active.values()) {
        const i = this.strokes.indexOf(stroke);
        if (i >= 0) this.strokes.splice(i, 1);
      }
      this.active.clear();
      return;
    }
    this.strokes.pop();
  }

  clear() {
    this.strokes = [];
    this.active.clear();
  }

  /**
   * Advance every hand's pinch state and extend its stroke.
   *
   * Points are stored in normalised frame coordinates, not pixels, so that a
   * rotation or resize re-maps existing strokes onto the same place in the
   * scene instead of stretching them.
   *
   * @returns cursor descriptors for on-screen feedback
   */
  update(hands, labels, mapper, enabled) {
    const cursors = [];
    const live = new Set();

    hands.forEach((landmarks, i) => {
      const key = `${labels[i] || 'hand'}:${i}`;
      live.add(key);

      const thumb = mapper(landmarks[THUMB_TIP]);
      const index = mapper(landmarks[INDEX_TIP]);
      const palm = distance(mapper(landmarks[WRIST]), mapper(landmarks[MIDDLE_MCP]));
      if (!palm) return;

      const ratio = distance(thumb, index) / palm;
      const wasPinching = this.active.has(key);
      const pinching = wasPinching ? ratio < PINCH_OPEN : ratio < PINCH_CLOSE;

      // The pen tip sits between the two fingertips, where the pinch visually is.
      const tip = {
        x: (landmarks[THUMB_TIP].x + landmarks[INDEX_TIP].x) / 2,
        y: (landmarks[THUMB_TIP].y + landmarks[INDEX_TIP].y) / 2,
      };

      cursors.push({ key, pinching, screen: { x: (thumb.x + index.x) / 2, y: (thumb.y + index.y) / 2 }, ratio });

      if (!enabled) return;

      if (pinching && !wasPinching) {
        const stroke = { color: this.color, width: this.width, points: [tip] };
        this.strokes.push(stroke);
        this.active.set(key, stroke);
      } else if (pinching) {
        const stroke = this.active.get(key);
        const last = stroke.points[stroke.points.length - 1];
        const moved = distance(mapper(last), mapper(tip));
        if (moved >= MIN_STEP_PX) stroke.points.push(tip);
      } else if (wasPinching) {
        this.finish(key);
      }
    });

    // A hand that left the frame mid-stroke ends that stroke.
    for (const key of [...this.active.keys()]) {
      if (!live.has(key)) this.finish(key);
    }

    return cursors;
  }

  finish(key) {
    const stroke = this.active.get(key);
    this.active.delete(key);
    // A pinch that never moved leaves a single point, which renders as nothing.
    if (stroke && stroke.points.length < 2) {
      const i = this.strokes.indexOf(stroke);
      if (i >= 0) this.strokes.splice(i, 1);
    }
  }

  /** Paint every stroke, mapping stored normalised points to the current view. */
  render(ctx, mapper) {
    if (!this.strokes.length) return;

    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    for (const stroke of this.strokes) {
      const pts = stroke.points.map(mapper);
      if (pts.length < 2) continue;

      ctx.strokeStyle = stroke.color;
      ctx.shadowColor = stroke.color;

      // Wide soft pass then a crisp core, so strokes glow like the skeleton.
      for (const pass of [
        { width: stroke.width * 2.1, alpha: 0.28, blur: 14 },
        { width: stroke.width, alpha: 1, blur: 6 },
      ]) {
        ctx.globalAlpha = pass.alpha;
        ctx.lineWidth = pass.width;
        ctx.shadowBlur = pass.blur;

        ctx.beginPath();
        ctx.moveTo(pts[0].x, pts[0].y);
        // Curve through midpoints: cheap smoothing that avoids visible corners
        // where consecutive samples meet.
        for (let i = 1; i < pts.length - 1; i++) {
          const mx = (pts[i].x + pts[i + 1].x) / 2;
          const my = (pts[i].y + pts[i + 1].y) / 2;
          ctx.quadraticCurveTo(pts[i].x, pts[i].y, mx, my);
        }
        ctx.lineTo(pts[pts.length - 1].x, pts[pts.length - 1].y);
        ctx.stroke();
      }
    }

    ctx.restore();
  }

  /** A ring at each pinch point, filled while that hand is actually drawing. */
  renderCursors(ctx, cursors) {
    ctx.save();
    ctx.shadowBlur = 0;
    for (const c of cursors) {
      ctx.beginPath();
      ctx.arc(c.screen.x, c.screen.y, c.pinching ? 9 : 6, 0, Math.PI * 2);
      ctx.strokeStyle = this.color;
      ctx.lineWidth = 2;
      ctx.globalAlpha = c.pinching ? 1 : 0.55;
      ctx.stroke();
      if (c.pinching) {
        ctx.fillStyle = this.color;
        ctx.globalAlpha = 0.35;
        ctx.fill();
      }
    }
    ctx.restore();
  }
}
