/**
 * Watching for stillness, which is what triggers a collapse.
 *
 * Drift is measured against the body's on-screen torso span rather than in
 * pixels, so "holding still" means the same thing whether someone is next to
 * the camera or across the room.
 *
 * This lives apart from the collapse itself because it is pure observation --
 * it has no opinion about how the skeleton then comes apart, which lets the
 * physics behind that change without touching it.
 */

/**
 * Watches a body for stillness, which is what triggers a collapse.
 *
 * Measured against torso span rather than pixels, so holding still reads the
 * same whether you are near the camera or across the room.
 */
export class StillnessWatch {
  constructor({ holdMs = 2200, threshold = 0.055 } = {}) {
    this.holdMs = holdMs;
    this.threshold = threshold;
    this.subjects = new Map();
  }

  /** @returns true when this subject has just crossed into "held still". */
  update(key, pts, span, now) {
    let s = this.subjects.get(key);
    if (!s) {
      s = { prev: null, stillSince: 0, fired: false };
      this.subjects.set(key, s);
    }

    if (s.prev && s.prev.length === pts.length && span > 0) {
      let drift = 0;
      for (let i = 0; i < pts.length; i++) {
        drift += Math.hypot(pts[i].x - s.prev[i].x, pts[i].y - s.prev[i].y);
      }
      const perLandmark = drift / pts.length / span;

      if (perLandmark < this.threshold) {
        if (!s.stillSince) s.stillSince = now;
      } else {
        s.stillSince = 0;
        s.fired = false;
      }
    }

    s.prev = pts.map((p) => ({ x: p.x, y: p.y }));

    if (s.stillSince && !s.fired && now - s.stillSince >= this.holdMs) {
      s.fired = true;
      return true;
    }
    return false;
  }

  /** Called when a collapse ends, so the same person can trigger another. */
  rearm(key) {
    const s = this.subjects.get(key);
    if (s) { s.stillSince = 0; s.fired = false; }
  }

  forget(key) {
    this.subjects.delete(key);
  }
}
