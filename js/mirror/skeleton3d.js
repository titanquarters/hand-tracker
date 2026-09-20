/**
 * A real 3D skeleton, built from the pose model's metric world landmarks.
 *
 * The 2D approach pasted flat artwork onto the picture; this builds actual
 * geometry in a lit scene, so bones have volume, occlude one another, catch
 * highlights and hold up when someone turns side-on. The world landmarks carry
 * genuine depth -- about a third of a metre of z spread on a standing body --
 * which is what makes that possible.
 *
 * Coordinates: MediaPipe world landmarks are metres about the hip centre with
 * +y DOWN and -z toward the camera, matching the image convention. Three.js is
 * y-up, so y is negated on the way in.
 */

import * as THREE from '../../lib/three.module.js';

/* ---------------------------------------------------------------- topology */

export const P = {
  nose: 0, eyeL: 2, eyeR: 5, earL: 7, earR: 8, mouthL: 9, mouthR: 10,
  shoulderL: 11, shoulderR: 12, elbowL: 13, elbowR: 14, wristL: 15, wristR: 16,
  pinkyL: 17, pinkyR: 18, indexL: 19, indexR: 20, thumbL: 21, thumbR: 22,
  hipL: 23, hipR: 24, kneeL: 25, kneeR: 26, ankleL: 27, ankleR: 28,
  heelL: 29, heelR: 30, toeL: 31, toeR: 32,
};

/**
 * Long bones, as landmark pairs. `radius` is a fraction of body height, so a
 * tall guest and a short one both get correctly proportioned bones.
 */
const LONG_BONES = [
  { id: 'humerusL', a: P.shoulderL, b: P.elbowL, radius: 0.019 },
  { id: 'humerusR', a: P.shoulderR, b: P.elbowR, radius: 0.019 },
  { id: 'ulnaL',    a: P.elbowL,    b: P.wristL, radius: 0.013, twin: 0.4 },
  { id: 'ulnaR',    a: P.elbowR,    b: P.wristR, radius: 0.013, twin: 0.4 },
  { id: 'femurL',   a: P.hipL,      b: P.kneeL,  radius: 0.025 },
  { id: 'femurR',   a: P.hipR,      b: P.kneeR,  radius: 0.025 },
  { id: 'tibiaL',   a: P.kneeL,     b: P.ankleL, radius: 0.018, twin: 0.45 },
  { id: 'tibiaR',   a: P.kneeR,     b: P.ankleR, radius: 0.018, twin: 0.45 },
  { id: 'footL',    a: P.ankleL,    b: P.toeL,   radius: 0.012 },
  { id: 'footR',    a: P.ankleR,    b: P.toeR,   radius: 0.012 },
  { id: 'handL',    a: P.wristL,    b: P.indexL, radius: 0.011 },
  { id: 'handR',    a: P.wristR,    b: P.indexR, radius: 0.011 },
];

// Twelve pairs, each a fraction of the way down the thoracic spine, with the
// cage widest about two thirds down and the lowest two pairs floating short.
const RIB_COUNT = 12;

/* ---------------------------------------------------------------- geometry */

/**
 * The silhouette of a long bone, revolved: knuckled at both ends, waisted
 * through the shaft. A plain cylinder reads as a pipe; this reads as bone.
 */
function boneProfile(radius, length, segments = 14) {
  const shape = [
    [0.00, 0.72], [0.035, 0.98], [0.10, 1.00], [0.17, 0.66],
    [0.30, 0.52], [0.50, 0.48], [0.70, 0.52], [0.83, 0.66],
    [0.90, 1.00], [0.965, 0.98], [1.00, 0.72],
  ];
  const points = shape.map(([t, r]) => new THREE.Vector2(Math.max(r * radius, 1e-4), t * length));
  return new THREE.LatheGeometry(points, segments);
}

/* ------------------------------------------------------------------- scene */

const BONE_COLOR = 0xe6d9bd;
const BONE_DARK = 0x6b5c42;

function boneMaterial() {
  return new THREE.MeshStandardMaterial({
    color: BONE_COLOR,
    roughness: 0.72,
    metalness: 0.03,
    emissive: 0x16301f,
    emissiveIntensity: 0.55,
  });
}

/** Reusable scratch objects, so the render loop allocates nothing. */
const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _mid = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0);
const _zAxis = new THREE.Vector3(0, 0, 1);
const _q = new THREE.Quaternion();

