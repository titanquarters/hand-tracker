/**
 * A real anatomical skeleton, posed onto tracked bodies.
 *
 * The geometry is not generated. It is cut from the Z-Anatomy skeletal atlas
 * (CC BY-SA 4.0) by scripts/extract-skeleton.mjs, which collapses that model's
 * ~1,950 separately named structures into the twenty-odd pieces this rig
 * actually moves, and records where each piece's two joints sit in the atlas's
 * standing rest pose.
 *
 * Posing is then one idea applied to every bone: map the pair of rest-pose
 * joints onto the pair of live landmarks with a rotation, a uniform scale and
 * a translation. Uniform, because a bone that stretches along one axis stops
 * looking like a bone.
 *
 * Coordinates: MediaPipe world landmarks are metres about the hip centre with
 * +y DOWN and -z toward the camera, matching the image convention. Three.js is
 * y-up, so y is negated on the way in.
 */

import * as THREE from '../../lib/three.module.js';
import { GLTFLoader } from '../../lib/jsm/loaders/GLTFLoader.js';

export const P = {
  nose: 0, eyeL: 2, eyeR: 5, earL: 7, earR: 8,
  shoulderL: 11, shoulderR: 12, elbowL: 13, elbowR: 14, wristL: 15, wristR: 16,
  pinkyL: 17, pinkyR: 18, indexL: 19, indexR: 20,
  hipL: 23, hipR: 24, kneeL: 25, kneeR: 26, ankleL: 27, ankleR: 28,
  heelL: 29, heelR: 30, toeL: 31, toeR: 32,
};

const MODEL_URL = 'art/skeleton.glb';

/* --------------------------------------------------------------- scratch */

const _v = () => new THREE.Vector3();
const _restFrom = _v();
const _restTo = _v();
const _restDir = _v();
const _liveDir = _v();
const _q = new THREE.Quaternion();
const _off = _v();

