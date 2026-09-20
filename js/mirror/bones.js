/**
 * An anatomical skeleton drawn over a tracked body.
 *
 * Every bone is drawn in its own local space -- origin at the joint it starts
 * from, running along +x to its length, centred on y -- and the renderer moves
 * it into place. That keeps each bone a self-contained object, which is what
 * makes the collapse possible: the same shape that was pinned to two landmarks
 * can be handed to the physics engine as a rigid body without redrawing it.
 *
 * Shapes are paths rather than images so they stay sharp at any size on a big
 * screen, and so bone colour can change with the lighting.
 */

// MediaPipe pose landmark indices.
export const L = {
  nose: 0,
  eyeL: 2, eyeR: 5,
  earL: 7, earR: 8,
  shoulderL: 11, shoulderR: 12,
  elbowL: 13, elbowR: 14,
  wristL: 15, wristR: 16,
  pinkyL: 17, pinkyR: 18,
  indexL: 19, indexR: 20,
  hipL: 23, hipR: 24,
  kneeL: 25, kneeR: 26,
  ankleL: 27, ankleR: 28,
  heelL: 29, heelR: 30,
  toeL: 31, toeR: 32,
};

export const BONE_LIGHT = '#e8dcc4';
export const BONE_MID = '#d3c4a6';
export const BONE_DARK = '#8d7f60';
export const BONE_SHADOW = 'rgba(44, 34, 20, .62)';

/* --------------------------------------------------------------- shapes */

/**
 * A classic long bone: a waisted shaft between two knuckled ends.
 * Drawn from (0,0) to (length,0), `w` is the width at the widest point.
 */
function longBone(ctx, length, w) {
  const end = w * 0.5;                 // radius of the knuckled ends
  const waist = w * 0.26;              // half-thickness at the narrow middle
  const x0 = end * 0.62;
  const x1 = length - end * 0.62;

  ctx.beginPath();
  // Top edge, bowing inward toward the middle.
  ctx.moveTo(x0, -end * 0.8);
  ctx.bezierCurveTo(length * 0.3, -waist, length * 0.7, -waist, x1, -end * 0.8);
  // Far end: two lobes, like a femoral condyle.
  ctx.arc(x1, -end * 0.34, end * 0.46, -Math.PI / 2, Math.PI / 2);
  ctx.arc(x1, end * 0.34, end * 0.46, -Math.PI / 2, Math.PI / 2);
  // Bottom edge, back toward the start.
  ctx.bezierCurveTo(length * 0.7, waist, length * 0.3, waist, x0, end * 0.8);
  // Near end.
  ctx.arc(x0, end * 0.34, end * 0.46, Math.PI / 2, (Math.PI * 3) / 2);
  ctx.arc(x0, -end * 0.34, end * 0.46, Math.PI / 2, (Math.PI * 3) / 2);
  ctx.closePath();
}

/** Two slimmer bones side by side -- forearm (radius + ulna), shin (tibia + fibula). */
function pairedBones(ctx, length, w) {
  const offset = w * 0.22;
  ctx.save();
  ctx.translate(0, -offset);
  longBone(ctx, length, w * 0.55);
  ctx.restore();
  ctx.save();
  ctx.translate(0, offset);
  longBone(ctx, length * 0.94, w * 0.42);
  ctx.restore();
}

/**
 * A front-on skull: mandible at the origin, crown at +x, `w` across the head.
 *
 * Front-on rather than in profile because the mirror faces the room -- a
 * profile skull on a person looking at the camera reads as a mistake.
 */
function skull(ctx, length, w) {
  const half = w / 2;

  ctx.beginPath();
  // Jaw, squared off at the chin.
  ctx.moveTo(length * 0.02, -half * 0.52);
  ctx.lineTo(length * 0.02, half * 0.52);
  // Up the cheek to the widest point of the cranium.
  ctx.bezierCurveTo(length * 0.20, half * 0.72, length * 0.34, half * 0.86, length * 0.46, half * 0.97);
  // Over the dome.
  ctx.bezierCurveTo(length * 0.78, half * 0.98, length * 1.02, half * 0.52, length, 0);
  ctx.bezierCurveTo(length * 1.02, -half * 0.52, length * 0.78, -half * 0.98, length * 0.46, -half * 0.97);
  ctx.bezierCurveTo(length * 0.34, -half * 0.86, length * 0.20, -half * 0.72, length * 0.02, -half * 0.52);
  ctx.closePath();
}

