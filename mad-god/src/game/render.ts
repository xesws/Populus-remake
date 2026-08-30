import * as THREE from "three";
import type { SimClient } from "./client/sim-client";
import { BLUE, clamp, FIRE_DOWN_TIME, FxBolt, houseMaxPop, isCampKind, SAMPLES, STEP, Team, TRAIN_TIME, WATER, WORLD } from "./types";
import { World } from "./world";
import { TornadoFX } from "./render-parts/tornado-fx";
import { LavaFX } from "./render-parts/lava-fx";
import { SculptIndicatorFX } from "./render-parts/sculpt-indicator-fx";
import { GuardFireFX } from "./render-parts/guard-fire-fx";
import { ConvertRangeFX } from "./render-parts/convert-range-fx";
import { TerrainMesh } from "./render-parts/terrain-mesh";

const RT_W = 800;
const RT_H = 600;

// v0.25c 相机轨道参数（input.ts 与 camera-check.ts 共用，避免两处硬编码漂移）。
// 相机高度 = dist * sin(pitch)：调高视角 = 放宽这两个上限。
/** 纯函数：缩放后的 dist（夹在 [CAM_DIST_MIN, CAM_DIST_MAX]），headless 检查可直接测。 */
export function zoomDist(cur: number, delta: number): number {
  return Math.max(CAM_DIST_MIN, Math.min(CAM_DIST_MAX, cur + delta));
}

export const CAM_PITCH_MIN = 0.28; // 中键/键盘俯仰的下限（防止钻到地平线以下）
export const CAM_PITCH_MAX = 1.32; // 原 1.2（内联在 input.ts），放宽约 7° → 接近正俯视
export const CAM_DIST_MIN = 8; // 滚轮最近（不变）
export const CAM_DIST_MAX = 60; // 原 42，滚轮可拉高约 1.4 倍

export class View {
  renderer: THREE.WebGLRenderer;
  scene = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(42, RT_W / RT_H, 0.1, 200);
  rt: THREE.WebGLRenderTarget;
  screenScene = new THREE.Scene();
  screenCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  world: World;

  terrain: THREE.Mesh;
  /** v0.25b 地形顶点（色/法线）增量的唯一维护者。 */
  tmesh: TerrainMesh;
  water: THREE.Mesh;

  unitGroup = new THREE.Group();
  houseGroup = new THREE.Group();
  trainBarGroup = new THREE.Group();
  prodBarGroup = new THREE.Group();
  roofIconGroup = new THREE.Group();
  dwellPipGroup = new THREE.Group();
  treeGroup = new THREE.Group();
  fxGroup = new THREE.Group();
  swampGroup = new THREE.Group();
  lavaStreamGroup = new THREE.Group();
  lavaStreamSig = -1;
  swampSig = -1;
  ankhGroup = new THREE.Group();
  shotGroup = new THREE.Group();
  selectRing: THREE.Mesh;
  selectRings: THREE.Mesh[] = [];
  selectRingGeo: THREE.RingGeometry;
  selectRingMat: THREE.MeshBasicMaterial;
  cursor: THREE.Mesh;
  fightRing: THREE.Mesh;
  fist: THREE.Group;
  moveMark: THREE.Group;
  moveMarkLife = 0;
  moveMarkMats: THREE.Material[] = [];
  preview: THREE.Group | null = null;
  previewKind = "";
  previewLegal = true;

  look = new THREE.Vector3(26, 0, 26);
  yaw = 0.72;
  pitch = 0.72;
  dist = 30; // v0.24 大地图拉远视角
  shake = 0;
  t = 0;
  quakeT = 0;
  quakeX = 0;
  quakeZ = 0;
  volcanoT = 0;
  volcanoX = 0;
  volcanoZ = 0;
  debrisGroup = new THREE.Group();
  sprayGroup = new THREE.Group();
  // v0.18 龙卷风/岩浆/雕刻指示器改用独立 fx 模块（旧 tornadoGroup 实体方块已废弃）。
  tornadoFX = new TornadoFX();
  lavaFX = new LavaFX();
  sculptIndicator = new SculptIndicatorFX();
  /** v0.26 转化技能范围圈（选中 convert 工具时在鼠标处显示，超距变红灰）。 */
  convertRange = new ConvertRangeFX();
  guardFireFX = new GuardFireFX();
  blastGroup = new THREE.Group();
  /** v0.27f 天降火球：坠落的发光陨石（核心 + 光晕 + 尾焰），撞击冲击波复用 blast 环。 */
  meteorGroup = new THREE.Group();
  meteorCoreMat = new THREE.MeshBasicMaterial({ color: 0xffd27a });
  meteorGlowMat = new THREE.MeshBasicMaterial({ color: 0xff7a18, transparent: true, opacity: 0.42 });
  blastRingMat = new THREE.MeshBasicMaterial({ color: 0xf4f0dc, transparent: true, opacity: 0.85, side: THREE.DoubleSide });
  blastDustMat = new THREE.MeshLambertMaterial({ color: 0xddd6c4 });
  lavaDebMat = new THREE.MeshLambertMaterial({ color: 0xff7a18, emissive: 0xff4400 });
  debris: {
    mesh: THREE.Mesh;
    vx: number;
    vy: number;
    vz: number;
    life: number;
    spinX: number;
    spinZ: number;
  }[] = [];
  boltLineMat = new THREE.LineBasicMaterial({ color: 0xf4f0c0 });
  boltBoxMat = new THREE.MeshBasicMaterial({ color: 0xfff6c8 });
  dirtMat = new THREE.MeshLambertMaterial({ color: 0x7a5530 });
  sprayMat = new THREE.MeshBasicMaterial({ color: 0xff6a1a, transparent: true, opacity: 0.7 });
  sprayChunkMat = new THREE.MeshBasicMaterial({ color: 0xffaa44 });

  unitMeshes = new Map<number, THREE.Group>();
  houseMeshes = new Map<number, THREE.Group>();
  trainBars = new Map<number, THREE.Group>();
  prodBars = new Map<number, THREE.Group>();
  roofIcons = new Map<number, THREE.Group>();
  dwellPips = new Map<number, THREE.Group>();
  treeMeshes = new Map<number, THREE.Group>();
  trainBarTrackMat = new THREE.MeshLambertMaterial({ color: 0x16161c });
  trainBarFillMat = new THREE.MeshLambertMaterial({ color: this.teamPrimary(BLUE) });
  trainBarMarkMat = new THREE.MeshBasicMaterial({ color: 0x5aa0ee });
  prodBarTrackMat = new THREE.MeshLambertMaterial({ color: 0x16161c });
  prodBarFillMat = new THREE.MeshLambertMaterial({ color: 0x3f9d4f });

