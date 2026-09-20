/**
 * Cut the anatomical plate in art/source-skeleton.png into individual bone
 * sprites that can be posed onto tracked landmarks.
 *
 * Each bone is described by its two ends in SOURCE image coordinates plus a
 * half-width. The slicer extracts it already rotated so the bone runs along
 * +x with its proximal end at the origin -- the same local frame the drawn
 * bones use -- so posing a sprite is just translate, rotate, scale.
 *
 * The plate is a labelled diagram, so two things are cleaned up on the way
 * out: the white background is keyed to transparent, and the blue/red leader
 * lines that cross the bones are inpainted from neighbouring bone pixels
 * rather than left as holes.
 */
import { chromium } from 'playwright';
import { readFileSync, writeFileSync, mkdirSync } from 'fs';

const SRC = new URL('../art/source-skeleton.png', import.meta.url).pathname;
const OUT = new URL('../art/bones/', import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });

/**
 * id, from [x,y], to [x,y], halfWidth -- all in source pixels.
 * `from` is the joint the bone hangs off, matching the drawn bone rig.
 */
export const SLICES = [
  // Coordinates measured from the ink silhouette of the source plate, not
  // eyeballed: for each row of the image the extent of non-paper, non-label
  // pixels was profiled, which gives each bone's real centre line.
  //
  // The clavicles, scapulae and sternum are deliberately left inside the
  // ribcage crop. They barely move independently of the chest, and cutting
  // them out separately risks slicing through the cage itself.
  { id: 'skull',    from: [596, 302], to: [596, 55],  halfWidth: 112, keepDark: true },
  { id: 'cervical', from: [597, 430], to: [597, 306], halfWidth: 56, keepDark: true },
  { id: 'ribcage',  from: [597, 438], to: [597, 892], halfWidth: 228 },
  { id: 'spine',    from: [595, 872], to: [595, 1006], halfWidth: 54 },
  { id: 'pelvis',   from: [382, 1078], to: [798, 1078], halfWidth: 122 },

  { id: 'humerusL', from: [325, 498], to: [250, 882], halfWidth: 44 },
  { id: 'humerusR', from: [868, 498], to: [915, 882], halfWidth: 46 },
  { id: 'forearmL', from: [236, 896], to: [232, 1200], halfWidth: 46 },
  { id: 'forearmR', from: [936, 896], to: [988, 1200], halfWidth: 46 },
  { id: 'handL',    from: [230, 1206], to: [240, 1446], halfWidth: 76 },
  { id: 'handR',    from: [1020, 1206], to: [1075, 1446], halfWidth: 80 },

  { id: 'femurL',   from: [395, 1186], to: [515, 1700], halfWidth: 50 },
  { id: 'femurR',   from: [775, 1186], to: [665, 1700], halfWidth: 50 },
  { id: 'patellaL', from: [515, 1688], to: [515, 1748], halfWidth: 34 },
  { id: 'patellaR', from: [650, 1688], to: [650, 1748], halfWidth: 34 },
  { id: 'shinL',    from: [514, 1752], to: [530, 2266], halfWidth: 62 },
  { id: 'shinR',    from: [666, 1752], to: [639, 2266], halfWidth: 62 },
  { id: 'footL',    from: [530, 2270], to: [440, 2412], halfWidth: 92 },
  { id: 'footR',    from: [638, 2270], to: [725, 2412], halfWidth: 92 },
];

const b64 = 'data:image/png;base64,' + readFileSync(SRC).toString('base64');

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });

