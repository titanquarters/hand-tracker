/**
 * Turn the Z-Anatomy skeletal FBX into a GLB the mirror can pose.
 *
 * The source is a medical atlas: 1,952 separately named structures, bones and
 * soft tissue together, nearly five million vertices, in a standing rest pose
 * at life size. None of that is usable directly -- it is far too heavy to ship
 * and far too granular to drive from 33 pose landmarks.
 *
 * So this collapses it into the ~20 pieces the rig actually moves. Each piece
 * merges every mesh belonging to it into one geometry, and records where its
 * two joints sit in the rest pose. Posing later is then the same move used
 * everywhere else in this project: map the rest-pose joint pair onto the live
 * landmark pair with a rotate, a uniform scale and a translate.
 *
 *   node scripts/extract-skeleton.mjs
 */
import { chromium } from 'playwright';
import { writeFileSync, statSync } from 'fs';

const ORIGIN = process.env.ORIGIN || 'http://localhost:8080';
const OUT = new URL('../art/skeleton.glb', import.meta.url).pathname;

/**
 * Which source meshes make up each posable bone, and which way it runs.
 *
 * `axis` says how to read the rest-pose joints off the merged geometry:
 * 'y' means the bone runs down its own bounding box (proximal at the top),
 * 'x' means across (used for the pelvis and collarbones).
 */
const PARTS = [
  { id: 'skull',    axis: 'y', flip: true,
    match: /frontal_bone|parietal|temporal_bone|occipital|sphenoid|ethmoid|maxilla|zygomatic|nasal_bone|vomer|lacrimal|palatine|concha|mandible|_tooth/i },
  { id: 'ribcage',  axis: 'y', match: /_rib|costal_cartilage|sternum|manubrium|xiphoid|thoracic_vertebra/i },
  { id: 'cervical', axis: 'y', flip: true, match: /cervical_vertebra|atlas|axis_vertebra|^Axis$/i },
  { id: 'spine',    axis: 'y', match: /lumbar_vertebra/i },
  { id: 'pelvis',   axis: 'x', match: /hip_bone|ilium|ischium|pubis|pubic|sacrum|coccyx/i },

  { id: 'clavicleL', axis: 'x', side: 'l', match: /clavicle/i },
  { id: 'clavicleR', axis: 'x', side: 'r', match: /clavicle/i },
  { id: 'scapulaL',  axis: 'y', side: 'l', match: /scapula/i },
  { id: 'scapulaR',  axis: 'y', side: 'r', match: /scapula/i },

  { id: 'humerusL', axis: 'y', side: 'l', match: /humerus/i },
  { id: 'humerusR', axis: 'y', side: 'r', match: /humerus/i },
  { id: 'forearmL', axis: 'y', side: 'l', match: /radius|ulna/i },
  { id: 'forearmR', axis: 'y', side: 'r', match: /radius|ulna/i },
  { id: 'handL',    axis: 'y', side: 'l', match: /carpal|metacarpal|phalanx|phalange|hamate|capitate|lunate|scaphoid|trapezi|pisiform|triquetrum/i },
  { id: 'handR',    axis: 'y', side: 'r', match: /carpal|metacarpal|phalanx|phalange|hamate|capitate|lunate|scaphoid|trapezi|pisiform|triquetrum/i },

  { id: 'femurL',  axis: 'y', side: 'l', match: /femur/i },
  { id: 'femurR',  axis: 'y', side: 'r', match: /femur/i },
  { id: 'patellaL', axis: 'y', side: 'l', match: /patella/i },
  { id: 'patellaR', axis: 'y', side: 'r', match: /patella/i },
  { id: 'shinL',   axis: 'y', side: 'l', match: /tibia|fibula/i },
  { id: 'shinR',   axis: 'y', side: 'r', match: /tibia|fibula/i },
  { id: 'footL',   axis: 'y', side: 'l', match: /tarsal|calcaneus|talus|navicular|cuboid|cuneiform/i },
  { id: 'footR',   axis: 'y', side: 'r', match: /tarsal|calcaneus|talus|navicular|cuboid|cuneiform/i },
];

// Soft tissue that happens to sit near a bone and must not be swept in.
const SOFT = /muscle|tendon|ligament|fascia|aponeuros|membrane|disc|meniscus|labrum|bursa|capsule|raphe|septum|retinacul|cartilage_of_(?!.*rib)|thyroid|arytenoid|cricoid|epiglottis|stapes|malleus|incus|diaphragm/i;

const browser = await chromium.launch({
  args: ['--enable-unsafe-swiftshader', '--use-gl=swiftshader', '--js-flags=--max-old-space-size=6144'],
});
const page = await browser.newPage();
page.on('pageerror', (e) => console.error('[page]', String(e).slice(0, 300)));

