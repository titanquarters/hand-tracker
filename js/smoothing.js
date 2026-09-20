/**
 * One Euro filter, applied per landmark.
 *
 * Raw landmarks jitter by a pixel or two every frame even when a hand is
 * perfectly still, which reads as a nervous, shimmering skeleton. A plain
 * low-pass fixes the shimmer but smears fast motion into visible lag.
 *
 * The One Euro filter (Casiez, Roussel & Vogel, CHI 2012) adapts instead: it
 * filters hard when the point is moving slowly, where jitter is what you see,
 * and barely at all when it is moving fast, where lag is what you see. Two
 * knobs matter -- `minCutoff` sets the smoothing floor at rest, and `beta`
 * sets how quickly that relaxes as the point speeds up.
 */

/** Exponential smoothing with an externally supplied coefficient. */
class LowPass {
  constructor() {
    this.value = null;
  }

  filter(x, alpha) {
    this.value = this.value === null ? x : alpha * x + (1 - alpha) * this.value;
    return this.value;
  }

  reset() {
    this.value = null;
  }
}

/** Smoothing coefficient for a given cutoff frequency and timestep. */
function alphaFor(cutoffHz, dt) {
  const tau = 1 / (2 * Math.PI * cutoffHz);
  return 1 / (1 + tau / dt);
}

class OneEuro {
  constructor(minCutoff, beta, derivativeCutoff = 1) {
    this.minCutoff = minCutoff;
    this.beta = beta;
    this.derivativeCutoff = derivativeCutoff;
    this.previous = null;
    this.valueFilter = new LowPass();
    this.speedFilter = new LowPass();
  }

  filter(x, dt) {
    // Smooth the speed estimate too, or noise in the input becomes noise in
    // the cutoff and the filter fights itself.
    const speed = this.previous === null ? 0 : (x - this.previous) / dt;
    const smoothedSpeed = this.speedFilter.filter(speed, alphaFor(this.derivativeCutoff, dt));

    const cutoff = this.minCutoff + this.beta * Math.abs(smoothedSpeed);
    const out = this.valueFilter.filter(x, alphaFor(cutoff, dt));

    this.previous = x;
    return out;
  }

  reset() {
    this.previous = null;
    this.valueFilter.reset();
    this.speedFilter.reset();
  }

  retune(minCutoff, beta) {
    this.minCutoff = minCutoff;
    this.beta = beta;
  }
}

const AXES = ['x', 'y', 'z'];

/**
 * One filter per axis per landmark, for a single tracked body.
 *
 * The bank sizes itself on first use, so the same class serves hands (21
 * landmarks) and full-body poses (33).
 */
class LandmarkFilters {
  constructor(minCutoff, beta) {
    this.minCutoff = minCutoff;
    this.beta = beta;
    this.filters = [];
    this.lastSeen = 0;
  }

  grow(count) {
    while (this.filters.length < count) {
      this.filters.push({
        x: new OneEuro(this.minCutoff, this.beta),
        y: new OneEuro(this.minCutoff, this.beta),
        z: new OneEuro(this.minCutoff, this.beta),
      });
    }
  }

  apply(landmarks, dt) {
    this.grow(landmarks.length);
    return landmarks.map((point, i) => {
      const f = this.filters[i];
      const out = { ...point };
      for (const axis of AXES) {
        if (typeof point[axis] === 'number') out[axis] = f[axis].filter(point[axis], dt);
      }
      return out;
    });
  }

  reset() {
    for (const f of this.filters) for (const axis of AXES) f[axis].reset();
  }

  retune(minCutoff, beta) {
    this.minCutoff = minCutoff;
    this.beta = beta;
    for (const f of this.filters) for (const axis of AXES) f[axis].retune(minCutoff, beta);
  }
}

// A hand that vanishes and returns must not be smoothed across the gap, or the
// skeleton visibly slides in from wherever the hand used to be.
const STALE_MS = 250;

/** Strength 0..1 mapped onto the filter's two knobs. */
function tuningFor(strength) {
  const s = Math.max(0, Math.min(1, strength));
  return {
    // Low cutoff = heavy smoothing. Geometric, not linear: cutoff acts on a
    // frequency scale, so a linear ramp spends most of the slider doing almost
    // nothing and then turns syrupy right at the end.
    minCutoff: 6 * Math.pow(0.055, s),
    // Heavier smoothing at rest needs a steeper relaxation to stay responsive
    // once the hand actually moves.
    beta: 0.3 + 1.5 * s,
  };
}

/**
 * Smooths whole detection results, keeping a separate filter bank per subject.
 *
 * Banks are keyed on a caller-supplied label rather than array position,
 * because MediaPipe may reorder its results between frames and a positional
 * key would then swap two subjects' histories -- which looks far worse than no
 * smoothing at all. Hands pass their handedness; poses pass a tracking id.
 */
export class HandSmoother {
  constructor(strength = 0.5) {
    this.banks = new Map();
    this.setStrength(strength);
  }

  setStrength(strength) {
    this.strength = strength;
    const { minCutoff, beta } = tuningFor(strength);
    this.minCutoff = minCutoff;
    this.beta = beta;
    for (const bank of this.banks.values()) {
      bank.screen.retune(minCutoff, beta);
      bank.world.retune(minCutoff, beta);
    }
  }

  reset() {
    this.banks.clear();
  }

  bankFor(key, now) {
    let bank = this.banks.get(key);
    if (!bank) {
      bank = {
        screen: new LandmarkFilters(this.minCutoff, this.beta),
        world: new LandmarkFilters(this.minCutoff, this.beta),
        lastSeen: now,
      };
      this.banks.set(key, bank);
    } else if (now - bank.lastSeen > STALE_MS) {
      bank.screen.reset();
      bank.world.reset();
    }
    bank.lastSeen = now;
    return bank;
  }

  /**
   * @param hands  landmark arrays, normalised to the frame
   * @param world  metric landmark arrays, or an empty array
   * @param labels one key per subject, used to pick its filter bank
   * @param now    timestamp in ms
   */
  apply(hands, world, labels, now) {
    const dt = this.lastTime ? (now - this.lastTime) / 1000 : 1 / 30;
    this.lastTime = now;

    // A stalled tab or a dropped frame must not produce an absurd timestep.
    const step = Math.min(0.2, Math.max(1 / 240, dt));

    const seen = new Set();
    const outHands = [];
    const outWorld = [];

    hands.forEach((landmarks, i) => {
      // Two hands can share a label; disambiguate with the slot index.
      const key = `${labels[i] || 'hand'}:${seen.has(labels[i]) ? i : 0}`;
      seen.add(labels[i]);

      const bank = this.bankFor(key, now);
      outHands.push(bank.screen.apply(landmarks, step));
      if (world[i]) outWorld.push(bank.world.apply(world[i], step));
    });

    // Drop banks for hands that have been gone a while, so the map cannot grow
    // without bound over a long session.
    for (const [key, bank] of this.banks) {
      if (now - bank.lastSeen > 5000) this.banks.delete(key);
    }

    return { hands: outHands, world: outWorld };
  }
}