  constructor(canvas: HTMLCanvasElement, world: World) {
    this.world = world;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: false, alpha: false });
    this.renderer.setPixelRatio(1);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.setClearColor(0x6aa4c8, 1);
    this.renderer.shadowMap.enabled = false;

    this.rt = new THREE.WebGLRenderTarget(RT_W, RT_H, {
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
      depthBuffer: true,
    });
    this.rt.texture.generateMipmaps = false;

    const quad = new THREE.Mesh(
      new THREE.PlaneGeometry(2, 2),
      new THREE.MeshBasicMaterial({ map: this.rt.texture }),
    );
    this.screenScene.add(quad);

    this.scene.background = new THREE.Color("#87b4d6");
    this.scene.fog = new THREE.Fog("#87b4d6", 38, 78);

    const hemi = new THREE.HemisphereLight(0xcfe8ff, 0x3a2a18, 0.95);
    this.scene.add(hemi);
    const sun = new THREE.DirectionalLight(0xfff2d0, 0.85);
    sun.position.set(20, 40, 10);
    this.scene.add(sun);
    this.scene.add(new THREE.AmbientLight(0x506070, 0.25));

    this.tmesh = new TerrainMesh(world);
    this.terrain = new THREE.Mesh(
      this.tmesh.geo,
      new THREE.MeshLambertMaterial({ vertexColors: true }),
    );
    this.terrain.frustumCulled = false;
    this.scene.add(this.terrain);

    const waterGeo = new THREE.PlaneGeometry(WORLD + 8, WORLD + 8, 1, 1);
    waterGeo.rotateX(-Math.PI / 2);
    this.water = new THREE.Mesh(
      waterGeo,
      new THREE.MeshLambertMaterial({ color: 0x1e5a88, transparent: true, opacity: 0.92 }),
    );
    this.water.position.set(WORLD / 2, WATER, WORLD / 2);
    this.scene.add(this.water);

    this.scene.add(
      this.unitGroup,
      this.houseGroup,
      this.trainBarGroup,
      this.prodBarGroup,
      this.roofIconGroup,
      this.dwellPipGroup,
      this.treeGroup,
      this.fxGroup,
      this.swampGroup,
      this.lavaStreamGroup,
      this.ankhGroup,
      this.shotGroup,
      this.debrisGroup,
      this.sprayGroup,
      this.tornadoFX.group,
      this.lavaFX.group,
      this.sculptIndicator.group,
      this.convertRange.group,
      this.guardFireFX.group,
      this.blastGroup,
      this.meteorGroup,
    );

    this.selectRingGeo = new THREE.RingGeometry(0.34, 0.44, 12);
    this.selectRingMat = new THREE.MeshBasicMaterial({ color: 0xfff2a0, side: THREE.DoubleSide });
    this.selectRing = new THREE.Mesh(this.selectRingGeo, this.selectRingMat);
    this.selectRing.rotation.x = -Math.PI / 2;
    this.selectRing.visible = false;
    this.scene.add(this.selectRing);

    this.cursor = new THREE.Mesh(
      new THREE.RingGeometry(0.32, 0.5, 24),
      new THREE.MeshBasicMaterial({ color: 0xf2e08a, transparent: true, opacity: 0.7, side: THREE.DoubleSide }),
    );
    this.cursor.rotation.x = -Math.PI / 2;
    this.scene.add(this.cursor);

    this.fightRing = new THREE.Mesh(
      new THREE.RingGeometry(0.28, 0.46, 16),
      new THREE.MeshBasicMaterial({ color: 0x8a1c14, transparent: true, opacity: 0.85, side: THREE.DoubleSide }),
    );
    this.fightRing.rotation.x = -Math.PI / 2;
    this.fightRing.visible = false;
    this.scene.add(this.fightRing);

    this.fist = this.makeFist();
    this.fist.visible = false;
    this.scene.add(this.fist);

    this.moveMark = this.makeMoveMark();
    this.scene.add(this.moveMark);

    this.rebuildTerrain();
    this.syncCamera();
    this.resize();
    window.addEventListener("resize", () => this.resize());
  }

  resize(): void {
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.renderer.setSize(w, h, true);
  }

  syncCamera(): void {
    const shakeX = (Math.random() - 0.5) * this.shake;
    const shakeZ = (Math.random() - 0.5) * this.shake;
    const x = this.look.x + Math.cos(this.pitch) * Math.sin(this.yaw) * this.dist;
    const y = this.look.y + Math.sin(this.pitch) * this.dist;
    const z = this.look.z + Math.cos(this.pitch) * Math.cos(this.yaw) * this.dist;
    this.camera.position.set(x + shakeX, y, z + shakeZ);
    this.camera.lookAt(this.look);
  }

  /** 整图重建地形顶点（开局 / 换 seed / 导演切场景时调）。 */
  rebuildTerrain(): void {
    this.tmesh.rebuild();
  }

  /**
   * v0.25b 每帧消费 World 的脏区窗口（见 TerrainMesh 的说明）：旧实现每帧无条件
   * 全量重算 8.3 万顶点法线（实测 15.6ms/帧），是火山期间页面假死的主因之一。
   */
  syncTerrain(): void {
    this.tmesh.syncWindow(this.world.takeDirtyWindow());
  }

  makeFist(): THREE.Group {
    const g = new THREE.Group();
    const red = new THREE.MeshLambertMaterial({ color: 0x8a1c14 });
    const dark = new THREE.MeshLambertMaterial({ color: 0x3a1210 });
    this.box(g, 0.10, 0.22, 0.10, dark, 0, 0.16, -0.03);
    this.box(g, 0.22, 0.16, 0.16, red, 0, 0.36, 0.03);
    this.box(g, 0.20, 0.08, 0.08, dark, 0, 0.46, 0.09);
    this.box(g, 0.06, 0.10, 0.06, red, -0.14, 0.38, 0.02);
    g.rotation.y = 0.35;
    g.scale.setScalar(2.6);
    return g;
  }

  makeMoveMark(): THREE.Group {
    const g = new THREE.Group();
    const gold = new THREE.MeshBasicMaterial({ color: 0xc9a227, transparent: true, opacity: 0.95, side: THREE.DoubleSide });
    const team = new THREE.MeshBasicMaterial({ color: 0x1f4e8a, transparent: true, opacity: 0.95 });
    this.moveMarkMats = [gold, team];
    const ring = new THREE.Mesh(new THREE.RingGeometry(0.26, 0.42, 16), gold);
    ring.rotation.x = -Math.PI / 2;
    g.add(ring);
    const pole = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.52, 0.05), gold);
    pole.position.y = 0.26;
    g.add(pole);
    const flag = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.12, 0.03), team);
    flag.position.set(0.13, 0.46, 0);
    g.add(flag);
    g.visible = false;
    return g;
  }

  setMoveMarkOpacity(a: number): void {
    for (const m of this.moveMarkMats) {
      if ("opacity" in m) (m as THREE.MeshBasicMaterial).opacity = a;
    }
  }

  showMoveMark(x: number, z: number): void {
    this.moveMarkLife = 1.4;
    this.moveMark.visible = true;
    const y = this.world.heightAt(x, z);
    this.moveMark.position.set(x, y + 0.02, z);
    this.setMoveMarkOpacity(1);
  }

  tickMoveMark(dt: number): void {
    if (this.moveMarkLife <= 0) {
      this.moveMark.visible = false;
      return;
    }
    this.moveMarkLife = Math.max(0, this.moveMarkLife - dt);
    if (this.moveMarkLife <= 0) {
      this.moveMark.visible = false;
      return;
    }
    const fade = this.moveMarkLife < 0.35 ? this.moveMarkLife / 0.35 : 1;
    this.setMoveMarkOpacity(fade);
    const p = this.moveMark.position;
    p.y = this.world.heightAt(p.x, p.z) + 0.02;
  }

  hover(x: number, z: number, valid: boolean, mode: "move" | "fight" | "off" = valid ? "move" : "off"): void {
    const m = !valid ? "off" : mode;
    if (m === "off") {
      this.cursor.visible = false;
      this.fightRing.visible = false;
      this.fist.visible = false;
      return;
    }
    const y = this.world.heightAt(x, z);
    const n = this.world.normalAt(x, z);
    const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), new THREE.Vector3(n.x, n.y, n.z));
    if (m === "fight") {
      this.cursor.visible = false;
      this.fightRing.visible = true;
      this.fightRing.position.set(x, y + 0.04, z);
      this.fightRing.quaternion.copy(q);
      this.fist.visible = true;
      this.fist.position.set(x, y + 0.85, z);
      return;
    }
    this.fightRing.visible = false;
    this.fist.visible = false;
    this.cursor.visible = true;
    this.cursor.position.set(x, y + 0.04, z);
    this.cursor.quaternion.copy(q);
  }

  worldToCanvas(x: number, y: number, z: number, canvas: HTMLCanvasElement): { x: number; y: number } {
    const v = new THREE.Vector3(x, y, z).project(this.camera);
    const r = canvas.getBoundingClientRect();
    return {
      x: (v.x * 0.5 + 0.5) * r.width + r.left,
      y: (-v.y * 0.5 + 0.5) * r.height + r.top,
    };
  }

  makeSelectRing(): THREE.Mesh {
    const m = new THREE.Mesh(this.selectRingGeo, this.selectRingMat);
    m.rotation.x = -Math.PI / 2;
    m.visible = false;
    this.scene.add(m);
    return m;
  }

  tintPreview(g: THREE.Group, legal: boolean): void {
    g.traverse((obj) => {
      if (!(obj instanceof THREE.Mesh)) return;
      const src = obj.material;
      const list = Array.isArray(src) ? src : [src];
      const next = list.map((m) => {
        const mat = (m as THREE.MeshLambertMaterial).clone();
        mat.transparent = true;
        mat.opacity = 0.45;
        mat.depthWrite = false;
        if (!legal && "color" in mat) mat.color.setHex(0xc62828);
        return mat;
      });
      obj.material = Array.isArray(src) ? next : next[0]!;
    });
  }

  showGhost(kind: string, team: Team, x: number, z: number, yaw: number, legal: boolean): void {
    this.setPreview(kind, team, x, z, yaw, legal);
  }

  hideGhost(): void {
    this.clearPreview();
  }

  setPreview(kind: string, team: Team, x: number, z: number, yaw: number, legal: boolean): void {
    if (!this.preview || this.previewKind !== kind || this.previewLegal !== legal) {
      this.clearPreview();
      const g = this.makeHouse(team, 1, kind, 0);
      this.tintPreview(g, legal);
      this.preview = g;
      this.previewKind = kind;
      this.previewLegal = legal;
      this.scene.add(g);
    }
    this.preview.position.set(x, this.world.heightAt(x, z), z);
    this.preview.rotation.y = yaw;
    this.preview.visible = true;
  }

  clearPreview(): void {
    if (!this.preview) return;
    this.scene.remove(this.preview);
    this.preview.traverse((obj) => {
      if (!(obj instanceof THREE.Mesh)) return;
      const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
      for (const m of mats) m.dispose();
    });
    this.preview = null;
    this.previewKind = "";
  }

  syncSelect(sim: SimClient): void {
    const selected = sim.units.filter((u) => u.selected && u.team === 0 && u.homeId === 0);
    while (this.selectRings.length < selected.length) this.selectRings.push(this.makeSelectRing());
    this.selectRing.visible = false;
    for (let i = 0; i < this.selectRings.length; i++) {
      const ring = this.selectRings[i]!;
      const u = selected[i];
      if (!u) {
        ring.visible = false;
        continue;
      }
      ring.visible = true;
      ring.position.set(u.x, u.y + 0.05, u.z);
    }
  }

  pickCell(ndcX: number, ndcY: number): { x: number; z: number } | null {
    const ray = new THREE.Raycaster();
    ray.setFromCamera(new THREE.Vector2(ndcX, ndcY), this.camera);
    const hits = ray.intersectObject(this.terrain);
    if (hits.length && hits[0]) {
      return { x: hits[0].point.x, z: hits[0].point.z };
    }
    const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
    const hit = new THREE.Vector3();
    if (ray.ray.intersectPlane(plane, hit)) return { x: hit.x, z: hit.z };
    return null;
  }

  /** v0.25c 滚轮缩放（正 = 拉远/调高）：滚轮 handler 与测试都走这里。 */
  zoomBy(delta: number): void {
    this.dist = zoomDist(this.dist, delta);
  }

  pan(dx: number, dz: number, dt = 1 / 60): void {
    const s = this.dist * 0.85 * dt;
    const cos = Math.cos(this.yaw);
    const sin = Math.sin(this.yaw);
    this.look.x += dx * cos * s + dz * sin * s;
    this.look.z += -dx * sin * s + dz * cos * s;
    this.look.x = THREE.MathUtils.clamp(this.look.x, 4, WORLD - 4);
    this.look.z = THREE.MathUtils.clamp(this.look.z, 4, WORLD - 4);
  }

  jump(x: number, z: number): void {
    this.look.set(x, this.world.heightAt(x, z), z);
  }

  sync(sim: SimClient, bolts: FxBolt[], dt: number, freezeFx = false): void {
    this.t += dt;
    this.shake = Math.max(0, this.shake - dt * 1.8);
    if (sim.fxQuake) {
      this.triggerQuake(sim.fxQuake.x, sim.fxQuake.z);
      sim.fxQuake = null;
    }
    if (sim.fxVolcano) {
      this.triggerVolcano(sim.fxVolcano.x, sim.fxVolcano.z);
      sim.fxVolcano = null;
    }
    this.quakeT = Math.max(0, this.quakeT - dt);
    this.volcanoT = Math.max(0, this.volcanoT - dt);
    this.syncTerrain();
    this.water.position.y = WATER + Math.sin(this.t * 1.4) * 0.03;
    this.syncUnits(sim);
    this.syncHouses(sim);
    this.syncTrainBars(sim);
    this.syncProdBars(sim);
    this.syncRoofIcons(sim);
    this.syncDwellPips(sim);
    this.syncTrees(sim);
    this.syncSwamp(sim);
    this.syncLavaStreams(sim);
    this.syncTornado(sim, dt);
    this.lavaFX.sync(sim, dt); // v0.18 岩浆物理粒子（火山喷发 + 顺坡流动）
    this.guardFireFX.sync(sim, dt); // v0.19 守卫篝火
    this.syncBlast(sim);
    this.syncMeteors(sim); // v0.27f 天降火球
    this.syncAnkhs(sim);
    this.syncShots(sim);
    this.syncBolts(bolts);
    if (sim.fxSplash.length) {
      for (const s of sim.fxSplash) {
        const y = this.world.heightAt(s.x, s.z) + 1.25;
        this.addLavaSplash(s.x, y, s.z);
      }
      sim.fxSplash = [];
    }
    if (!freezeFx) this.tickDebris(dt);
    this.syncVolcanoSpray();
    this.syncSelect(sim);
    if (!freezeFx) this.tickMoveMark(dt);
    this.syncCamera();
  }

  teamPrimary(team: Team): number {
    return team === 0 ? 0x1f4e8a : 0x8a1c14;
  }

  box(g: THREE.Group, w: number, h: number, d: number, mat: THREE.Material, x: number, y: number, z: number): THREE.Mesh {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
    m.position.set(x, y, z);
    g.add(m);
    return m;
  }

  makeUnit(team: Team, kind: string, disguise: Team | null): THREE.Group {
    const g = new THREE.Group();
    const skin = new THREE.MeshLambertMaterial({ color: 0xf0d2a8 });
    const gold = new THREE.MeshLambertMaterial({ color: 0xc9a227 });
    const metal = new THREE.MeshLambertMaterial({ color: 0xc8c8d0 });
    const silver = new THREE.MeshLambertMaterial({ color: 0xb0b4b8 });
    const primary = this.teamPrimary(team);
    const teamMat = new THREE.MeshLambertMaterial({ color: primary });
    const cloakCol = disguise !== null ? this.teamPrimary(disguise) : 0x1a1a1e;

    if (kind === "firewarrior") {
      this.box(g, 0.20, 0.26, 0.16, silver, 0, 0.17, 0);
      this.box(g, 0.21, 0.05, 0.17, teamMat, 0, 0.17, 0);
      this.box(g, 0.15, 0.15, 0.15, skin, 0, 0.38, 0);
      this.box(g, 0.19, 0.09, 0.19, silver, 0, 0.48, 0);
      const hornMat = new THREE.MeshLambertMaterial({ color: 0xe8d4a0 });
      const hornL = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.14, 0.05), hornMat);
      hornL.position.set(-0.10, 0.58, 0);
      hornL.rotation.z = 0.55;
      const hornR = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.14, 0.05), hornMat);
      hornR.position.set(0.10, 0.58, 0);
      hornR.rotation.z = -0.55;
      g.add(hornL, hornR);
      const fire = new THREE.MeshLambertMaterial({ color: 0xffaa44, emissive: 0xaa3300 });
      this.box(g, 0.10, 0.10, 0.10, fire, -0.16, 0.28, 0.08);
      this.box(g, 0.10, 0.10, 0.10, fire, 0.16, 0.28, 0.08);
      return g;
    }

    if (kind === "preacher") {
      const clothes = new THREE.MeshLambertMaterial({ color: team === 0 ? 0xf2ead0 : 0xf0dcc4 });
      this.box(g, 0.26, 0.50, 0.24, clothes, 0, 0.26, 0);
      this.box(g, 0.28, 0.06, 0.26, gold, 0, 0.40, 0);
      this.box(g, 0.16, 0.16, 0.16, skin, 0, 0.58, 0);
      this.box(g, 0.24, 0.10, 0.24, clothes, 0, 0.70, 0);
      this.box(g, 0.16, 0.18, 0.16, clothes, 0, 0.84, 0);
      this.box(g, 0.12, 0.16, 0.12, gold, 0, 1.00, 0);
      const wood = new THREE.MeshLambertMaterial({ color: 0x8a6a28 });
      this.box(g, 0.05, 0.9, 0.05, wood, 0.22, 0.48, 0);
      const orb = new THREE.MeshLambertMaterial({ color: 0xc9a227, emissive: 0xaa8800 });
      this.box(g, 0.12, 0.12, 0.12, orb, 0.22, 1.02, 0);
      this.box(g, 0.07, 0.07, 0.07, skin, 0.22, 0.48, 0);
      return g;
    }

    if (kind === "shaman") {
      const robe = new THREE.MeshLambertMaterial({ color: team === 0 ? 0xe8f4ff : 0xffe4d4 });
      this.box(g, 0.22, 0.42, 0.20, robe, 0, 0.24, 0);
      this.box(g, 0.14, 0.14, 0.14, skin, 0, 0.50, 0);
      this.box(g, 0.20, 0.14, 0.20, gold, 0, 0.60, 0);
      const wood = new THREE.MeshLambertMaterial({ color: 0x8a6a28 });
      this.box(g, 0.05, 0.70, 0.05, wood, 0.18, 0.38, 0);
      this.box(g, 0.04, 0.12, 0.04, gold, 0.18, 0.76, 0);
      this.box(g, 0.14, 0.04, 0.04, gold, 0.18, 0.76, 0);
      this.box(g, 0.08, 0.03, 0.04, gold, 0.18, 0.88, 0);
      this.box(g, 0.03, 0.07, 0.04, gold, 0.145, 0.84, 0);
      this.box(g, 0.03, 0.07, 0.04, gold, 0.215, 0.84, 0);
      this.box(g, 0.07, 0.07, 0.07, skin, 0.18, 0.40, 0);
      return g;
    }

    if (kind === "warrior") {
      this.box(g, 0.22, 0.28, 0.18, silver, 0, 0.18, 0);
      this.box(g, 0.23, 0.05, 0.19, teamMat, 0, 0.16, 0);
      this.box(g, 0.16, 0.16, 0.16, skin, 0, 0.40, 0);
      this.box(g, 0.20, 0.10, 0.20, metal, 0, 0.50, 0);
      const light = new THREE.MeshLambertMaterial({ color: 0xf2efe6 });
      this.box(g, 0.04, 0.18, 0.18, light, -0.18, 0.26, 0);
      this.box(g, 0.03, 0.08, 0.08, teamMat, -0.205, 0.305, 0.04);
      this.box(g, 0.03, 0.08, 0.08, light, -0.205, 0.305, -0.04);
      this.box(g, 0.03, 0.08, 0.08, light, -0.205, 0.215, 0.04);
      this.box(g, 0.03, 0.08, 0.08, teamMat, -0.205, 0.215, -0.04);
      this.box(g, 0.035, 0.36, 0.035, metal, 0.18, 0.32, 0);
      this.box(g, 0.07, 0.07, 0.07, skin, 0.16, 0.24, 0);
      return g;
    }

    if (kind === "spy") {
      const cloak = new THREE.MeshLambertMaterial({ color: cloakCol });
      this.box(g, 0.18, 0.22, 0.16, skin, 0, 0.16, 0);
      this.box(g, 0.16, 0.07, 0.10, teamMat, 0, 0.10, 0.02);
      this.box(g, 0.20, 0.26, 0.18, cloak, 0, 0.18, -0.02);
      this.box(g, 0.14, 0.14, 0.14, skin, 0, 0.34, 0.02);
      this.box(g, 0.16, 0.12, 0.16, cloak, 0, 0.40, 0);
      return g;
    }

    if (kind === "wildman") {
      const brown = new THREE.MeshLambertMaterial({ color: 0x6b4423 });
      const hair = new THREE.MeshLambertMaterial({ color: 0x3a2414 });
      this.box(g, 0.18, 0.22, 0.16, brown, 0, 0.16, 0);
      this.box(g, 0.14, 0.14, 0.14, skin, 0, 0.34, 0);
      this.box(g, 0.16, 0.08, 0.12, hair, 0, 0.42, -0.01);
      this.box(g, 0.04, 0.08, 0.04, hair, 0.05, 0.48, 0);
      return g;
    }

    // v0.25d 村民（walker）头巾：头顶一块 + 脑后垂尾，任何角度都能看到阵营色（蓝/红）。
    // 头巾顶略宽于头(0.14)盖住头顶（头顶 y=0.41，中心放 0.435 微微隆起）；
    // 垂尾贴后脑勺（头半深 0.07，尾巴厚 0.02 → 外缘 -0.105 不悬空）。若实测 -z 是脸的方向，把 z 改 +0.095。
    this.box(g, 0.18, 0.22, 0.16, skin, 0, 0.16, 0);
    this.box(g, 0.16, 0.07, 0.10, teamMat, 0, 0.10, 0.02);
    this.box(g, 0.14, 0.14, 0.14, skin, 0, 0.34, 0);
    this.box(g, 0.18, 0.05, 0.18, teamMat, 0, 0.435, 0);
    this.box(g, 0.02, 0.16, 0.14, teamMat, 0, 0.375, -0.095);
    return g;
  }

  syncUnits(sim: SimClient): void {
    const live = new Set<number>();
    for (const u of sim.units) {
      // v0.27h 茅屋住户画在屋顶；v0.28e 塔顶驻军同理——sim.arrangeDwellers/tickEnter
      // 已把坐标/高度维护到位（含爬塔插值），照常走地面单位绘制路径，攀爬过程自然可见。
      if (u.homeId > 0 && u.enterT <= 0) {
        const home = sim.buildingById(u.homeId);
        if (!home || (home.kind !== "hut" && home.kind !== "tower")) continue;
      }
      live.add(u.id);
      let g = this.unitMeshes.get(u.id);
      const teamVis = u.team === 2 ? 0 : (u.team as Team);
      if (!g || g.userData.kind !== u.kind || g.userData.team !== u.team || g.userData.disguise !== u.disguise) {
        if (g) this.unitGroup.remove(g);
        g = this.makeUnit(teamVis, u.kind, u.disguise);
        g.userData.kind = u.kind;
        g.userData.team = u.team;
        g.userData.disguise = u.disguise;
        this.unitMeshes.set(u.id, g);
        this.unitGroup.add(g);
      }
      const bob = Math.abs(Math.sin(this.t * 8 + u.phase)) * 0.03;
      g.position.set(u.x, u.y + bob, u.z);
      g.rotation.y = u.yaw;
      // v0.12 倒地动画：命中后 0.2s 倒下 → 平躺 → 归零前 0.2s 爬起，倾角按包络系数过渡。
      if (u.downT > 0) {
        const f = Math.min(1, Math.min(u.downT, FIRE_DOWN_TIME - u.downT) / 0.2);
        g.rotation.z = f * 1.4;
      } else if (g.rotation.z !== 0) {
        g.rotation.z = 0;
      }
      let pack = g.getObjectByName("woodpack") as THREE.Mesh | undefined;
      if (!pack) {
        pack = new THREE.Mesh(
          new THREE.BoxGeometry(0.10, 0.08, 0.16),
          new THREE.MeshLambertMaterial({ color: 0x6a3e1a }),
        );
        pack.name = "woodpack";
        pack.position.set(0, 0.26, -0.12);
        g.add(pack);
      }
      pack.visible = u.carry === 1;
      let fire = g.getObjectByName("burn") as THREE.Group | undefined;
      if (!fire) {
        fire = new THREE.Group();
        fire.name = "burn";
        const fm = new THREE.MeshBasicMaterial({ color: 0xff7a18 });
        const fm2 = new THREE.MeshBasicMaterial({ color: 0xffee66 });
        const a = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.38, 0.22), fm);
        a.position.set(-0.14, 0.55, 0.08);
        const b = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.32, 0.18), fm2);
        b.position.set(0.12, 0.72, -0.06);
        const c = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.28, 0.16), fm);
        c.position.set(0.02, 0.95, 0.1);
        fire.add(a, b, c);
        g.add(fire);
      }
      fire.visible = u.fireT > 0 || u.burnT > 0; // v0.26 火球灼烧也点亮火焰
    }
    for (const [id, g] of this.unitMeshes) {
      if (!live.has(id)) {
        this.unitGroup.remove(g);
        this.unitMeshes.delete(id);
      }
    }
  }

  makeTree(): THREE.Group {
    const g = new THREE.Group();
    const trunk = new THREE.MeshLambertMaterial({ color: 0x6a4424 });
    const leaf = new THREE.MeshLambertMaterial({ color: 0x2f6a28 });
    this.box(g, 0.18, 0.12, 0.18, trunk, 0, 0.06, 0);
    const crown = new THREE.Group();
    crown.name = "crown";
    this.box(crown, 0.16, 0.55, 0.16, trunk, 0, 0.28, 0);
    this.box(crown, 0.55, 0.28, 0.55, leaf, 0, 0.72, 0);
    this.box(crown, 0.38, 0.22, 0.38, leaf, 0, 0.96, 0);
    g.add(crown);
    return g;
  }

  addWoodStacks(g: THREE.Group, wood: number): void {
    const log = new THREE.MeshLambertMaterial({ color: 0x8a5a28 });
    const n = Math.max(0, wood);
    for (let i = 0; i < n; i++) {
      const row = Math.floor(i / 2);
      const col = i % 2;
      this.box(g, 0.55, 0.12, 0.16, log, -0.35 + col * 0.5, 0.12 + row * 0.14, 0.85);
    }
  }

  makeHouse(team: Team, level: number, kind: string, wood = 0, shell = false): THREE.Group {
    const g = new THREE.Group();
    const primary = this.teamPrimary(team);
    const teamMat = new THREE.MeshLambertMaterial({ color: primary });

    if (shell && kind !== "rebirth" && level >= 1) {
      const span = kind === "hut" ? 2.2 : 2.4; // v0.11a：骨架占地不再随等级扩大
      const h = level >= 3 ? 1.35 : level === 2 ? 1.2 : 1.05; // 只许长高一点点
      const half = span * 0.42;
      const wood = new THREE.MeshLambertMaterial({ color: 0x6a4a22 });
      const char = new THREE.MeshLambertMaterial({ color: 0x3a2a18 });
      this.box(g, span * 0.72, 0.06, span * 0.72, char, 0, 0.03, 0);
      for (const [sx, sz] of [
        [-1, -1],
        [1, -1],
        [1, 1],
        [-1, 1],
      ] as const) {
        this.box(g, 0.16, h, 0.16, wood, sx * half, h * 0.5, sz * half);
      }
      this.box(g, span * 0.84, 0.12, 0.12, wood, 0, h, half);
      this.box(g, span * 0.84, 0.12, 0.12, wood, 0, h, -half);
      this.box(g, 0.12, 0.12, span * 0.84, wood, half, h, 0);
      this.box(g, 0.12, 0.12, span * 0.84, wood, -half, h, 0);
      this.box(g, span * 0.84, 0.1, 0.1, wood, 0, h * 0.55, 0);
      return g;
    }

    if (level <= 0) {
      const dirt = new THREE.MeshLambertMaterial({ color: 0x6a5530 });
      const log = new THREE.MeshLambertMaterial({ color: 0x8a5a28 });
      this.box(g, 2.5, 0.07, 2.5, dirt, 0, 0.035, 0);
      // v0.28i 渐进式建造：四角脚手架独立成组，syncHouses 每帧按 built/need 抬升 scale.y。
      const scaffold = new THREE.Group();
      scaffold.name = "scaffold";
      for (const [x, z] of [
        [-1.05, -1.05],
        [1.05, -1.05],
        [-1.05, 1.05],
        [1.05, 1.05],
      ] as const) {
        this.box(scaffold, 0.08, 1.0, 0.08, log, x, 0.5, z);
      }
      this.box(scaffold, 2.1, 0.07, 0.07, log, 0, 0.96, -1.05);
      this.box(scaffold, 2.1, 0.07, 0.07, log, 0, 0.96, 1.05);
      g.add(scaffold);
      this.addWoodStacks(g, wood);
      return g;
    }

    if (kind === "rebirth") {
      const stone = new THREE.MeshLambertMaterial({ color: 0xd0cec6 });
      for (let i = 0; i < 8; i++) {
        const ang = (i / 8) * Math.PI * 2;
        this.box(g, 0.28, 0.9, 0.18, stone, Math.cos(ang) * 1.3, 0.45, Math.sin(ang) * 1.3);
      }
      return g;
    }
    if (kind === "warriorHut") {
      const wall = new THREE.MeshLambertMaterial({ color: 0x8a8478 });
      this.box(g, 2.4, 0.9, 2.4, wall, 0, 0.45, 0);
      this.box(g, 0.08, 0.7, 0.08, new THREE.MeshLambertMaterial({ color: 0xc8c8d0 }), 0.9, 1.15, 0.2);
      this.box(g, 0.08, 0.7, 0.08, new THREE.MeshLambertMaterial({ color: 0xc8c8d0 }), 1.05, 1.15, -0.15);
      this.box(g, 0.6, 0.25, 0.08, teamMat, 0.4, 1.3, 0);
      return g;
    }
    if (kind === "temple") {
      const wall = new THREE.MeshLambertMaterial({ color: 0xc8b48a });
      this.box(g, 2.6, 1.0, 2.6, wall, 0, 0.5, 0);
      this.box(g, 0.08, 0.7, 0.08, new THREE.MeshLambertMaterial({ color: 0xc9a227 }), 0, 1.35, 0);
      this.box(g, 0.28, 0.08, 0.08, new THREE.MeshLambertMaterial({ color: 0xc9a227 }), 0, 1.55, 0);
      return g;
    }
    if (kind === "fireHut") {
      const wall = new THREE.MeshLambertMaterial({ color: 0x7a4a32 });
      this.box(g, 2.4, 0.85, 2.4, wall, 0, 0.42, 0);
      const fire = new THREE.MeshLambertMaterial({ color: 0xffaa44, emissive: 0xaa3300 });
      this.box(g, 0.35, 0.2, 0.35, fire, 0, 1.0, 0);
      return g;
    }
    if (kind === "spyHut") {
      const wall = new THREE.MeshLambertMaterial({ color: 0x2a2a30 });
      this.box(g, 2.2, 0.8, 2.2, wall, 0, 0.4, 0);
      this.box(g, 0.5, 0.35, 0.12, teamMat, 0, 1.05, 0.9);
      return g;
    }
    if (kind === "tower") {
      // v0.27f 魔法哨塔：细高石柱 + 瞭望台 + 四面栅栏窗口（栏间敞开，驻塔牛战士可见）+ 四柱撑起的队色尖顶。
      const stone = new THREE.MeshLambertMaterial({ color: 0x8a8478 });
      const wood = new THREE.MeshLambertMaterial({ color: 0x6a4a28 });
      this.box(g, 0.5, 3.2, 0.5, stone, 0, 1.6, 0); // 塔柱（细高）
      // v0.28e 塔门 + 爬梯：牛战士从塔脚的门沿梯子爬上瞭望台（视觉入口）。
      const door = new THREE.MeshLambertMaterial({ color: 0x35281a });
      this.box(g, 0.24, 0.44, 0.06, door, 0, 0.22, 0.27);
      const rung = new THREE.MeshLambertMaterial({ color: 0x8a6a3a });
      for (let i = 0; i < 5; i++) this.box(g, 0.3, 0.04, 0.04, rung, 0, 0.8 + i * 0.52, 0.26);
      this.box(g, 1.0, 0.12, 1.0, stone, 0, 3.3, 0); // 瞭望台地板（台面 3.36）
      // 四面扶手横杆：栏间即窗口，火球与视线四面八方通畅。
      for (const [x, z, w, d] of [
        [0, 0.47, 1.0, 0.05],
        [0, -0.47, 1.0, 0.05],
        [0.47, 0, 0.05, 1.0],
        [-0.47, 0, 0.05, 1.0],
      ] as const) {
        this.box(g, w, 0.07, d, wood, x, 3.72, z);
      }
      // 四角栏柱 + 天棚支柱（撑起尖顶，头顶留窗口空间）。
      for (const [x, z] of [
        [0.45, 0.45],
        [-0.45, 0.45],
        [0.45, -0.45],
        [-0.45, -0.45],
      ] as const) {
        this.box(g, 0.07, 0.42, 0.07, wood, x, 3.56, z); // 栏柱（3.36→3.77）
        this.box(g, 0.05, 0.4, 0.05, wood, x, 3.95, z); // 天棚支柱（3.77→4.15）
      }
      // 队色四棱尖顶（尖尖的魔法塔尖）。
      const spire = new THREE.Mesh(new THREE.ConeGeometry(0.62, 1.1, 4), teamMat);
      spire.position.set(0, 4.7, 0);
      spire.rotation.y = Math.PI / 4;
      g.add(spire);
      return g;
    }

    if (level <= 1) {
      // v0.28c 茅屋缩半：水平尺寸 2.2→1.1（高度不变，只瘦身）。
      const wallCol = team === 0 ? 0x8a6a40 : 0x7a4a32;
      this.box(g, 1.1, 0.7, 1.1, new THREE.MeshLambertMaterial({ color: wallCol }), 0, 0.35, 0);
      const thatch = new THREE.MeshLambertMaterial({ color: 0xc4a44a });
      this.box(g, 1.1, 0.3, 1.1, thatch, 0, 0.85, 0);
      this.box(g, 0.88, 0.2, 0.88, thatch, 0, 1.05, 0);
      this.box(g, 0.3, 0.4, 0.15, teamMat, 0, 0.3, 0.594);
      this.box(g, 0.11, 0.28, 0.11, new THREE.MeshLambertMaterial({ color: 0x6a4a20 }), 0.36, 1.22, 0.36);
      this.box(g, 0.36, 0.25, 0.11, teamMat, 0.53, 1.3, 0.36);
      return g;
    }

    if (level === 2) {
      // v0.11a：L2 石屋与 L1 同占地，只更高；v0.28c 占地随缩半为 1.1。
      const stone = new THREE.MeshLambertMaterial({ color: 0x8a8478 });
      this.box(g, 1.1, 1.15, 1.1, stone, 0, 0.58, 0);
      this.box(g, 1.1, 0.45, 1.1, teamMat, 0, 1.38, 0);
      this.box(g, 0.35, 0.3, 0.35, stone, 0, 1.75, 0);
      this.box(g, 0.3, 0.55, 0.15, teamMat, 0, 0.28, 0.594);
      return g;
    }

    // v0.11a：L3 城堡恒定占地只更高；v0.28c 占地随缩半为 1.1：石塔 + 四角垛口 + 旗。
    const light = new THREE.MeshLambertMaterial({ color: 0xd0cec6 });
    this.box(g, 1.1, 1.5, 1.1, light, 0, 0.75, 0);
    for (const [x, z] of [
      [0.5, 0.5],
      [0.5, -0.5],
      [-0.5, 0.5],
      [-0.5, -0.5],
    ] as const) {
      this.box(g, 0.26, 0.34, 0.26, light, x, 1.67, z);
    }
    this.box(g, 0.2, 0.55, 0.2, new THREE.MeshLambertMaterial({ color: 0x6a4a28 }), 0.45, 1.95, 0.45);
    this.box(g, 0.4, 0.3, 0.05, teamMat, 0.55, 2.1, 0.45);
    this.box(g, 0.3, 0.7, 0.15, teamMat, 0, 0.35, 0.594);
    return g;
  }

  makeTrainBar(): THREE.Group {
    const g = new THREE.Group();
    const track = new THREE.Mesh(new THREE.BoxGeometry(1.2, 0.12, 0.1), this.trainBarTrackMat);
    track.name = "track";
    g.add(track);
    const fill = new THREE.Mesh(new THREE.BoxGeometry(1.2, 0.1, 0.12), this.trainBarFillMat);
    fill.name = "fill";
    fill.position.y = 0.01;
    g.add(fill);
    const marks = new THREE.Group();
    marks.name = "marks";
    g.add(marks);
    return g;
  }

  syncTrainBars(sim: SimClient): void {
    const live = new Set<number>();
    for (const b of sim.buildings) {
      if (!isCampKind(b.kind) || b.team !== BLUE || b.hp <= 0 || b.level < 1) continue;
      live.add(b.id);
      let g = this.trainBars.get(b.id);
      if (!g) {
        g = this.makeTrainBar();
        this.trainBars.set(b.id, g);
        this.trainBarGroup.add(g);
      }
      const queue = sim.trainQueue(b.id);
      const trainer = queue[0];
      let show = false;
      let t = 0;
      if (trainer) {
        const slot0 = sim.trainSlotPos(b, 0);
        const atSlot = (trainer.x - slot0.x) ** 2 + (trainer.z - slot0.z) ** 2 <= 0.25 * 0.25;
        if (trainer.channel > 0 || atSlot) {
          show = true;
          t = clamp(trainer.channel / TRAIN_TIME, 0, 1);
        }
      }
      g.visible = show;
      if (!show) continue;
      g.position.set(b.x, b.y + 1.15 + 0.6, b.z);
      const dx = this.camera.position.x - g.position.x;
      const dz = this.camera.position.z - g.position.z;
      g.rotation.y = Math.atan2(dx, dz);
      const fill = g.getObjectByName("fill") as THREE.Mesh;
      fill.scale.x = Math.max(0.001, t);
      fill.position.x = (t - 1) * 0.6;
      const marks = g.getObjectByName("marks") as THREE.Group;
      while (marks.children.length > queue.length) {
        marks.remove(marks.children[marks.children.length - 1]!);
      }
      while (marks.children.length < queue.length) {
        marks.add(new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.09, 0.09), this.trainBarMarkMat));
      }
      for (let i = 0; i < marks.children.length; i++) {
        marks.children[i]!.position.set(0.74, 0, 0.12 * i);
      }
    }
    for (const [id, g] of this.trainBars) {
      if (!live.has(id)) {
        this.trainBarGroup.remove(g);
        this.trainBars.delete(id);
      }
    }
  }

  makeProdBar(): THREE.Group {
    const g = new THREE.Group();
    const track = new THREE.Mesh(new THREE.BoxGeometry(1.2, 0.12, 0.1), this.prodBarTrackMat);
    track.name = "track";
    g.add(track);
    const fill = new THREE.Mesh(new THREE.BoxGeometry(1.2, 0.1, 0.12), this.prodBarFillMat);
    fill.name = "fill";
    fill.position.y = 0.01;
    g.add(fill);
    return g;
  }

  /** v0.11 房屋生产进度条：蓝方有人住且未满员的茅屋头顶显示 b.prod [0,1) 生产进度。 */
  syncProdBars(sim: SimClient): void {
    const live = new Set<number>();
    for (const b of sim.buildings) {
      if (b.kind !== "hut" || b.team !== BLUE || b.hp <= 0 || b.level < 1) continue;
      if (b.dwell <= 0 || b.dwell >= houseMaxPop(b.level)) continue;
      live.add(b.id);
      let g = this.prodBars.get(b.id);
      if (!g) {
        g = this.makeProdBar();
        this.prodBars.set(b.id, g);
        this.prodBarGroup.add(g);
      }
      const t = clamp(b.prod, 0, 1);
      g.visible = t > 0.001;
      if (!g.visible) continue;
      const roofY = b.level >= 3 ? 2.35 : b.level === 2 ? 1.95 : 1.45;
      g.position.set(b.x, b.y + roofY + 0.35, b.z);
      const dx = this.camera.position.x - g.position.x;
      const dz = this.camera.position.z - g.position.z;
      g.rotation.y = Math.atan2(dx, dz);
      const fill = g.getObjectByName("fill") as THREE.Mesh;
      fill.scale.x = Math.max(0.001, t);
      fill.position.x = (t - 1) * 0.6;
    }
    for (const [id, g] of this.prodBars) {
      if (!live.has(id)) {
        this.prodBarGroup.remove(g);
        this.prodBars.delete(id);
      }
    }
  }

  makeRoofIcon(): THREE.Group {
    const g = new THREE.Group();
    const wood = new THREE.MeshLambertMaterial({ color: 0x6a4a22 });
    const mark = new THREE.MeshLambertMaterial({ color: 0xf0d878 });
    const post = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.28, 0.07), wood);
    post.position.y = 0.14;
    g.add(post);
    const stack = new THREE.Group();
    stack.name = "stack";
    for (let i = 0; i < 3; i++) {
      const box = new THREE.Mesh(new THREE.BoxGeometry(0.24, 0.11, 0.24), mark);
      box.name = `rate${i}`;
      box.position.y = 0.36 + i * 0.14;
      stack.add(box);
    }
    g.add(stack);
    return g;
  }

  syncRoofIcons(sim: SimClient): void {
    const live = new Set<number>();
    for (const b of sim.buildings) {
      if (b.kind !== "hut" || b.hp <= 0 || b.level < 1) continue;
      const producing = b.dwell > 0 && b.dwell < houseMaxPop(b.level);
      live.add(b.id);
      let g = this.roofIcons.get(b.id);
      if (!g) {
        g = this.makeRoofIcon();
        this.roofIcons.set(b.id, g);
        this.roofIconGroup.add(g);
      }
      g.visible = producing;
      if (!producing) continue;
      const roofY = b.level >= 3 ? 2.35 : b.level === 2 ? 1.95 : 1.45;
      g.position.set(b.x, b.y + roofY, b.z);
      const dx = this.camera.position.x - g.position.x;
      const dz = this.camera.position.z - g.position.z;
      g.rotation.y = Math.atan2(dx, dz);
      const n = b.level >= 3 ? 3 : b.level === 2 || b.dwell >= 2 ? 2 : 1;
      const stack = g.getObjectByName("stack") as THREE.Group;
      for (let i = 0; i < stack.children.length; i++) {
        stack.children[i]!.visible = i < n;
      }
    }
    for (const [id, g] of this.roofIcons) {
      if (!live.has(id)) {
        this.roofIconGroup.remove(g);
        this.roofIcons.delete(id);
      }
    }
  }

  makeDwellPips(team: Team, maxPop: number, dwell: number): THREE.Group {
    const g = new THREE.Group();
    const emptyMat = new THREE.MeshLambertMaterial({ color: 0x1e1a14 });
    const bodyMat = new THREE.MeshLambertMaterial({ color: this.teamPrimary(team) });
    const skinMat = new THREE.MeshLambertMaterial({ color: 0xf0d2a8 });
    const boardMat = new THREE.MeshLambertMaterial({ color: 0x2a2418 });
    const cols = maxPop <= 5 ? maxPop : 4;
    const rows = Math.ceil(maxPop / cols);
    const gap = 0.22;
    const boardW = cols * gap + 0.1;
    const boardH = rows * 0.32 + 0.1;
    const board = new THREE.Mesh(new THREE.BoxGeometry(boardW, boardH, 0.06), boardMat);
    g.add(board);
    for (let i = 0; i < maxPop; i++) {
      const col = i % cols;
      const row = Math.floor(i / cols);
      const x = (col - (cols - 1) / 2) * gap;
      const y = ((rows - 1) / 2 - row) * 0.3;
      if (i < dwell) {
        this.box(g, 0.14, 0.18, 0.1, bodyMat, x, y - 0.02, 0.08);
        this.box(g, 0.1, 0.08, 0.1, skinMat, x, y + 0.12, 0.08);
      } else {
        this.box(g, 0.14, 0.12, 0.08, emptyMat, x, y, 0.06);
      }
    }
    return g;
  }

  syncDwellPips(sim: SimClient): void {
    const live = new Set<number>();
    for (const b of sim.buildings) {
      if (b.kind !== "hut" || b.hp <= 0 || b.level < 1 || b.dwell <= 0) continue;
      live.add(b.id);
      const maxPop = houseMaxPop(b.level);
      let g = this.dwellPips.get(b.id);
      if (
        !g ||
        g.userData.dwell !== b.dwell ||
        g.userData.level !== b.level ||
        g.userData.team !== b.team
      ) {
        if (g) this.dwellPipGroup.remove(g);
        g = this.makeDwellPips(b.team, maxPop, b.dwell);
        g.userData.dwell = b.dwell;
        g.userData.level = b.level;
        g.userData.team = b.team;
        this.dwellPips.set(b.id, g);
        this.dwellPipGroup.add(g);
      }
      const roofY = b.level >= 3 ? 2.0 : b.level === 2 ? 1.6 : 1.22;
      const front = 1.02; // v0.11a：占地恒定后门面位置不随等级变化
      g.position.set(b.x, b.y + roofY, b.z);
      g.rotation.y = b.yaw;
      const local = this.padLocalFront(b.yaw, front);
      g.position.x = b.x + local.x;
      g.position.z = b.z + local.z;
    }
    for (const [id, g] of this.dwellPips) {
      if (!live.has(id)) {
        this.dwellPipGroup.remove(g);
        this.dwellPips.delete(id);
      }
    }
  }

  padLocalFront(yaw: number, dist: number): { x: number; z: number } {
    return { x: -Math.sin(yaw) * dist, z: Math.cos(yaw) * dist };
  }

  syncHouses(sim: SimClient): void {
    const live = new Set<number>();
    for (const b of sim.buildings) {
      live.add(b.id);
      let g = this.houseMeshes.get(b.id);
      if (
        !g ||
        g.userData.level !== b.level ||
        g.userData.team !== b.team ||
        g.userData.kind !== b.kind ||
        g.userData.wood !== b.wood ||
        g.userData.shell !== b.shell
      ) {
        if (g) this.houseGroup.remove(g);
        g = this.makeHouse(b.team, b.level, b.kind, b.wood, b.shell);
        g.userData.level = b.level;
        g.userData.team = b.team;
        g.userData.kind = b.kind;
        g.userData.wood = b.wood;
        g.userData.shell = b.shell;
        if (b.level >= 1 && b.wood > 0) this.addWoodStacks(g, b.wood);
        this.houseMeshes.set(b.id, g);
        this.houseGroup.add(g);
      }
      g.position.set(b.x, b.y, b.z);
      g.rotation.y = b.yaw;
      // v0.28i 工地脚手架随建造进度起升（存木越多升得越快，一眼可读）。
      if (b.level === 0 && b.need > 0) {
        const sc = g.getObjectByName("scaffold");
        if (sc) sc.scale.y = 0.15 + 0.85 * Math.min(1, b.built / b.need);
      }
    }
    for (const [id, g] of this.houseMeshes) {
      if (!live.has(id)) {
        this.spawnWreck(g.position.x, g.position.y, g.position.z, g.userData.team as Team);
        this.houseGroup.remove(g);
        this.houseMeshes.delete(id);
      }
    }
  }

  syncTrees(sim: SimClient): void {
    const live = new Set<number>();
    for (const t of sim.trees) {
      live.add(t.id);
      let g = this.treeMeshes.get(t.id);
      if (!g) {
        g = this.makeTree();
        this.treeMeshes.set(t.id, g);
        this.treeGroup.add(g);
      }
      g.position.set(t.x, this.world.heightAt(t.x, t.z), t.z);
      const crown = g.getObjectByName("crown");
      if (crown) crown.visible = t.alive;
    }
    for (const [id, g] of this.treeMeshes) {
      if (!live.has(id)) {
        this.treeGroup.remove(g);
        this.treeMeshes.delete(id);
      }
    }
  }

  syncAnkhs(sim: SimClient): void {
    while (this.ankhGroup.children.length) this.ankhGroup.remove(this.ankhGroup.children[0]!);
    for (const team of [0, 1] as const) {
      const mx = sim.teams[team].magnetX;
      const mz = sim.teams[team].magnetZ;
      const g = new THREE.Group();
      const pole = new THREE.Mesh(
        new THREE.BoxGeometry(0.1, 0.85, 0.1),
        new THREE.MeshLambertMaterial({ color: team === 0 ? 0x7ec8f0 : 0xf07060 }),
      );
      pole.position.y = 0.42;
      g.add(pole);
      g.position.set(mx, this.world.heightAt(mx, mz), mz);
      this.ankhGroup.add(g);
    }
  }

  syncShots(sim: SimClient): void {
    while (this.shotGroup.children.length) this.shotGroup.remove(this.shotGroup.children[0]!);
    for (const p of sim.shots) {
      const m = new THREE.Mesh(
        new THREE.BoxGeometry(0.12, 0.12, 0.12),
        new THREE.MeshLambertMaterial({ color: 0xffaa44, emissive: 0xaa3300 }),
      );
      m.position.set(p.x, p.y, p.z);
      this.shotGroup.add(m);
    }
  }



  syncLavaStreams(sim: SimClient): void {
    const cells = sim.world.lastRiverCells;
    const key = cells.length;
    if (key === this.lavaStreamSig) return;
    this.lavaStreamSig = key;
    while (this.lavaStreamGroup.children.length) {
      const ch = this.lavaStreamGroup.children[0]!;
      this.lavaStreamGroup.remove(ch);
      if (ch instanceof THREE.Mesh) ch.geometry.dispose();
    }
    if (!key) return;
    const mat = new THREE.MeshLambertMaterial({ color: 0xff6a10, emissive: 0xc43000 });
    for (const c of cells) {
      const h = sim.world.heightAt(c.x, c.z);
      const m = new THREE.Mesh(new THREE.BoxGeometry(0.40, 0.11, 0.13), mat);
      m.position.set(c.x, h + 0.08, c.z);
      m.rotation.y = -c.ang;
      this.lavaStreamGroup.add(m);
    }
  }

  swampKey(world: World): number {
    let n = 0;
    let acc = 0;
    const s = world.swamp;
    for (let i = 0; i < s.length; i++) {
      if (s[i]! > 0) {
        n++;
        acc += i;
      }
    }
    return n * 1000003 + (acc % 1000003);
  }

  syncSwamp(sim: SimClient): void {
    const key = this.swampKey(sim.world);
    if (key === this.swampSig) return;
    this.swampSig = key;
    this.clearSwampMeshes();
    if (key === 0) return;
    const stickMat = new THREE.MeshLambertMaterial({ color: 0x5a3a22 });
    const twigMat = new THREE.MeshLambertMaterial({ color: 0x6b4a28 });
    const fogMat = new THREE.MeshLambertMaterial({
      color: 0x6a7a55,
      transparent: true,
      opacity: 0.36,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    const w = sim.world;
    let sx = 0;
    let sz = 0;
    let nCell = 0;
    for (let iz = 0; iz < SAMPLES; iz += 2) {
      for (let ix = 0; ix < SAMPLES; ix += 2) {
        const i = w.idx(ix, iz);
        if (w.swamp[i]! <= 0) continue;
        const wx = ix * STEP;
        const wz = iz * STEP;
        const h = w.heightAt(wx, wz);
        if (h <= WATER) continue;
        sx += wx;
        sz += wz;
        nCell++;
        const seed = (ix * 131 + iz * 17) | 0;
        if (((ix + iz * 2) % 5) === 0) {
          const nStick = 2 + (seed % 2);
          for (let k = 0; k < nStick; k++) {
            const ox = ((seed >> (k * 3)) % 7) * 0.05 - 0.15;
            const oz = ((seed >> (k * 2 + 1)) % 7) * 0.05 - 0.15;
            const hh = 0.34 + ((seed + k * 11) % 9) * 0.05;
            const thick = 0.034 + (k % 2) * 0.014;
            const m = new THREE.Mesh(new THREE.BoxGeometry(thick, hh, thick), k % 2 ? twigMat : stickMat);
            m.position.set(wx + ox, h + hh * 0.48, wz + oz);
            m.rotation.z = (((seed + k * 13) % 11) - 5) * 0.07;
            m.rotation.x = (((seed + k * 7) % 9) - 4) * 0.08;
            this.swampGroup.add(m);
          }
        }
      }
    }
    if (!nCell) return;
    const cx = sx / nCell;
    const cz = sz / nCell;
    let rad = 0.8;
    for (let iz = 0; iz < SAMPLES; iz += 2) {
      for (let ix = 0; ix < SAMPLES; ix += 2) {
        if (w.swamp[w.idx(ix, iz)]! <= 0) continue;
        const d = Math.hypot(ix * STEP - cx, iz * STEP - cz);
        if (d > rad) rad = d;
      }
    }
    rad = Math.max(0.95, Math.min(2.1, rad + 0.15));
    const blobs: Array<[number, number, number, number]> = [
      [cx, cz, rad * 1.05, 0.22],
      [cx + rad * 0.38, cz - rad * 0.18, rad * 0.72, 0.2],
      [cx - rad * 0.32, cz + rad * 0.28, rad * 0.68, 0.19],
      [cx + rad * 0.12, cz + rad * 0.4, rad * 0.58, 0.18],
    ];
    for (const [bx, bz, br, by] of blobs) {
      const bh = w.heightAt(bx, bz);
      if (bh <= WATER) continue;
      const fog = new THREE.Mesh(new THREE.SphereGeometry(1, 14, 10), fogMat);
      fog.scale.set(br, by, br * 0.92);
      fog.position.set(bx, bh + by * 0.55, bz);
      this.swampGroup.add(fog);
    }

  }

  clearSwampMeshes(): void {
    while (this.swampGroup.children.length) {
      const ch = this.swampGroup.children[0]!;
      this.swampGroup.remove(ch);
      if (ch instanceof THREE.Mesh) ch.geometry.dispose();
    }
  }

  resetFx(): void {
    this.quakeT = 0;
    this.volcanoT = 0;
    this.shake = 0;
    this.clearBolts();
    this.clearDebris();
    this.clearPreview();
    while (this.sprayGroup.children.length) this.sprayGroup.remove(this.sprayGroup.children[0]!);
    this.clearSwamp();
    this.lavaFX.reset(); // v0.18 岩浆粒子池随对局重置清空
    this.sculptIndicator.setMode("off");
  }

  clearSwamp(): void {
    while (this.swampGroup.children.length) {
      const ch = this.swampGroup.children[0]!;
      this.swampGroup.remove(ch);
      if (ch instanceof THREE.Mesh) {
        ch.geometry.dispose();
        const mat = ch.material;
        if (Array.isArray(mat)) mat.forEach((m) => m.dispose());
        else mat.dispose();
      }
    }
    this.swampSig = -1;
  }

  clearBolts(): void {
    while (this.fxGroup.children.length) {
      const ch = this.fxGroup.children[0]!;
      this.fxGroup.remove(ch);
      if (ch instanceof THREE.Line || ch instanceof THREE.Mesh) ch.geometry.dispose();
    }
  }

  triggerQuake(x: number, z: number): void {
    this.quakeT = 1.15;
    this.quakeX = x;
    this.quakeZ = z;
  }

  triggerVolcano(x: number, z: number): void {
    this.volcanoT = 1.4; // v0.21 0.5→1.4：喷发柱持续整个初喷窗口
    this.volcanoX = x;
    this.volcanoZ = z;
  }

  spawnWreck(x: number, y: number, z: number, team: Team): void {
    const col = this.teamPrimary(team);
    const mat = new THREE.MeshLambertMaterial({ color: col });
    for (let i = 0; i < 6; i++) this.addDebris(x, y + 0.15 + i * 0.08, z, mat, 0.6);
  }

  addLavaSplash(x: number, y: number, z: number): void {
    for (let i = 0; i < 7; i++) {
      const s = 0.26 + Math.random() * 0.18;
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(s, s * 0.75, s), this.lavaDebMat);
      mesh.position.set(x + (Math.random() - 0.5) * 0.7, y + Math.random() * 0.35, z + (Math.random() - 0.5) * 0.7);
      this.debrisGroup.add(mesh);
      this.debris.push({
        mesh,
        vx: (Math.random() - 0.5) * 2.6,
        vy: 0.6 + Math.random() * 1.4,
        vz: (Math.random() - 0.5) * 2.6,
        life: 2.4,
        spinX: (Math.random() - 0.5) * 8,
        spinZ: (Math.random() - 0.5) * 8,
      });
    }
  }

  addDebris(x: number, y: number, z: number, mat: THREE.Material, life: number): void {
    const s = 0.16 + Math.random() * 0.22;
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(s, s * 0.7, s), mat);
    mesh.position.set(x + (Math.random() - 0.5) * 0.35, y, z + (Math.random() - 0.5) * 0.35);
    this.debrisGroup.add(mesh);
    this.debris.push({
      mesh,
      vx: (Math.random() - 0.5) * 3.4,
      vy: 2.2 + Math.random() * 3.2,
      vz: (Math.random() - 0.5) * 3.4,
      life,
      spinX: (Math.random() - 0.5) * 8,
      spinZ: (Math.random() - 0.5) * 8,
    });
  }

  tickDebris(dt: number): void {
    for (const d of this.debris) {
      d.life -= dt;
      d.vy -= 18 * dt;
      d.mesh.position.x += d.vx * dt;
      d.mesh.position.y += d.vy * dt;
      d.mesh.position.z += d.vz * dt;
      d.mesh.rotation.x += d.spinX * dt;
      d.mesh.rotation.z += d.spinZ * dt;
    }
    const keep = [];
    for (const d of this.debris) {
      if (d.life > 0 && d.mesh.position.y > -1) keep.push(d);
      else {
        this.debrisGroup.remove(d.mesh);
        d.mesh.geometry.dispose();
      }
    }
    this.debris = keep;
  }

  clearDebris(): void {
    for (const d of this.debris) {
      this.debrisGroup.remove(d.mesh);
      d.mesh.geometry.dispose();
    }
    this.debris = [];
  }


  /** v0.27f 天降火球：每帧重建坠落陨石网格——核心亮球 + 半透明光晕 + 上方两节尾焰。 */
  syncMeteors(sim: SimClient): void {
    while (this.meteorGroup.children.length) {
      const ch = this.meteorGroup.children[0]!;
      this.meteorGroup.remove(ch);
      if (ch instanceof THREE.Mesh) ch.geometry.dispose();
    }
    for (const m of sim.meteors) {
      const core = new THREE.Mesh(new THREE.SphereGeometry(0.2, 10, 8), this.meteorCoreMat);
      core.position.set(m.x, m.y, m.z);
      this.meteorGroup.add(core);
      const glow = new THREE.Mesh(new THREE.SphereGeometry(0.34, 10, 8), this.meteorGlowMat);
      glow.position.set(m.x, m.y, m.z);
      this.meteorGroup.add(glow);
      for (const [dy, r, op] of [
        [0.5, 0.13, 0.5],
        [0.95, 0.08, 0.28],
      ] as const) {
        const mat = new THREE.MeshBasicMaterial({ color: 0xff9a3a, transparent: true, opacity: op });
        const trail = new THREE.Mesh(new THREE.SphereGeometry(r, 8, 6), mat);
        trail.position.set(m.x, m.y + dy, m.z);
        this.meteorGroup.add(trail);
      }
    }
  }

  syncBlast(sim: SimClient): void {
    while (this.blastGroup.children.length) {
      const ch = this.blastGroup.children[0]!;
      this.blastGroup.remove(ch);
      if (ch instanceof THREE.Mesh) ch.geometry.dispose();
      if (ch instanceof THREE.Group) {
        while (ch.children.length) {
          const sub = ch.children[0]!;
          ch.remove(sub);
          if (sub instanceof THREE.Mesh) sub.geometry.dispose();
        }
      }
    }
    const b = sim.blast;
    if (b) {
      const fade = 1 - b.t / b.life;
      const h = this.world.heightAt(b.x, b.z);
      this.blastRingMat.opacity = 0.25 + fade * 0.7;
      const r1 = 0.45 + b.t * 2.4;
      const r2 = 0.7 + b.t * 3.1;
      const ring = new THREE.Mesh(new THREE.RingGeometry(Math.max(0.08, r1 - 0.12), r1, 20), this.blastRingMat);
      ring.rotation.x = -Math.PI / 2;
      ring.position.set(b.x, h + 0.08, b.z);
      this.blastGroup.add(ring);
      const ring2 = new THREE.Mesh(new THREE.RingGeometry(Math.max(0.1, r2 - 0.1), r2, 20), this.blastRingMat);
      ring2.rotation.x = -Math.PI / 2;
      ring2.position.set(b.x, h + 0.1, b.z);
      this.blastGroup.add(ring2);
    }
  }

  syncTornado(sim: SimClient, dt: number): void {
    // v0.18 龙卷风渲染委托给雾气条 fx 模块（细长漏斗 + 高速自旋 + 渐隐 + 水龙卷变色）。
    this.tornadoFX.sync(sim, dt);
  }

  /** v0.18 雕刻指示器：raise/lower 工具选中时由 game 每帧驱动，半透明脉动选框实时显示生效范围。 */
  updateSculptIndicator(mode: "raise" | "lower" | "off", x: number, z: number, dt: number): void {
    this.sculptIndicator.setMode(mode);
    if (mode !== "off") this.sculptIndicator.sync(x, z, this.world.heightAt(x, z), dt);
  }

  /** v0.26 转化范围圈：ok=false（距大祭司超 4 格/大祭司陨落）时红灰显示。 */
  updateConvertIndicator(mode: "cast" | "off", ok: boolean, x: number, z: number, dt: number): void {
    this.convertRange.setMode(mode, ok);
    if (mode !== "off") this.convertRange.sync(x, z, this.world.heightAt(x, z), dt);
  }

  syncVolcanoSpray(): void {
    while (this.sprayGroup.children.length) {
      const ch = this.sprayGroup.children[0]!;
      this.sprayGroup.remove(ch);
      if (ch instanceof THREE.Mesh) ch.geometry.dispose();
    }
    if (this.volcanoT <= 0) return;
    // v0.21 喷发柱炸裂化：0.5s → 1.4s 持续、柱体加高加粗（3.1→5.2、0.32→0.5），
    // 并叠加一圈冲天的次级碎柱——初喷"轰出来"的视觉主声道。
    const fade = this.volcanoT / 1.4;
    const h = this.world.heightAt(this.volcanoX, this.volcanoZ);
    this.sprayMat.opacity = 0.35 + fade * 0.45;
    const col = new THREE.Mesh(new THREE.BoxGeometry(0.5, 5.2, 0.5), this.sprayMat);
    col.position.set(this.volcanoX, h + 2.6, this.volcanoZ);
    this.sprayGroup.add(col);
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * Math.PI * 2 + fade * 2.4;
      const rr = 0.75 + Math.sin(fade * 6 + i * 1.7) * 0.25;
      const sub = new THREE.Mesh(new THREE.BoxGeometry(0.26, 2.6 * fade + 0.6, 0.26), this.sprayMat);
      sub.position.set(this.volcanoX + Math.cos(a) * rr, h + 1.3 * fade + 0.5, this.volcanoZ + Math.sin(a) * rr);
      this.sprayGroup.add(sub);
    }
  }

  syncBolts(bolts: FxBolt[]): void {
    this.clearBolts();
    const core = new THREE.MeshBasicMaterial({ color: 0xfff6c8 });
    const glow = new THREE.MeshBasicMaterial({ color: 0xffe066 });
    for (const b of bolts) {
      if (b.life <= 0) continue;
      const yGround = this.world.heightAt(b.x1, b.z1);
      const yTop = 11.2;
      let px = b.x1;
      let py = yTop;
      let pz = b.z1;
      for (let i = 0; i < 10; i++) {
        const u = (i + 1) / 10;
        const nx = b.x1 + Math.sin(i * 2.3 + b.x1) * (0.22 + (1 - u) * 0.18);
        const nz = b.z1 + Math.cos(i * 1.7 + b.z1) * (0.18 + (1 - u) * 0.14);
        const ny = yTop * (1 - u) + yGround * u;
        const dx = nx - px;
        const dy = ny - py;
        const dz = nz - pz;
        const len = Math.hypot(dx, dy, dz) || 0.1;
        const thick = 0.2 + (1 - u) * 0.08;
        const seg = new THREE.Mesh(new THREE.BoxGeometry(thick, len, thick), i % 2 ? glow : core);
        seg.position.set((px + nx) * 0.5, (py + ny) * 0.5, (pz + nz) * 0.5);
        seg.lookAt(nx, ny, nz);
        seg.rotateX(Math.PI / 2);
        this.fxGroup.add(seg);
        px = nx;
        py = ny;
        pz = nz;
      }
      const flash = new THREE.Mesh(new THREE.BoxGeometry(1.35, 0.16, 1.35), glow);
      flash.position.set(b.x1, yGround + 0.1, b.z1);
      this.fxGroup.add(flash);
      const stub = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.7, 0.42), core);
      stub.position.set(b.x1, yGround + 0.42, b.z1);
      this.fxGroup.add(stub);
    }
  }

  draw(sim: SimClient, bolts: FxBolt[], dt: number, freezeFx = false): void {
    this.sync(sim, bolts, dt, freezeFx);
    this.renderer.setRenderTarget(this.rt);
    this.renderer.render(this.scene, this.camera);
    this.renderer.setRenderTarget(null);
    this.renderer.render(this.screenScene, this.screenCam);
  }
}