/** The hollows: sockets, nasal aperture, teeth. Painted over the skull fill. */
function skullDetail(ctx, length, w) {
  const half = w / 2;

  for (const side of [-1, 1]) {
    ctx.beginPath();
    ctx.ellipse(length * 0.54, side * half * 0.40, length * 0.155, half * 0.29, 0, 0, Math.PI * 2);
    ctx.fill();
  }

  // Nasal aperture, pointing up toward the brow.
  ctx.beginPath();
  ctx.moveTo(length * 0.40, 0);
  ctx.lineTo(length * 0.26, -half * 0.15);
  ctx.lineTo(length * 0.26, half * 0.15);
  ctx.closePath();
  ctx.fill();

  // Teeth: a row along the jaw line.
  const tw = w * 0.115;
  for (let i = -2; i <= 2; i++) {
    ctx.fillRect(length * 0.06, i * tw - tw * 0.42, length * 0.13, tw * 0.82);
  }
  // The jaw line itself.
  ctx.fillRect(length * 0.19, -half * 0.44, length * 0.022, half * 0.88);
}

/**
 * Ribcage: twelve pairs sweeping down and forward off the spine.
 *
 * Real ribs are nothing like horizontal bars. They leave the spine high,
 * angle steeply downward, and wrap forward toward the sternum, so the cage is
 * narrow at the top, widest about two-thirds down, and tapers again at the
 * floating ribs. The lowest two pairs stop short -- they never reach the front.
 *
 * `length` is shoulder to hip; `w` is the half-width at the widest rib.
 */
function ribcage(ctx, length, w) {
  const ribs = 12;
  ctx.lineCap = 'round';

  for (let i = 0; i < ribs; i++) {
    const t = i / (ribs - 1);

    // Where this rib meets the spine.
    const x = length * (0.04 + t * 0.44);

    // Barrel profile: narrow at the collar, widest around rib 8.
    const profile = 0.40 + Math.sin(Math.min(1, 0.16 + t * 0.92) * Math.PI) * 0.60;
    const spread = w * profile;

    // Steeper sweep further down the cage.
    const drop = length * (0.09 + t * 0.20);

    // The last two pairs float: shorter, and they do not curl back in.
    const floating = i >= ribs - 2;
    const reach = floating ? 0.62 : 1;

    ctx.lineWidth = Math.max(1.4, w * 0.105);

    for (const side of [-1, 1]) {
      ctx.beginPath();
      ctx.moveTo(x, side * w * 0.06);
      if (floating) {
        ctx.bezierCurveTo(
          x + drop * 0.30, side * spread * 0.95 * reach,
          x + drop * 0.85, side * spread * 1.00 * reach,
          x + drop * 1.15, side * spread * 0.74 * reach,
        );
      } else {
        // Out around the flank, then forward and up toward the sternum --
        // that last hook is the costal cartilage.
        ctx.bezierCurveTo(
          x + drop * 0.28, side * spread * 1.00,
          x + drop * 1.05, side * spread * 0.98,
          x + drop * 1.32, side * spread * 0.34,
        );
      }
      ctx.stroke();
    }
  }

  // Sternum: a flat blade, wider at the top, with a xiphoid tip.
  ctx.beginPath();
  ctx.moveTo(length * 0.07, -w * 0.15);
  ctx.lineTo(length * 0.30, -w * 0.12);
  ctx.lineTo(length * 0.40, -w * 0.045);
  ctx.lineTo(length * 0.40, w * 0.045);
  ctx.lineTo(length * 0.30, w * 0.12);
  ctx.lineTo(length * 0.07, w * 0.15);
  ctx.closePath();
  ctx.fill();
}

