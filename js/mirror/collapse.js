/**
 * The collapse: a skeleton stops following its owner and falls apart.
 *
 * Every bone is already a self-contained piece pinned between two landmarks,
 * so the handover is cheap -- at the moment of collapse each bone becomes a
 * rigid body at exactly the position, angle and velocity it already had, and
 * physics takes over. Reassembly is the same move in reverse.
 *
 * Gravity is scaled by how large the person appears on screen. With a fixed
 * pixels-per-second-squared a distant skeleton falls a shorter pixel distance
 * and lands visibly too fast; scaling by apparent size makes near and far
 * collapses take the same time, which is what the eye expects.
 */

const { Engine, Composite, Bodies, Body } = window.Matter;

export const ATTACHED = 'attached';
export const FALLING = 'falling';
export const REFORMING = 'reforming';

// Real gravity, expressed in torso spans. A torso (shoulder to hip) is roughly
// half a metre, so one metre is about two spans and 9.81 m/s^2 lands near
// 19.6 spans/s^2. Scaling by the on-screen span is what keeps a distant
// skeleton from appearing to fall faster than a near one.
const GRAVITY_SPANS_PER_S2 = 19.6;

// How long bones lie on the floor before they fly back together.
const REST_MS = 2600;
const REFORM_MS = 620;

/**
 * Matter applies `gravity.y * gravity.scale` as an acceleration in px per
 * millisecond squared -- not per second squared. Converting from px/s^2 needs
 * a factor of a million, and getting that wrong sends bones off-screen in a
 * single frame.
 */
function gravityFor(span) {
  return (GRAVITY_SPANS_PER_S2 * span) / 1e6;
}

export class Collapse {
  /**
   * @param placed bones from bones.layout(), in screen pixels
   * @param floorY the ground for this person, in screen pixels
   * @param span   torso span in pixels
   * @param motion per-bone velocity in px/s, keyed by bone id
   */
  constructor(placed, floorY, span, motion) {
    this.engine = Engine.create();
    this.engine.gravity.y = 1;
    this.engine.gravity.scale = gravityFor(span);

    this.span = span;
    this.floorY = floorY;
    this.state = FALLING;
    this.settledAt = 0;
    this.bodies = new Map();

    // The ground, plus low walls so bones cannot slide out of frame.
    const width = span * 14;
    const cx = placed.reduce((sum, b) => sum + b.x, 0) / placed.length;
    this.ground = Bodies.rectangle(cx, floorY + span * 0.25, width, span * 0.5, {
      isStatic: true,
      friction: 0.9,
      restitution: 0.02,
    });
    const wall = (x) => Bodies.rectangle(x, floorY - span, span * 0.4, span * 4, {
      isStatic: true, friction: 0.4,
    });
    Composite.add(this.engine.world, [this.ground, wall(cx - span * 3.2), wall(cx + span * 3.2)]);

    for (const bone of placed) {
      // Collision shape: the bone's own footprint, floored so thin pieces
      // like ribs still have something to land on.
      const w = Math.max(bone.length, span * 0.12);
      const h = Math.max(bone.width * 0.7, span * 0.05);

      // Bodies are positioned at their centre; bones are drawn from one end.
      const cxB = bone.x + Math.cos(bone.angle) * bone.length * 0.5;
      const cyB = bone.y + Math.sin(bone.angle) * bone.length * 0.5;

      const body = Bodies.rectangle(cxB, cyB, w, h, {
        angle: bone.angle,
        friction: 0.55,
        frictionAir: 0.012,
        restitution: 0.18,
        density: 0.0015,
      });

      const v = motion?.[bone.id];
      if (v) {
        // Matter velocities are per step, not per second.
        Body.setVelocity(body, { x: (v.x / 60) * 0.8, y: (v.y / 60) * 0.8 });
      }
      // A little spin so the pile does not look laid out by hand.
      Body.setAngularVelocity(body, (Math.random() - 0.5) * 0.28);

      Composite.add(this.engine.world, body);
      this.bodies.set(bone.id, { body, bone, halfLength: bone.length * 0.5 });
    }
  }

  /** True once every bone has essentially stopped moving. */
  get settled() {
    for (const { body } of this.bodies.values()) {
      if (Math.hypot(body.velocity.x, body.velocity.y) > 0.35) return false;
      if (Math.abs(body.angularVelocity) > 0.05) return false;
    }
    return true;
  }

  step(dtMs, now) {
    // Matter is stable at a fixed timestep; a long frame is clamped rather
    // than integrated in one huge jump, which would tunnel bones through the floor.
    Engine.update(this.engine, Math.min(dtMs, 33));

    if (this.state === FALLING && this.settled) {
      if (!this.settledAt) this.settledAt = now;
      if (now - this.settledAt > REST_MS) {
        this.state = REFORMING;
        this.reformStart = now;
        this.from = new Map();
        for (const [id, entry] of this.bodies) {
          this.from.set(id, { x: entry.body.position.x, y: entry.body.position.y, angle: entry.body.angle });
        }
      }
    } else if (this.state === FALLING) {
      this.settledAt = 0;
    }
  }

  /**
   * Where each bone should be drawn this frame.
   *
   * While falling, that is wherever physics put it. While reforming, it eases
   * from there back onto the live landmarks, so the bones fly home.
   *
   * @param target current bones.layout() for the person, or null if they left
   * @returns { placed, done }
   */
  render(target, now) {
    const out = [];

    if (this.state === REFORMING && target) {
      const t = Math.min(1, (now - this.reformStart) / REFORM_MS);
      // Ease out, so bones leave the floor fast and settle gently into place.
      const e = 1 - Math.pow(1 - t, 3);

      for (const bone of target) {
        const from = this.from.get(bone.id);
        const entry = this.bodies.get(bone.id);
        if (!from || !entry) { out.push(bone); continue; }

        // The body's centre maps back to the bone's start point.
        const fromX = from.x - Math.cos(from.angle) * entry.halfLength;
        const fromY = from.y - Math.sin(from.angle) * entry.halfLength;

        out.push({
          ...bone,
          x: fromX + (bone.x - fromX) * e,
          y: fromY + (bone.y - fromY) * e,
          angle: from.angle + shortestTurn(from.angle, bone.angle) * e,
        });
      }
      return { placed: out, done: t >= 1 };
    }

    for (const { body, bone, halfLength } of this.bodies.values()) {
      out.push({
        ...bone,
        x: body.position.x - Math.cos(body.angle) * halfLength,
        y: body.position.y - Math.sin(body.angle) * halfLength,
        angle: body.angle,
      });
    }
    return { placed: out, done: false };
  }

  destroy() {
    Composite.clear(this.engine.world, false);
    Engine.clear(this.engine);
    this.bodies.clear();
  }
}

/** Rotate the short way round, so a bone never spins 350 degrees to reach 10. */
function shortestTurn(from, to) {
  let d = (to - from) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
}