export class Skeleton3D {
  constructor(canvas, { maxPeople = 3 } = {}) {
    this.renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true });
    this.renderer.setClearColor(0x000000, 0);

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(45, 1, 0.05, 60);
    this.camera.lookAt(0, 0, -1);
    this.addLights();

    this.maxPeople = maxPeople;
    this.rigs = [];
    this.ready = this.load();
  }

  addLights() {
    // Warm key from the front-left, so bone reads as rounded rather than flat.
    const key = new THREE.DirectionalLight(0xfff4e0, 2.3);
    key.position.set(-0.8, 1.2, 1.6);
    this.scene.add(key);

    // Cold rim from behind: what separates a skeleton from a dark room.
    const rim = new THREE.DirectionalLight(0x8effc8, 1.4);
    rim.position.set(1.0, 0.3, -1.4);
    this.scene.add(rim);

    this.scene.add(new THREE.AmbientLight(0x55637a, 1.3));
  }

  async load() {
    const url = new URL(MODEL_URL, document.baseURI).href;
    const gltf = await new Promise((res, rej) => new GLTFLoader().load(url, res, undefined, rej));

    // One material for every bone: the atlas ships per-structure materials we
    // do not want, and sharing one keeps the draw calls down.
    this.material = new THREE.MeshStandardMaterial({
      color: 0xe9ddc2,
      roughness: 0.75,
      metalness: 0.02,
      emissive: 0x12281c,
      emissiveIntensity: 0.45,
    });

    /** id -> { geometry, from, to } in the atlas's rest pose. */
    this.parts = new Map();
    gltf.scene.traverse((o) => {
      if (!o.isMesh || !o.userData?.from) return;
      this.parts.set(o.name, {
        geometry: o.geometry,
        from: new THREE.Vector3().fromArray(o.userData.from),
        to: new THREE.Vector3().fromArray(o.userData.to),
      });
    });

    // Geometry is shared between rigs; only the transforms differ.
    for (let i = 0; i < this.maxPeople; i++) {
      const root = new THREE.Group();
      root.visible = false;
      const bones = new Map();
      for (const [id, part] of this.parts) {
        const mesh = new THREE.Mesh(part.geometry, this.material);
        mesh.frustumCulled = false;
        root.add(mesh);
        bones.set(id, mesh);
      }
      this.scene.add(root);
      this.rigs.push({ root, bones });
    }

    return this.parts.size;
  }

  /**
   * Which landmarks each bone spans.
   *
   * Returned per frame because several of them are derived points -- the neck,
   * the crown, the middle of the pelvis -- rather than raw landmarks.
   */
  targets(v) {
    const mid = (a, b) => a.clone().add(b).multiplyScalar(0.5);

    const sL = v(P.shoulderL), sR = v(P.shoulderR);
    const hL = v(P.hipL), hR = v(P.hipR);
    const neck = mid(sL, sR);
    const pelvis = mid(hL, hR);
    const ear = mid(v(P.earL), v(P.earR));
    const up = ear.clone().sub(neck).normalize();

    return {
      skull: [ear.clone().addScaledVector(up, -0.07), ear.clone().addScaledVector(up, 0.11)],
      cervical: [neck, ear.clone().addScaledVector(up, -0.05)],
      ribcage: [neck, pelvis],
      pelvis: [hL, hR],
      clavicleL: [neck, sL],
      clavicleR: [neck, sR],
      scapulaL: [sL, sL.clone().lerp(pelvis, 0.42)],
      scapulaR: [sR, sR.clone().lerp(pelvis, 0.42)],
      humerusL: [sL, v(P.elbowL)],
      humerusR: [sR, v(P.elbowR)],
      forearmL: [v(P.elbowL), v(P.wristL)],
      forearmR: [v(P.elbowR), v(P.wristR)],
      handL: [v(P.wristL), v(P.indexL)],
      handR: [v(P.wristR), v(P.indexR)],
      femurL: [hL, v(P.kneeL)],
      femurR: [hR, v(P.kneeR)],
      shinL: [v(P.kneeL), v(P.ankleL)],
      shinR: [v(P.kneeR), v(P.ankleR)],
      footL: [v(P.ankleL), v(P.toeL)],
      footR: [v(P.ankleR), v(P.toeR)],
    };
  }

  /**
   * @param index which rig to drive
   * @param world 33 metric landmarks straight from PoseLandmarker
   * @param fit   { pixelsPerMetre, screenX, screenY, viewW, viewH, mirrored }
   */
  pose(index, world, fit) {
    const rig = this.rigs[index];
    if (!rig) return;

    const mirror = fit.mirrored ? -1 : 1;
    const v = (i) => new THREE.Vector3(world[i].x * mirror, -world[i].y, -world[i].z);

    const targets = this.targets(v);
    let anyPosed = false;

    for (const [id, mesh] of rig.bones) {
      const part = this.parts.get(id);
      const target = targets[id];
      if (!part || !target) { mesh.visible = false; continue; }

      _restFrom.copy(part.from);
      _restTo.copy(part.to);
      _restDir.subVectors(_restTo, _restFrom);
      _liveDir.subVectors(target[1], target[0]);

      const restLen = _restDir.length();
      const liveLen = _liveDir.length();
      if (restLen < 1e-6 || liveLen < 1e-6) { mesh.visible = false; continue; }

      const scale = liveLen / restLen;
      _q.setFromUnitVectors(_restDir.divideScalar(restLen), _liveDir.divideScalar(liveLen));

      // Rotate and scale about the rest joint, then carry it to the live one.
      _off.copy(_restFrom).multiplyScalar(scale).applyQuaternion(_q);

      mesh.visible = true;
      mesh.quaternion.copy(_q);
      mesh.scale.setScalar(scale);
      mesh.position.copy(target[0]).sub(_off);
      anyPosed = true;
    }

    if (!anyPosed) { rig.root.visible = false; return; }
    rig.root.visible = true;

    /* Place the rig so it lands on the person in the picture.
     *
     * World landmarks say what shape the body is, not where it sits on screen.
     * The torso gives the conversion -- however many pixels the shoulder-to-hip
     * span covers is what a metre is worth -- and the rig is pushed to whatever
     * distance makes that true, then slid so the hips line up. */
    const hips = v(P.hipL).add(v(P.hipR)).multiplyScalar(0.5);
    const fovRad = (this.camera.fov * Math.PI) / 180;
    const distance = (fit.viewH / 2) / (fit.pixelsPerMetre * Math.tan(fovRad / 2));

    rig.root.position.set(
      (fit.screenX - fit.viewW / 2) / fit.pixelsPerMetre - hips.x,
      (fit.viewH / 2 - fit.screenY) / fit.pixelsPerMetre - hips.y,
      -distance - hips.z,
    );
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