/** Shoulder blade: a triangular plate sitting behind the ribcage. */
function scapula(ctx, length, w) {
  ctx.beginPath();
  ctx.moveTo(0, -w * 0.42);
  ctx.bezierCurveTo(length * 0.52, -w * 0.58, length * 0.92, -w * 0.06, length * 0.74, w * 0.52);
  ctx.bezierCurveTo(length * 0.46, w * 0.30, length * 0.16, w * 0.10, 0, w * 0.34);
  ctx.closePath();
  ctx.fill();
}

/** Kneecap. */
function patella(ctx, w) {
  ctx.beginPath();
  ctx.ellipse(0, 0, w * 0.46, w * 0.38, 0, 0, Math.PI * 2);
  ctx.fill();
}

/** Vertebrae down a length of spine. */
function spine(ctx, length, w, n = 5) {
  for (let i = 0; i < n; i++) {
    const x = length * (0.1 + (i / (n - 1)) * 0.8);
    ctx.beginPath();
    ctx.ellipse(x, 0, (length / n) * 0.34, w * 0.5, 0, 0, Math.PI * 2);
    ctx.fill();
  }
}

/**
 * Pelvis: two iliac blades either side of a sacrum.
 * Drawn from hip to hip, so `length` is the full hip width.
 */
function pelvis(ctx, length, w) {
  const half = length / 2;

  ctx.save();
  ctx.translate(half, 0);            // work outward from the centre
  for (const side of [-1, 1]) {
    ctx.beginPath();
    ctx.moveTo(0, -w * 0.30);
    // Up and out over the iliac crest.
    ctx.bezierCurveTo(half * 0.62 * side, -w * 1.05, half * 1.42 * side, -w * 0.80, half * 1.34 * side, -w * 0.02);
    // Down around the socket and back to the pubis.
    ctx.bezierCurveTo(half * 1.26 * side, w * 0.72, half * 0.66 * side, w * 1.02, half * 0.32 * side, w * 0.56);
    ctx.bezierCurveTo(half * 0.22 * side, w * 0.24, half * 0.14 * side, w * 0.16, 0, w * 0.20);
    ctx.closePath();
    ctx.fill();
  }
  // Sacrum.
  ctx.beginPath();
  ctx.ellipse(0, -w * 0.05, half * 0.20, w * 0.52, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

/** A splayed cluster of metacarpals and phalanges. */
function handBones(ctx, length, w) {
  ctx.lineCap = 'round';
  ctx.lineWidth = w * 0.16;
  for (let i = -2; i <= 2; i++) {
    const spread = i * 0.30;
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.quadraticCurveTo(length * 0.55, spread * w * 0.9, length, spread * w * 1.7);
    ctx.stroke();
  }
}

/** Tarsals and toes, running forward from the ankle. */
function footBones(ctx, length, w) {
  ctx.lineCap = 'round';
  ctx.lineWidth = w * 0.18;
  for (let i = -1.5; i <= 1.5; i++) {
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.quadraticCurveTo(length * 0.5, i * w * 0.24, length, i * w * 0.46);
    ctx.stroke();
  }
  ctx.beginPath();
  ctx.ellipse(0, 0, length * 0.2, w * 0.42, 0, 0, Math.PI * 2);
  ctx.fill();
}

/* ---------------------------------------------------------------- render */

/** Fill-then-outline, so every bone reads as solid with a defined edge. */
function paint(ctx, pathFn, glow) {
  ctx.shadowColor = glow ? 'rgba(180, 255, 210, .55)' : 'transparent';
  ctx.shadowBlur = glow ? 9 : 0;

  ctx.fillStyle = BONE_LIGHT;
  pathFn();
  ctx.fill();

  ctx.shadowBlur = 0;
  ctx.strokeStyle = BONE_DARK;
  ctx.lineWidth = Math.max(1, ctx._boneW * 0.05);
  pathFn();
  ctx.stroke();
}

/**
 * The bones that make up a skeleton, in painting order (back to front).
 *
 * `from`/`to` are landmark indices; `kind` picks the shape; `width` is a
 * multiple of the torso span, so every bone scales with the body rather than
 * with its own length.
 */
export const BONES = [
  { id: 'scapulaL',   kind: 'scapula',  from: L.shoulderL,   to: 'midHip',     width: 0.15 },
  { id: 'scapulaR',   kind: 'scapula',  from: L.shoulderR,   to: 'midHip',     width: 0.15 },
  { id: 'spine',      kind: 'spine',    from: 'midShoulder', to: 'midHip',     width: 0.20 },
  { id: 'cervical',   kind: 'cervical', from: 'midShoulder', to: 'neck',       width: 0.13 },
  { id: 'ribcage',    kind: 'ribcage',  from: 'midShoulder', to: 'midHip',     width: 0.21 },
  { id: 'pelvis',     kind: 'pelvis',   from: L.hipL,        to: L.hipR,       width: 0.115 },
  { id: 'clavicleL',  kind: 'long',     from: L.shoulderL,   to: 'midShoulder', width: 0.10 },
  { id: 'clavicleR',  kind: 'long',     from: L.shoulderR,   to: 'midShoulder', width: 0.10 },
  { id: 'humerusL',   kind: 'long',     from: L.shoulderL,   to: L.elbowL,     width: 0.18 },
  { id: 'humerusR',   kind: 'long',     from: L.shoulderR,   to: L.elbowR,     width: 0.18 },
  { id: 'forearmL',   kind: 'paired',   from: L.elbowL,      to: L.wristL,     width: 0.17 },
  { id: 'forearmR',   kind: 'paired',   from: L.elbowR,      to: L.wristR,     width: 0.17 },
  { id: 'handL',      kind: 'hand',     from: L.wristL,      to: L.indexL,     width: 0.15 },
  { id: 'handR',      kind: 'hand',     from: L.wristR,      to: L.indexR,     width: 0.15 },
  { id: 'femurL',     kind: 'long',     from: L.hipL,        to: L.kneeL,      width: 0.22 },
  { id: 'femurR',     kind: 'long',     from: L.hipR,        to: L.kneeR,      width: 0.22 },
  { id: 'patellaL',   kind: 'patella',  from: L.kneeL,       to: L.ankleL,     width: 0.13 },
  { id: 'shinL',      kind: 'paired',   from: L.kneeL,       to: L.ankleL,     width: 0.20 },
  { id: 'patellaR',   kind: 'patella',  from: L.kneeR,       to: L.ankleR,     width: 0.13 },
  { id: 'shinR',      kind: 'paired',   from: L.kneeR,       to: L.ankleR,     width: 0.20 },
  { id: 'footL',      kind: 'foot',     from: L.ankleL,      to: L.toeL,       width: 0.14 },
  { id: 'footR',      kind: 'foot',     from: L.ankleR,      to: L.toeR,       width: 0.14 },
  { id: 'skull',      kind: 'skull',    from: 'neck',        to: 'crown',      width: 0.40 },
];

const mid = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });

/**
 * Resolve every bone to a placement in screen pixels.
 *
 * @param pts  pose landmarks already mapped to screen coordinates
 * @param span torso span in pixels, used to scale bone thickness
 * @returns [{ id, kind, x, y, angle, length, width }]
 */
export function layout(pts, span) {
  const midShoulder = mid(pts[L.shoulderL], pts[L.shoulderR]);
  const midHip = mid(pts[L.hipL], pts[L.hipR]);
  const midEar = mid(pts[L.earL], pts[L.earR]);

  // Size the head from the ear span, which is a real measurement of the skull,
  // rather than from the neck-to-ear distance, which changes with head tilt.
  const earSpan = Math.hypot(pts[L.earL].x - pts[L.earR].x, pts[L.earL].y - pts[L.earR].y);
  const headWidth = Math.max(earSpan * 1.26, span * 0.19);
  const headLen = headWidth * 1.38;

  // Base of the skull: up from the shoulders toward the ears.
  const toEar = { x: midEar.x - midShoulder.x, y: midEar.y - midShoulder.y };
  const toEarLen = Math.hypot(toEar.x, toEar.y) || 1;
  const up = { x: toEar.x / toEarLen, y: toEar.y / toEarLen };
  const neck = {
    x: midEar.x - up.x * headLen * 0.52,
    y: midEar.y - up.y * headLen * 0.52,
  };

  const anchor = (ref) => {
    if (typeof ref === 'number') return pts[ref];
    if (ref === 'midShoulder') return midShoulder;
    if (ref === 'midHip') return midHip;
    if (ref === 'neck') return neck;
    if (ref === 'crown') return { x: neck.x + up.x * headLen, y: neck.y + up.y * headLen };
    return midHip;
  };

  return BONES.map((bone) => {
    const a = anchor(bone.from);
    const b = anchor(bone.to);
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    let length = Math.hypot(dx, dy);
    let width = span * bone.width;
    if (bone.kind === 'scapula') length = span * 0.24;
    if (bone.kind === 'patella') length = span * 0.10;
    if (bone.kind === 'skull') {
      length = headLen;
      width = headWidth;
    }

    return {
      id: bone.id,
      kind: bone.kind,
      x: a.x,
      y: a.y,
      angle: Math.atan2(dy, dx),
      length: Math.max(length, span * 0.08),
      width,
    };
  });
}