// Everything below resolves module and asset paths against the served origin,
// so the page has to be on it first.
await page.goto(`${ORIGIN}/mirror.html`, { waitUntil: 'load' });

const result = await page.evaluate(async ({ parts, softSrc }) => {
  const base = (p) => new URL(p, document.baseURI).href;
  const THREE = await import(base('lib/three.module.js'));
  const { FBXLoader } = await import(base('lib/jsm/loaders/FBXLoader.js'));
  const { GLTFExporter } = await import(base('lib/jsm/exporters/GLTFExporter.js'));
  const BGU = await import(base('lib/jsm/utils/BufferGeometryUtils.js'));

  const SOFT = new RegExp(softSrc, 'i');
  const root = await new Promise((res, rej) =>
    new FBXLoader().load(base('vendor/fbx/skeleton.fbx'), res, undefined, rej));
  root.updateWorldMatrix(true, true);

  const meshes = [];
  root.traverse((o) => { if (o.isMesh && o.name && !SOFT.test(o.name)) meshes.push(o); });

  /** Z-Anatomy suffixes names with side: ...l / ...r (sometimes ...ol / ...er). */
  const sideOf = (name) => (/[oe]?l$/i.test(name) ? 'l' : /[oe]?r$/i.test(name) ? 'r' : null);

  const out = [];
  const used = new Set();
  const report = [];

  for (const part of parts) {
    const re = new RegExp(part.match, 'i');
    const mine = meshes.filter((m) => !used.has(m) && re.test(m.name)
      && (!part.side || sideOf(m.name) === part.side));
    if (!mine.length) { report.push({ id: part.id, meshes: 0, verts: 0 }); continue; }
    for (const m of mine) used.add(m);

    const geoms = mine.map((m) => {
      const g = m.geometry.clone().applyMatrix4(m.matrixWorld);
      // Merging needs a consistent attribute set.
      for (const key of Object.keys(g.attributes)) {
        if (key !== 'position' && key !== 'normal') g.deleteAttribute(key);
      }
      if (!g.attributes.normal) g.computeVertexNormals();
      return g.index ? g.toNonIndexed() : g;
    });

    let merged = BGU.mergeGeometries(geoms, false);
    if (!merged) { report.push({ id: part.id, meshes: mine.length, verts: 0, error: 'merge failed' }); continue; }
    merged = BGU.mergeVertices(merged, 1e-3);
    merged.computeVertexNormals();
    merged.computeBoundingBox();

    const bb = merged.boundingBox;
    const c = bb.getCenter(new THREE.Vector3());
    // Rest-pose joints, read off the bounding box along the bone's own axis.
    let from, to;
    if (part.axis === 'x') {
      from = new THREE.Vector3(bb.min.x, c.y, c.z);
      to = new THREE.Vector3(bb.max.x, c.y, c.z);
    } else {
      from = new THREE.Vector3(c.x, bb.max.y, c.z);   // proximal = upper
      to = new THREE.Vector3(c.x, bb.min.y, c.z);
    }
    if (part.flip) { const t = from; from = to; to = t; }

    const mesh = new THREE.Mesh(merged, new THREE.MeshStandardMaterial({ color: 0xe8dcc4 }));
    mesh.name = part.id;
    mesh.userData = { from: from.toArray(), to: to.toArray() };
    out.push(mesh);
    report.push({ id: part.id, meshes: mine.length, verts: merged.attributes.position.count });
  }

  const scene = new THREE.Scene();
  for (const m of out) scene.add(m);

  const glb = await new Promise((res, rej) =>
    new GLTFExporter().parse(scene, res, rej, { binary: true, onlyVisible: false }));

  return {
    report,
    bytes: Array.from(new Uint8Array(glb)),
    skipped: meshes.length - used.size,
  };
}, { parts: PARTS.map((p) => ({ ...p, match: p.match.source })), softSrc: SOFT.source });

writeFileSync(OUT, Buffer.from(result.bytes));

let total = 0;
for (const r of result.report) {
  total += r.verts;
  const flag = r.verts === 0 ? '   <-- NOTHING MATCHED' : '';
  console.log(`${r.id.padEnd(10)} ${String(r.meshes).padStart(4)} meshes  ${String(r.verts).padStart(8)} verts${flag}`);
}
console.log(`\ntotal ${total.toLocaleString()} verts | source meshes left out: ${result.skipped}`);
console.log(`wrote art/skeleton.glb  ${(statSync(OUT).size / 1048576).toFixed(1)} MB`);

await browser.close();
