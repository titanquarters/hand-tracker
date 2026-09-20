/**
 * Posing real bone artwork onto tracked landmarks.
 *
 * Each sprite was cut from the anatomical plate already rotated, so its bone
 * runs along the sprite's +x axis starting `pad` pixels in, centred vertically.
 * That is the same local frame the drawn bones use, so posing one is just
 * translate to the joint, rotate, and scale by how long the bone needs to be.
 *
 * Width is deliberately not taken from the bone rig: scaling uniformly by the
 * length ratio keeps each bone's real proportions, which is the whole point of
 * using photographic anatomy rather than drawing it.
 */

const SPRITE_DIR = 'art/bones/';

// These are baked into the ribcage crop rather than cut separately -- they
// barely move independently of the chest, and slicing them out risks cutting
// through the cage itself.
const BAKED_INTO_RIBCAGE = new Set(['scapulaL', 'scapulaR', 'clavicleL', 'clavicleR']);

export async function loadSprites(base = SPRITE_DIR) {
  const root = new URL(base, document.baseURI).href;
  const manifest = await fetch(`${root}manifest.json`).then((r) => {
    if (!r.ok) throw new Error(`no bone manifest at ${root} (${r.status})`);
    return r.json();
  });

  const sprites = new Map();
  await Promise.all(manifest.map((m) => new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => { sprites.set(m.id, { ...m, img }); resolve(); };
    img.onerror = () => reject(new Error(`failed to load bone sprite ${m.id}`));
    img.src = `${root}${m.id}.png`;
  })));

  return sprites;
}

/** Is every bone the rig asks for available as artwork? */
export function spritesCover(sprites, bones) {
  const missing = bones
    .map((b) => b.id)
    .filter((id) => !sprites.has(id) && !BAKED_INTO_RIBCAGE.has(id));
  return { ok: missing.length === 0, missing };
}

/**
 * Draw a posed skeleton from artwork.
 *
 * @param placed bones from bones.layout(), in screen pixels
 * @param sprites map from loadSprites()
 * @param glow    add the greenish bloom that reads at a distance in a dark room
 */
export function drawSkeletonSprites(ctx, placed, sprites, { glow = true, alpha = 1 } = {}) {
  for (const bone of placed) {
    if (BAKED_INTO_RIBCAGE.has(bone.id)) continue;
    const sprite = sprites.get(bone.id);
    if (!sprite) continue;

    // A bone with no measurable length would scale the artwork to nothing.
    const scale = bone.length / sprite.len;
    if (!Number.isFinite(scale) || scale <= 0) continue;

    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.translate(bone.x, bone.y);
    ctx.rotate(bone.angle);
    ctx.scale(scale, scale);

    if (glow) {
      ctx.shadowColor = 'rgba(150, 255, 205, .42)';
      // Blur is in the sprite's own space, so undo the scale to keep it even.
      ctx.shadowBlur = Math.min(40, 9 / scale);
    }
    ctx.drawImage(sprite.img, -sprite.pad, -sprite.h / 2);
    ctx.restore();
  }
}