export class Skeleton3D {
  /**
   * @param canvas   the canvas to render into, overlaid on the video
   * @param options  { maxPeople }
   */
  constructor(canvas, { maxPeople = 3 } = {}) {
    this.renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true });
    this.renderer.setClearColor(0x000000, 0);

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(45, 1, 0.05, 60);
    this.camera.position.set(0, 0, 0);
    this.camera.lookAt(0, 0, -1);

    this.addLights();

    this.rigs = [];
    for (let i = 0; i < maxPeople; i++) this.rigs.push(this.buildRig());
  }

  addLights() {
    // Key light from the front-left, so bones read as rounded rather than flat.
    const key = new THREE.DirectionalLight(0xfff3dd, 2.1);
    key.position.set(-0.7, 1.1, 1.4);
    this.scene.add(key);

    // Cold rim from behind, which is what separates a skeleton from a dark room.
    const rim = new THREE.DirectionalLight(0x8effc8, 1.5);
    rim.position.set(0.9, 0.4, -1.5);
    this.scene.add(rim);

    this.scene.add(new THREE.AmbientLight(0x4a5a6a, 1.1));
  }

  /** One person's worth of meshes, built once and re-posed every frame. */
  buildRig() {
    const root = new THREE.Group();
    root.visible = false;
    this.scene.add(root);

    const mat = boneMaterial();
    const darkMat = new THREE.MeshStandardMaterial({ color: BONE_DARK, roughness: 0.9 });

    const bones = {};
    for (const def of LONG_BONES) {
      const make = () => {
        const m = new THREE.Mesh(boneProfile(1, 1), mat);
        root.add(m);
        return m;
      };
      // Forearm and shin are two bones side by side.
      bones[def.id] = def.twin ? [make(), make()] : [make()];
    }

    // Skull: a slightly squashed sphere with a jaw, and sunken sockets.
    const skull = new THREE.Group();
    const cranium = new THREE.Mesh(new THREE.SphereGeometry(1, 24, 18), mat);
    cranium.scale.set(1, 1.12, 1.16);
    skull.add(cranium);
    const jaw = new THREE.Mesh(new THREE.SphereGeometry(1, 18, 12), mat);
    jaw.scale.set(0.76, 0.40, 0.86);
    jaw.position.set(0, -0.88, 0.18);
    skull.add(jaw);

    // A brow ridge is most of what makes a sphere read as a skull.
    const brow = new THREE.Mesh(new THREE.SphereGeometry(1, 20, 10, 0, Math.PI * 2, 0, Math.PI / 2), mat);
    brow.scale.set(0.92, 0.30, 0.96);
    brow.position.set(0, 0.26, 0.04);
    skull.add(brow);

    for (const side of [-1, 1]) {
      const socket = new THREE.Mesh(new THREE.SphereGeometry(1, 16, 14), darkMat);
      socket.scale.set(0.29, 0.30, 0.26);
      socket.position.set(side * 0.38, 0.02, 0.86);
      skull.add(socket);
    }

    const nasal = new THREE.Mesh(new THREE.ConeGeometry(1, 1, 10), darkMat);
    nasal.scale.set(0.15, 0.30, 0.14);
    nasal.position.set(0, -0.34, 0.92);
    nasal.rotation.x = Math.PI;      // apex upward, like the real aperture
    skull.add(nasal);

    const teeth = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), mat);
    teeth.scale.set(0.60, 0.13, 0.30);
    teeth.position.set(0, -0.66, 0.66);
    skull.add(teeth);
    root.add(skull);

    // Spine: a stack of vertebrae posed along the shoulder-to-hip line.
    const spine = [];
    for (let i = 0; i < 9; i++) {
      const v = new THREE.Mesh(new THREE.CylinderGeometry(1, 1, 1, 12), mat);
      root.add(v);
      spine.push(v);
    }

    // Ribcage: one open torus per pair, scaled and swept down the spine.
    const ribs = [];
    for (let i = 0; i < RIB_COUNT; i++) {
      const rib = new THREE.Mesh(new THREE.TorusGeometry(1, 0.055, 8, 28, Math.PI * 1.35), mat);
      root.add(rib);
      ribs.push(rib);
    }

    const sternum = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), mat);
    root.add(sternum);

    // Pelvis: two blades plus a sacrum.
    // Scaled as a fraction of hip width below, so these numbers are the
    // pelvis's proportions rather than its size.
    const pelvis = new THREE.Group();
    for (const side of [-1, 1]) {
      const blade = new THREE.Mesh(new THREE.SphereGeometry(1, 18, 14), mat);
      blade.scale.set(0.27, 0.23, 0.10);   // a flat iliac blade, not a ball
      blade.position.set(side * 0.25, 0.08, 0);
      blade.rotation.z = side * -0.30;
      pelvis.add(blade);
      // Ischium: the bit you actually sit on, below and behind the blade.
      const ischium = new THREE.Mesh(new THREE.SphereGeometry(1, 12, 10), mat);
      ischium.scale.set(0.11, 0.15, 0.09);
      ischium.position.set(side * 0.20, -0.20, 0.02);
      pelvis.add(ischium);
    }
    const sacrum = new THREE.Mesh(new THREE.SphereGeometry(1, 14, 10), mat);
    sacrum.scale.set(0.11, 0.20, 0.09);
    sacrum.position.set(0, 0.00, -0.06);
    pelvis.add(sacrum);
    root.add(pelvis);

    const clavicles = [new THREE.Mesh(boneProfile(1, 1), mat), new THREE.Mesh(boneProfile(1, 1), mat)];
    for (const c of clavicles) root.add(c);

    return { root, bones, skull, cranium, spine, ribs, sternum, pelvis, clavicles };
  }

  /* ------------------------------------------------------------- posing */

  /** Point a mesh built along +y from `a` to `b`, sized to fit between them. */
  poseAlong(mesh, a, b, radius, lengthScale = 1) {
    _a.copy(a); _b.copy(b);
    _dir.subVectors(_b, _a);
    const len = _dir.length();
    if (len < 1e-5) { mesh.visible = false; return len; }
    mesh.visible = true;

    _q.setFromUnitVectors(_up, _dir.clone().normalize());
    mesh.position.copy(_a);
    mesh.quaternion.copy(_q);
    mesh.scale.set(radius, len * lengthScale, radius);
    return len;
  }

  /**
   * Update one person.
   *
   * @param index   which rig to use
   * @param world   33 metric landmarks
   * @param fit     { pixelsPerMetre, screenX, screenY, viewW, viewH } placing
   *                the rig so it lands on the person in the picture
   */
  pose(index, world, fit) {
    const rig = this.rigs[index];
    if (!rig) return;
    rig.root.visible = true;

    // Into Three's y-up space, mirroring x when the preview is mirrored.
    const mirror = fit.mirrored ? -1 : 1;
    const v = (i) => new THREE.Vector3(world[i].x * mirror, -world[i].y, -world[i].z);

    const mid = (p, q) => p.clone().add(q).multiplyScalar(0.5);

    const shoulderL = v(P.shoulderL), shoulderR = v(P.shoulderR);
    const hipL = v(P.hipL), hipR = v(P.hipR);
    const neck = mid(shoulderL, shoulderR);
    const pelvisMid = mid(hipL, hipR);

    // Body height drives every bone radius, so proportions hold at any size.
    let top = -Infinity, bottom = Infinity;
    for (let i = 0; i < world.length; i++) {
      const y = -world[i].y;
      if (y > top) top = y;
      if (y < bottom) bottom = y;
    }
    const height = Math.max(top - bottom, 0.4);

    for (const def of LONG_BONES) {
      const a = v(def.a), b = v(def.b);
      const r = height * def.radius;
      const meshes = rig.bones[def.id];
      if (def.twin) {
        // Offset the pair sideways from the bone axis.
        const axis = b.clone().sub(a).normalize();
        const side = new THREE.Vector3().crossVectors(axis, new THREE.Vector3(0, 0, 1)).normalize()
          .multiplyScalar(r * 0.85);
        this.poseAlong(meshes[0], a.clone().add(side), b.clone().add(side), r);
        this.poseAlong(meshes[1], a.clone().sub(side), b.clone().sub(side), r * def.twin / 0.4 * 0.8);
      } else {
        this.poseAlong(meshes[0], a, b, r);
      }
    }

    // Skull: sit it above the neck, sized off the ear span and facing the nose.
    const ear = mid(v(P.earL), v(P.earR));
    const headR = Math.max(v(P.earL).distanceTo(v(P.earR)) * 0.62, height * 0.035);
    rig.skull.position.copy(ear).addScaledVector(new THREE.Vector3(0, 1, 0), headR * 0.18);
    rig.skull.scale.setScalar(headR);
    const nose = v(P.nose);
    rig.skull.lookAt(nose.clone().add(nose.clone().sub(ear).multiplyScalar(4)));

    // Spine.
    for (let i = 0; i < rig.spine.length; i++) {
      const t0 = i / rig.spine.length;
      const t1 = (i + 0.72) / rig.spine.length;
      const a = neck.clone().lerp(pelvisMid, t0);
      const b = neck.clone().lerp(pelvisMid, t1);
      this.poseAlong(rig.spine[i], a, b, height * 0.021);
    }

    // Ribcage. Each pair is a ring about the spine, widest two thirds down,
    // tilted forward and shrinking at the floating ribs.
    const torso = neck.distanceTo(pelvisMid);
    const shoulderW = shoulderL.distanceTo(shoulderR);
    const axis = pelvisMid.clone().sub(neck).normalize();
    const across = shoulderR.clone().sub(shoulderL).normalize();
    const fwd = new THREE.Vector3().crossVectors(axis, across).normalize();

    for (let i = 0; i < RIB_COUNT; i++) {
      const t = i / (RIB_COUNT - 1);
      const rib = rig.ribs[i];
      const centre = neck.clone().addScaledVector(axis, torso * (0.12 + t * 0.52));

      const floating = i >= RIB_COUNT - 2;
      const profile = 0.42 + Math.sin(Math.min(1, 0.18 + t * 0.9) * Math.PI) * 0.58;
      const r = shoulderW * 0.5 * profile * (floating ? 0.78 : 1);

      // A torus lies in its own XY plane with its axis along +z, so pointing
      // that axis down the spine is what makes the ring wrap the body. Building
      // a basis and then rotating instead left the rings edge-on to the camera,
      // and the whole cage collapsed into a vertical ladder.
      rib.position.copy(centre).addScaledVector(fwd, r * 0.12);
      // Wider than deep, like a real chest.
      rib.scale.set(r, r * 0.72, r);
      rib.quaternion.setFromUnitVectors(_zAxis, axis);
      // Tip each pair forward and down, steeper toward the floating ribs.
      rib.rotateOnWorldAxis(across, -0.22 - t * 0.30);
      // Swing the arc's gap round to the back, where the spine is.
      rib.rotateZ(Math.PI * 0.82);
      rib.visible = true;
    }

    const sternumTop = neck.clone().addScaledVector(axis, torso * 0.14).addScaledVector(fwd, shoulderW * 0.22);
    const sternumBot = neck.clone().addScaledVector(axis, torso * 0.48).addScaledVector(fwd, shoulderW * 0.20);
    this.poseAlong(rig.sternum, sternumTop, sternumBot, shoulderW * 0.11);

    // Pelvis.
    rig.pelvis.position.copy(pelvisMid);
    rig.pelvis.scale.setScalar(hipL.distanceTo(hipR) * 1.05);
    const pm = new THREE.Matrix4().makeBasis(across, axis.clone().negate(), fwd);
    rig.pelvis.quaternion.setFromRotationMatrix(pm);

    this.poseAlong(rig.clavicles[0], neck, shoulderL, height * 0.011);
    this.poseAlong(rig.clavicles[1], neck, shoulderR, height * 0.011);

    /* Place the rig so it lands on the person in the picture.
     *
     * The world landmarks say what shape the body is but not where it is on
     * screen, so the rig is fitted: the distance is chosen to make one metre
     * cover the right number of pixels, then it is slid sideways and up so the
     * hip centre projects exactly onto the hips in the video. */
    const fovRad = (this.camera.fov * Math.PI) / 180;
    const distance = (fit.viewH / 2) / (fit.pixelsPerMetre * Math.tan(fovRad / 2));
    const worldX = (fit.screenX - fit.viewW / 2) / fit.pixelsPerMetre;
    const worldY = (fit.viewH / 2 - fit.screenY) / fit.pixelsPerMetre;

    rig.root.position.set(worldX - pelvisMid.x, worldY - pelvisMid.y, -distance - pelvisMid.z);
  }

  hideFrom(count) {
    for (let i = count; i < this.rigs.length; i++) this.rigs[i].root.visible = false;
  }

  resize(viewW, viewH, dpr) {
    this.renderer.setPixelRatio(dpr);
    this.renderer.setSize(viewW, viewH, false);
    this.camera.aspect = viewW / viewH;
    this.camera.updateProjectionMatrix();
  }

  render() {
    this.renderer.render(this.scene, this.camera);
  }
}