/** Draw one placed bone. Assumes the caller has already set the transform. */
export function drawBoneLocal(ctx, placed, glow) {
  const { kind, length, width } = placed;
  ctx._boneW = width;

  switch (kind) {
    case 'long':
      paint(ctx, () => longBone(ctx, length, width), glow);
      break;
    case 'paired':
      paint(ctx, () => pairedBones(ctx, length, width), glow);
      break;
    case 'skull':
      paint(ctx, () => skull(ctx, length, width), glow);
      ctx.fillStyle = BONE_SHADOW;
      skullDetail(ctx, length, width);
      break;
    case 'ribcage':
      ctx.fillStyle = BONE_LIGHT;
      ctx.strokeStyle = BONE_LIGHT;
      ctx.shadowColor = glow ? 'rgba(180, 255, 210, .5)' : 'transparent';
      ctx.shadowBlur = glow ? 7 : 0;
      ribcage(ctx, length, width);
      ctx.shadowBlur = 0;
      break;
    case 'scapula':
      ctx.fillStyle = BONE_MID;
      ctx.shadowBlur = 0;
      scapula(ctx, length, width);
      break;
    case 'patella':
      ctx.fillStyle = BONE_LIGHT;
      ctx.shadowBlur = 0;
      patella(ctx, width);
      break;
    case 'spine':
      ctx.fillStyle = BONE_MID;
      spine(ctx, length, width);
      break;
    case 'cervical':
      ctx.fillStyle = BONE_MID;
      spine(ctx, length, width, 4);
      break;
    case 'pelvis':
      ctx.fillStyle = BONE_LIGHT;
      ctx.shadowColor = glow ? 'rgba(180, 255, 210, .5)' : 'transparent';
      ctx.shadowBlur = glow ? 7 : 0;
      pelvis(ctx, length, width);
      ctx.shadowBlur = 0;
      break;
    case 'hand':
      ctx.strokeStyle = BONE_LIGHT;
      handBones(ctx, length, width);
      break;
    case 'foot':
      ctx.strokeStyle = BONE_LIGHT;
      ctx.fillStyle = BONE_LIGHT;
      footBones(ctx, length, width);
      break;
  }
}

/** Draw a whole skeleton from placed bones. */
export function drawSkeleton(ctx, placed, glow = true) {
  for (const bone of placed) {
    ctx.save();
    ctx.translate(bone.x, bone.y);
    ctx.rotate(bone.angle);
    drawBoneLocal(ctx, bone, glow);
    ctx.restore();
  }
}
