/**
 * Where is the ground?
 *
 * The bone pile has to land at the person's feet, and the obvious answers are
 * both wrong. The bottom of the screen is wrong for everyone except someone
 * standing at one exact distance. A single calibrated floor line is wrong for
 * the same reason: a guest at the back of the room has their feet much higher
 * in frame than one standing close.
 *
 * So the floor is per person, taken from their own feet, every frame. That is
 * not a shortcut -- it gets perspective right for free, and it survives uneven
 * ground, a step, or someone sitting on the arm of a sofa.
 *
 * Feet are not always visible, so it falls back in stages:
 *
 *   1. the lowest confidently-seen foot landmark
 *   2. the last good value, held while the feet are briefly hidden
 *   3. a high-water mark learned from everyone seen so far this session
 *   4. a line set by hand during setup
 *
 * The high-water mark is what makes the installation self-calibrating: after a
 * few guests have walked past with their feet in shot, the room's real floor is
 * known, and someone later framed from the waist up still gets a sane answer.
 */

// MediaPipe pose landmarks, lowest parts of the body first.
export const FOOT_LANDMARKS = [31, 32, 29, 30, 27, 28]; // toes, heels, ankles

// Below this the model is guessing at an unseen limb rather than seeing it.
const MIN_VISIBILITY = 0.7;

// How long a remembered floor stays usable once the feet go out of view.
const HOLD_MS = 2000;

// Learned-floor samples are kept as a sorted list; this percentile is used so
// one bad frame (a foot mis-placed near the bottom edge) cannot drag it down.
const LEARNED_PERCENTILE = 0.9;
const MAX_SAMPLES = 400;

/** The lowest foot landmark we can actually trust, in normalised units. */
export function measuredFoot(landmarks) {
  let best = null;
  for (const i of FOOT_LANDMARKS) {
    const p = landmarks[i];
    if (!p) continue;
    // Absent visibility means the model does not score it; treat as usable.
    const seen = p.visibility === undefined || p.visibility >= MIN_VISIBILITY;
    if (!seen) continue;
    if (best === null || p.y > best) best = p.y;
  }
  return best;
}

/**
 * Apparent size of a body on screen, as the shoulder-to-hip span.
 *
 * Gravity is scaled by this. With a fixed pixels-per-second-squared, a distant
 * skeleton falls a shorter pixel distance and so hits the ground visibly too
 * fast; scaling by apparent size makes near and far collapses take the same
 * time, which is what the eye expects.
 */
export function torsoSpan(landmarks) {
  const mid = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
  const shoulder = mid(landmarks[11], landmarks[12]);
  const hip = mid(landmarks[23], landmarks[24]);
  return Math.hypot(shoulder.x - hip.x, shoulder.y - hip.y);
}

export class FloorEstimator {
  constructor() {
    this.samples = [];
    this.perSubject = new Map();
    this.manual = null;       // normalised y set during setup, if any
  }

  setManual(y) {
    this.manual = y;
  }

  clearManual() {
    this.manual = null;
  }

  /** The floor learned from every foot seen so far this session. */
  get learned() {
    if (!this.samples.length) return null;
    const sorted = [...this.samples].sort((a, b) => a - b);
    const i = Math.min(sorted.length - 1, Math.floor(sorted.length * LEARNED_PERCENTILE));
    return sorted[i];
  }

  /**
   * Floor for one subject this frame.
   *
   * @param key        stable id for the subject across frames
   * @param landmarks  that subject's normalised pose landmarks
   * @param now        timestamp in ms
   * @returns { y, source } with y in normalised units, or null if unknown
   */
  update(key, landmarks, now) {
    const measured = measuredFoot(landmarks);

    let held = this.perSubject.get(key);
    if (!held) {
      held = { y: null, at: 0 };
      this.perSubject.set(key, held);
    }

    if (measured !== null) {
      held.y = measured;
      held.at = now;

      this.samples.push(measured);
      if (this.samples.length > MAX_SAMPLES) this.samples.shift();

      return { y: measured, source: 'feet' };
    }

    if (held.y !== null && now - held.at <= HOLD_MS) {
      return { y: held.y, source: 'held' };
    }

    const learned = this.learned;
    if (learned !== null) return { y: learned, source: 'learned' };

    if (this.manual !== null) return { y: this.manual, source: 'manual' };

    return null;
  }

  /** Forget subjects that have not been seen for a while. */
  prune(now) {
    for (const [key, held] of this.perSubject) {
      if (now - held.at > 10_000) this.perSubject.delete(key);
    }
  }

  reset() {
    this.samples = [];
    this.perSubject.clear();
  }
}