const result = await page.evaluate(async ({ src, slices }) => {
  const img = await new Promise((r) => { const i = new Image(); i.onload = () => r(i); i.src = src; });

  /** Blue or red leader lines and dots. */
  const isLabel = (r, g, b) => (b > r + 30 && b > g + 22) || (r > g + 55 && r > b + 30 && g < 130);

  /**
   * Background. As well as flat paper this has to catch the pale halo that
   * anti-aliasing leaves around every blue leader line -- those pixels are too
   * light to read as a label and too tinted to read as paper, and left alone
   * they show up as white scratches across the finished bone.
   */
  const isPaper = (r, g, b) => (r > 232 && g > 232 && b > 232)
    || (r > 198 && g > 206 && b > 212 && b >= r + 8);

  /** Black label text. Bone is warm and light; type is dark and neutral. */
  const isType = (r, g, b) => {
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    return max < 118 && max - min < 34;
  };

  const out = [];

  for (const s of slices) {
    const dx = s.to[0] - s.from[0];
    const dy = s.to[1] - s.from[1];
    const len = Math.hypot(dx, dy);
    const angle = Math.atan2(dy, dx);

    // A little padding so knuckled bone ends are not clipped.
    const pad = Math.max(8, s.halfWidth * 0.18);
    const w = Math.ceil(len + pad * 2);
    const h = Math.ceil(s.halfWidth * 2);

    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const ctx = c.getContext('2d', { willReadFrequently: true });

    // Map the source so the bone axis runs along +x starting at x = pad.
    ctx.translate(pad, h / 2);
    ctx.rotate(-angle);
    ctx.translate(-s.from[0], -s.from[1]);
    ctx.drawImage(img, 0, 0);
    ctx.setTransform(1, 0, 0, 1, 0, 0);

    const image = ctx.getImageData(0, 0, w, h);
    const d = image.data;

    // Pass 1: classify.
    const label = new Uint8Array(w * h);
    for (let i = 0, p = 0; i < d.length; i += 4, p++) {
      const r = d[i], g = d[i + 1], b = d[i + 2];
      if (d[i + 3] < 8 || isPaper(r, g, b)) { d[i + 3] = 0; continue; }
      // The skull's nasal aperture and eye sockets are genuinely black, so
      // the type rule is skipped on the pieces that contain them.
      if (isLabel(r, g, b) || (!s.keepDark && isType(r, g, b))) label[p] = 1;
    }

    // Pass 2: inpaint annotation pixels from the nearest real bone pixels,
    // so leader lines do not leave stripes through a femur.
    for (let pass = 0; pass < 4; pass++) {
      let changed = 0;
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const p = y * w + x;
          if (!label[p]) continue;
          let rs = 0, gs = 0, bs = 0, n = 0;
          for (let oy = -1; oy <= 1; oy++) {
            for (let ox = -1; ox <= 1; ox++) {
              const nx = x + ox, ny = y + oy;
              if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
              const q = ny * w + nx;
              if (label[q] || d[q * 4 + 3] === 0) continue;
              rs += d[q * 4]; gs += d[q * 4 + 1]; bs += d[q * 4 + 2]; n++;
            }
          }
          if (n >= 2) {
            d[p * 4] = rs / n; d[p * 4 + 1] = gs / n; d[p * 4 + 2] = bs / n; d[p * 4 + 3] = 255;
            label[p] = 0; changed++;
          }
        }
      }
      if (!changed) break;
    }
    // Anything still marked was never adjacent to bone -- drop it.
    for (let p = 0; p < w * h; p++) if (label[p]) d[p * 4 + 3] = 0;

    /**
     * Feather the crop border.
     *
     * A bone never sits alone on the plate -- the lumbar spine has pelvis
     * either side of it, the neck has jaw above. Whatever neighbouring anatomy
     * falls inside the crop is real ink, so keying leaves it, and it ends in a
     * hard rectangular edge that reads as a slab on screen. Fading alpha over
     * the outermost band hides the seam without touching the bone itself,
     * which sits well inside.
     */
    const feather = Math.max(4, Math.min(w, h) * 0.12);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const edge = Math.min(x, y, w - 1 - x, h - 1 - y);
        if (edge >= feather) continue;
        const a = (y * w + x) * 4 + 3;
        d[a] = Math.round(d[a] * (edge / feather));
      }
    }

    ctx.putImageData(image, 0, 0);

    // How much of the crop is actually ink? A near-empty crop means the
    // coordinates are wrong, which is worth reporting rather than shipping.
    let ink = 0;
    for (let i = 3; i < d.length; i += 4) if (d[i] > 40) ink++;

    out.push({
      id: s.id, w, h, len, pad,
      inkPct: +((ink / (w * h)) * 100).toFixed(1),
      png: c.toDataURL('image/png'),
    });
  }
  return out;
}, { src: b64, slices: SLICES });

const manifest = [];
for (const bone of result) {
  writeFileSync(`${OUT}${bone.id}.png`, Buffer.from(bone.png.split(',')[1], 'base64'));
  manifest.push({ id: bone.id, w: bone.w, h: bone.h, len: bone.len, pad: bone.pad });
  const flag = bone.inkPct < 8 ? '  <-- suspiciously empty' : '';
  console.log(`${bone.id.padEnd(10)} ${String(bone.w).padStart(4)}x${String(bone.h).padStart(4)}  ink ${String(bone.inkPct).padStart(5)}%${flag}`);
}
writeFileSync(`${OUT}manifest.json`, JSON.stringify(manifest, null, 2));

await browser.close();
console.log(`\n${manifest.length} sprites -> art/bones/`);
