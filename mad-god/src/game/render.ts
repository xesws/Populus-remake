import * as THREE from "three";
import type { SimClient } from "./client/sim-client";
import { attackInterval, BLUE, BOATHOUSE_DWELL, clamp, FIRE_DOWN_TIME, FxBolt, houseMaxPop, isCampKind, SAMPLES, SINK_T, STEP, Team, TRAIN_TIME, WATER, WORLD } from "./types";
import { World } from "./world";
import { TornadoFX } from "./render-parts/tornado-fx";
import { LavaFX } from "./render-parts/lava-fx";
import { SculptIndicatorFX } from "./render-parts/sculpt-indicator-fx";
import { GuardFireFX } from "./render-parts/guard-fire-fx";
import { ConvertRangeFX } from "./render-parts/convert-range-fx";
import { DragonFX } from "./render-parts/dragon-fx";
import { TerrainMesh } from "./render-parts/terrain-mesh";
import { DRAGON_GARRISON_MAX } from "./types";

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
  denyX: THREE.Group; // v0.32 上船禁止符号（红叉，deny 光标态专用）
  /** v0.32 沉没本地计时（主线程/镜像通用）：boat id → 首次看到 hp≤0 的 this.t（推导沉没进度，不依赖 sinkT 快照）。 */
  sinkingBoats = new Map<number, number>();
  /** v0.32 白色涟漪池（船沉入水时泛起一圈，1.2s 扩散淡出）。 */
  sinkRipples: Array<{ g: THREE.Mesh; t0: number }> = [];
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
  /** v0.30 大龙特效：吐息弹体 + 燃烧地块。 */
  dragonFX = new DragonFX();
  /** v0.30 大龙训练营双进度条（进驻条 + 生产条）。 */
  dragonBarGroup = new THREE.Group();
  dragonGarrisonBars = new Map<number, THREE.Group>();
  dragonProdBars = new Map<number, THREE.Group>();
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
  /** v0.40 行走推导：上一帧位置＋时刻（算速度→摆动/前倾；纯本地，不读 sim 快照之外的量）。 */
  unitTrail = new Map<number, { x: number; z: number; t: number }>();
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
      this.dragonFX.group,
      this.dragonBarGroup,
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

    this.denyX = this.makeDenyX();
    this.denyX.visible = false;
    this.scene.add(this.denyX);

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

  makeDenyX(): THREE.Group {
    // v0.32 红叉：两根交叉细盒 vertical 悬浮（fist 同款高度，不做 billboard，随视角固定朝向）。
    const g = new THREE.Group();
    const red = new THREE.MeshBasicMaterial({ color: 0xd43a2a, side: THREE.DoubleSide });
    const a = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.09, 0.02), red);
    a.rotation.z = Math.PI / 4;
    const b = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.09, 0.02), red);
    b.rotation.z = -Math.PI / 4;
    g.add(a, b);
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

  hover(
    x: number,
    z: number,
    valid: boolean,
    mode: "move" | "fight" | "board" | "sail" | "disembark" | "deny" | "off" = valid ? "move" : "off",
  ): void {
    const m = !valid ? "off" : mode;
    if (m === "off") {
      this.cursor.visible = false;
      this.fightRing.visible = false;
      this.fist.visible = false;
      this.denyX.visible = false;
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
      this.denyX.visible = false;
      return;
    }
    // v0.32 船光标：同环换色（board 青/sail 浅蓝/disembark 绿/deny 红＋红叉）。
    if (m === "board" || m === "sail" || m === "disembark" || m === "deny") {
      const col = m === "deny" ? 0xd43a2a : m === "board" ? 0x2fbfa0 : m === "sail" ? 0x5cb8ff : 0x58c24a;
      (this.cursor.material as THREE.MeshBasicMaterial).color.set(col);
      this.cursor.visible = true;
      this.cursor.position.set(x, y + 0.04, z);
      this.cursor.quaternion.copy(q);
      this.fightRing.visible = false;
      this.fist.visible = false;
      this.denyX.visible = m === "deny";
      if (m === "deny") this.denyX.position.set(x, y + 0.85, z);
      return;
    }
    (this.cursor.material as THREE.MeshBasicMaterial).color.set(0xf2e08a);
    this.denyX.visible = false;
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
      // v0.30 大龙：选中环画在龙体正下方地面（影环），放大到龙体尺度。
      if (u.isFlying()) {
        ring.position.set(u.x, this.world.heightAt(u.x, u.z) + 0.05, u.z);
        ring.scale.setScalar(2.2);
      } else {
        ring.position.set(u.x, u.y + 0.05, u.z);
        ring.scale.setScalar(1);
      }
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
    this.syncDragonBars(sim); // v0.30 大龙训练营：进驻条 + 生产条
    this.syncRoofIcons(sim);
    this.syncDwellPips(sim);
    this.syncTrees(sim);
    this.syncSwamp(sim);
    this.syncLavaStreams(sim);
    this.syncTornado(sim, dt);
    this.lavaFX.sync(sim, dt); // v0.18 岩浆物理粒子（火山喷发 + 顺坡流动）
    this.guardFireFX.sync(sim, dt); // v0.19 守卫篝火
    this.dragonFX.sync(sim, dt); // v0.30 大龙：吐息弹体 + 燃烧地块
    this.syncBlast(sim);
    this.syncSinkRipples(); // v0.32 战船沉没白色涟漪
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

  /** v0.32 白色涟漪：船沉点泛起一圈，1.2s 扩散淡出（纯表现，sim 侧零状态）。 */
  spawnSinkRipple(x: number, z: number): void {
    const m = new THREE.Mesh(
      new THREE.RingGeometry(0.5, 0.72, 32),
      new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.85, side: THREE.DoubleSide }),
    );
    m.rotation.x = -Math.PI / 2;
    m.position.set(x, Math.max(this.world.heightAt(x, z), WATER) + 0.06, z);
    this.scene.add(m);
    this.sinkRipples.push({ g: m, t0: this.t });
  }

  syncSinkRipples(): void {
    for (let i = this.sinkRipples.length - 1; i >= 0; i--) {
      const r = this.sinkRipples[i]!;
      const f = (this.t - r.t0) / 1.2;
      if (f >= 1) {
        this.scene.remove(r.g);
        r.g.geometry.dispose();
        (r.g.material as THREE.Material).dispose();
        this.sinkRipples.splice(i, 1);
        continue;
      }
      const s = 1 + f * 3.2;
      r.g.scale.set(s, s, 1);
      (r.g.material as THREE.MeshBasicMaterial).opacity = 0.85 * (1 - f);
    }
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
      // v0.40 蓄力喷射：双手火块命名（syncUnits 按 atkCd 窗口放大蓄力），胸前 muzzle 闪光平时隐藏。
      const handL = this.box(g, 0.10, 0.10, 0.10, fire, -0.16, 0.28, 0.08);
      handL.name = "handL";
      const handR = this.box(g, 0.10, 0.10, 0.10, fire, 0.16, 0.28, 0.08);
      handR.name = "handR";
      const muzzle = new THREE.Mesh(
        new THREE.BoxGeometry(0.16, 0.16, 0.16),
        new THREE.MeshBasicMaterial({ color: 0xffee88 }),
      );
      muzzle.name = "muzzle";
      muzzle.position.set(0, 0.3, 0.3);
      muzzle.visible = false;
      g.add(muzzle);
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
      // v0.40 挥砍：剑臂成组（肩部枢轴 swordArm，syncUnits 按 atkCd 窗口播上举→下劈）。
      // 原剑身/持剑手坐标整体平移进组（组原点在肩 (0.16,0.34,0)，组内坐标为相对值）。
      const swordArm = new THREE.Group();
      swordArm.name = "swordArm";
      swordArm.position.set(0.16, 0.34, 0);
      this.box(swordArm, 0.035, 0.36, 0.035, metal, 0.02, -0.02, 0);
      this.box(swordArm, 0.07, 0.07, 0.07, skin, 0, -0.1, 0);
      g.add(swordArm);
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

    if (kind === "dragon") {
      // v0.30 大龙（飞龙）：低多边形机械怪风格——鳞甲体节 + 一对小机械翅膀 + 骨角 + 队色鞍甲。
      // 前向为 +z（与 yaw=atan2(dx,dz)、rotation.y=yaw 的地面单位同一约定）：尾在 -z，头在 +z。
      const scale = new THREE.MeshLambertMaterial({ color: 0x6b2a1a });
      const belly = new THREE.MeshLambertMaterial({ color: 0x8a4a2a });
      const horn = new THREE.MeshLambertMaterial({ color: 0xe8d4a0 });
      const metal = new THREE.MeshLambertMaterial({ color: 0x8a8f96 });
      const eye = new THREE.MeshBasicMaterial({ color: 0xffa030 });
      // 体节：尾尖 → 躯干 → 颈 → 头
      this.box(g, 0.14, 0.14, 0.5, scale, 0, 0.42, -1.05);
      this.box(g, 0.24, 0.24, 0.6, scale, 0, 0.46, -0.6);
      this.box(g, 0.38, 0.36, 0.9, scale, 0, 0.52, 0);
      this.box(g, 0.3, 0.18, 0.88, belly, 0, 0.36, 0);
      this.box(g, 0.26, 0.24, 0.5, scale, 0, 0.6, 0.6);
      this.box(g, 0.34, 0.28, 0.44, scale, 0, 0.66, 1.0); // 头
      this.box(g, 0.1, 0.08, 0.3, scale, 0, 0.62, 1.3); // 吻
      this.box(g, 0.06, 0.16, 0.06, horn, -0.1, 0.86, 0.92);
      this.box(g, 0.06, 0.16, 0.06, horn, 0.1, 0.86, 0.92);
      this.box(g, 0.07, 0.07, 0.07, eye, -0.14, 0.74, 1.08);
      this.box(g, 0.07, 0.07, 0.07, eye, 0.14, 0.74, 1.08);
      // 队色鞍甲（阵营识别：任何角度可见）
      this.box(g, 0.42, 0.1, 0.6, teamMat, 0, 0.74, -0.1);
      // 机械双翅（肩关节枢轴，syncUnits 每帧拍动）——"机械怪物"风格的骨架 + 膜翼
      const wing = (side: 1 | -1) => {
        const pivot = new THREE.Group();
        pivot.name = side === 1 ? "wingR" : "wingL";
        pivot.position.set(side * 0.16, 0.66, 0.15);
        const bone = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.06, 0.1), metal);
        bone.position.set(side * 0.5, 0.06, 0);
        pivot.add(bone);
        const membrane = new THREE.Mesh(new THREE.BoxGeometry(0.84, 0.03, 0.62), teamMat);
        membrane.position.set(side * 0.52, 0.02, -0.24);
        pivot.add(membrane);
        const tip = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.05, 0.4), metal);
        tip.position.set(side * 1.02, 0.1, 0.06);
        pivot.add(tip);
        g.add(pivot);
      };
      wing(1);
      wing(-1);
      // 尾鳍
      const fin = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.3, 0.36), teamMat);
      fin.position.set(0, 0.56, -1.32);
      g.add(fin);
      // 地面投影影子（syncUnits 每帧按对地高度放置/缩放）
      const shadow = new THREE.Mesh(
        new THREE.CircleGeometry(0.95, 14),
        new THREE.MeshBasicMaterial({ color: 0x0a1408, transparent: true, opacity: 0.3 }),
      );
      shadow.name = "shadow";
      shadow.rotation.x = -Math.PI / 2;
      g.add(shadow);
      return g;
    }

    if (kind === "boat") {
      // v0.32 战船：低多边形小木船——船壳＋舷＋长凳＋队色饰带＋艉旗。前向 +z（yaw=atan2(dx,dz) 同约定）。
      const hull = new THREE.MeshLambertMaterial({ color: 0x6a4a28 });
      const dark = new THREE.MeshLambertMaterial({ color: 0x3a2818 });
      this.box(g, 0.7, 0.22, 1.6, hull, 0, 0.11, 0); // 船底壳
      this.box(g, 0.4, 0.2, 0.4, hull, 0, 0.12, 0.9); // 艏收窄
      this.box(g, 0.5, 0.2, 0.3, hull, 0, 0.12, -0.85); // 艉
      this.box(g, 0.74, 0.06, 1.0, teamMat, 0, 0.24, 0); // 队色饰带（阵营识别）
      this.box(g, 0.08, 0.22, 1.5, hull, -0.36, 0.3, 0); // 左舷
      this.box(g, 0.08, 0.22, 1.5, hull, 0.36, 0.3, 0); // 右舷
      this.box(g, 0.55, 0.05, 1.4, dark, 0, 0.24, 0); // 舱底板
      this.box(g, 0.55, 0.07, 0.18, hull, 0, 0.32, 0.35); // 长凳×2（船员 2×3 槽位即坐这两排）
      this.box(g, 0.55, 0.07, 0.18, hull, 0, 0.32, -0.35);
      this.box(g, 0.05, 0.5, 0.05, hull, 0, 0.5, -0.8); // 艉旗杆
      this.box(g, 0.3, 0.18, 0.03, teamMat, 0.17, 0.68, -0.8); // 队色旗
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
    // v0.40 修理：锤子成组（平时隐藏，job repair 时可见敲打；木料沿用既有 woodpack）。
    const hammer = new THREE.Group();
    hammer.name = "hammer";
    hammer.position.set(0.2, 0.3, 0.05);
    hammer.visible = false;
    this.box(hammer, 0.04, 0.3, 0.04, new THREE.MeshLambertMaterial({ color: 0x8a6a28 }), 0, 0.1, 0);
    this.box(hammer, 0.12, 0.08, 0.08, new THREE.MeshLambertMaterial({ color: 0x555560 }), 0, 0.28, 0);
    g.add(hammer);
    return g;
  }

  syncUnits(sim: SimClient): void {
    const live = new Set<number>();
    for (const u of sim.units) {
      // v0.27h 茅屋住户画在屋顶；v0.28e 塔顶驻军同理——sim.arrangeDwellers/tickEnter
      // 已把坐标/高度维护到位（含爬塔插值），照常走地面单位绘制路径，攀爬过程自然可见。
      // v0.32 船员同理：宿主是船（单位 id），船在场即画（BoatSystem.syncRiders 已钉甲板）。
      if (u.homeId > 0 && u.enterT <= 0) {
        const home = sim.buildingById(u.homeId);
        if (!home) {
          const boat = sim.units.find((o) => o.id === u.homeId);
          if (!boat || boat.kind !== "boat" || boat.hp <= 0) continue;
        } else if (home.kind !== "hut" && home.kind !== "tower") continue;
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
      // v0.40 行走：速度本地推导（上一帧位移/渲染时钟），移动时摆动加大＋前倾＋左右晃；
      // 静止恢复旧小摆动。不读 sim 速度场——快照里没有，本地推导与旧 bob 同口径。
      const trail = this.unitTrail.get(u.id);
      let spd = 0;
      if (trail && this.t > trail.t) {
        const dt = Math.min(0.5, this.t - trail.t);
        spd = Math.hypot(u.x - trail.x, u.z - trail.z) / Math.max(1e-3, dt);
      }
      this.unitTrail.set(u.id, { x: u.x, z: u.z, t: this.t });
      const moving = spd > 0.5 && u.kind !== "boat";
      const bob = Math.abs(Math.sin(this.t * (moving ? 11 : 8) + u.phase)) * (moving ? 0.055 : 0.03);
      g.position.set(u.x, u.y + bob, u.z);
      g.rotation.y = u.yaw;
      // 前倾：船/倒地/大龙不管，只给地面步行者（rotation.x 此前地面单位未用过）。
      if (u.kind !== "boat" && u.kind !== "dragon" && u.downT <= 0) {
        g.rotation.x = moving ? Math.min(0.22, spd * 0.05) : 0;
      }
      // v0.32 沉没动画（主线程/镜像通用：按“hp≤0 且仍在场”本地计时推导进度，
      // 不依赖 sinkT 快照；首次看到即 spawn 白色涟漪，见 syncSinkRipples）。
      if (u.kind === "boat") {
        if (u.hp <= 0) {
          let t0 = this.sinkingBoats.get(u.id);
          if (t0 === undefined) {
            t0 = this.t;
            this.sinkingBoats.set(u.id, t0);
            this.spawnSinkRipple(u.x, u.z);
          }
          const f = Math.min(1, (this.t - t0) / SINK_T);
          g.position.y -= f * 1.4;
          g.rotation.z = f * 0.5;
          g.rotation.x = f * 0.22;
        } else {
          this.sinkingBoats.delete(u.id);
        }
      }
      // v0.12 倒地动画：命中后 0.2s 倒下 → 平躺 → 归零前 0.2s 爬起，倾角按包络系数过渡。
      if (u.downT > 0) {
        const f = Math.min(1, Math.min(u.downT, FIRE_DOWN_TIME - u.downT) / 0.2);
        g.rotation.z = f * 1.4;
      } else if (moving && u.kind !== "boat" && u.kind !== "dragon") {
        // v0.40 行走左右晃（倒地分支拥有 rotation.z 时不动，静止回零）。
        g.rotation.z = Math.sin(this.t * 11 + u.phase) * 0.055;
      } else if (g.rotation.z !== 0) {
        g.rotation.z = 0;
      }
      // v0.30 大龙：拍翅 + 地面影子（影子随对地高度缩放，制造"悬在半空"的读感）。
      if (u.kind === "dragon") {
        const flap = Math.sin(this.t * 6 + u.phase) * 0.55;
        const wl = g.getObjectByName("wingL");
        const wr = g.getObjectByName("wingR");
        if (wl) wl.rotation.z = flap;
        if (wr) wr.rotation.z = -flap;
        const gy = this.world.heightAt(u.x, u.z);
        const shadow = g.getObjectByName("shadow");
        if (shadow) {
          shadow.position.y = gy - (u.y + bob) + 0.04;
          const k = THREE.MathUtils.clamp(1.25 - (u.y - gy) * 0.16, 0.55, 1.15);
          shadow.scale.setScalar(k);
        }
      }
      // v0.40 挥砍（武士）：atkCd 从满值回落的前 0.35s 播下劈→回位（与 combat 落刀同沿，无沿检测，丢帧也自洽）。
      if (u.kind === "warrior") {
        const arm = g.getObjectByName("swordArm");
        if (arm) {
          const since = attackInterval("warrior") - u.atkCd;
          if (u.atkCd > 0 && since >= 0 && since < 0.35) {
            const f = 1 - (1 - since / 0.35) ** 3; // easeOut：落刀位→回正
            arm.rotation.x = 0.9 * (1 - f);
          } else if (arm.rotation.x !== 0) {
            arm.rotation.x = 0;
          }
        }
      }
      // v0.40 蓄力喷射（牛战士）：开火前 0.6s 双手聚气放大，开火瞬间 muzzle 闪＋后座。
      if (u.kind === "firewarrior") {
        const iv = attackInterval("firewarrior");
        const since = iv - u.atkCd;
        const charging = u.atkCd > 0 && u.atkCd < 0.6 && u.atkId !== 0;
        for (const n of ["handL", "handR"] as const) {
          const h = g.getObjectByName(n);
          if (h) h.scale.setScalar(charging ? 1 + 0.45 * (1 - u.atkCd / 0.6) : 1);
        }
        const muzzle = g.getObjectByName("muzzle") as THREE.Mesh | undefined;
        if (muzzle) {
          const fired = u.atkCd > 0 && since >= 0 && since < 0.12;
          muzzle.visible = fired;
          if (fired) {
            const s = 0.8 + Math.random() * 0.5;
            muzzle.scale.set(s, s, s);
          }
        }
        if (u.atkCd > 0 && since >= 0 && since < 0.18) g.rotation.x -= 0.12; // 后座（lean 之后叠）
      }
      // v0.40 修理（村民）：job repair 即亮锤子；贴到建筑边（3 格内）按节律敲打，路上垂着。
      if (u.kind === "walker") {
        const hammer = g.getObjectByName("hammer");
        if (hammer) {
          const onDuty = u.job === "repair";
          hammer.visible = onDuty;
          if (onDuty) {
            const site = sim.buildingById(u.targetId);
            const near = !!site && (u.x - site.x) ** 2 + (u.z - site.z) ** 2 < 9;
            hammer.rotation.x = near ? Math.sin(this.t * 10 + u.phase) * 0.7 - 0.3 : 0.35;
          }
        }
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
        this.unitTrail.delete(id); // v0.40 行走推导缓存同步清理
        this.unitMeshes.delete(id);
        this.sinkingBoats.delete(id); // v0.32 沉船被 cull 带走后清本地计时
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

    // v0.40 独立废墟：破损瞬间按种类换残骸造型（同地基 footprint，碰撞/寻路零影响；
    // 修好切回完整模型由 syncHouses 的 shell 变化重建覆盖）。
    if (shell && level >= 1) {
      return this.makeRuin(g, team, kind, teamMat);
    }

    if (level <= 0) {
      // v0.40 地基分级：土垫与脚手架按建筑占地缩放（sim 侧 sitePad 早已分级，视觉此前统一 2.5）。
      // 小（哨塔 0.6）/ 中（茅屋 1.3）/ 大（训练营·船屋 2.6）/ 特大（龙厂 3.2），土垫各外放大一圈。
      const span = kind === "tower" ? 0.85 : kind === "hut" ? 1.5 : kind === "dragonFactory" ? 3.35 : 2.75;
      const dirt = new THREE.MeshLambertMaterial({ color: 0x6a5530 });
      const log = new THREE.MeshLambertMaterial({ color: 0x8a5a28 });
      this.box(g, span, 0.07, span, dirt, 0, 0.035, 0);
      // v0.28i 渐进式建造：四角脚手架独立成组，syncHouses 每帧按 built/need 抬升 scale.y。
      const scaffold = new THREE.Group();
      scaffold.name = "scaffold";
      const c = span / 2 - 0.15;
      const rail = span - 0.4;
      for (const [x, z] of [
        [-c, -c],
        [c, -c],
        [-c, c],
        [c, c],
      ] as const) {
        this.box(scaffold, 0.08, 1.0, 0.08, log, x, 0.5, z);
      }
      this.box(scaffold, rail, 0.07, 0.07, log, 0, 0.96, -c);
      this.box(scaffold, rail, 0.07, 0.07, log, 0, 0.96, c);
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

    if (kind === "dragonFactory") {
      // v0.30 大龙训练营：工厂风格大厂房——宽体厂房 + 双烟囱 + 大门 + 队色旗，高 ~1.9。
      const wall = new THREE.MeshLambertMaterial({ color: 0x5a5450 });
      const roof = new THREE.MeshLambertMaterial({ color: 0x3a3634 });
      const stack = new THREE.MeshLambertMaterial({ color: 0x7a4432 });
      const glow = new THREE.MeshBasicMaterial({ color: 0xff8830 });
      this.box(g, 3.0, 1.1, 2.4, wall, 0, 0.55, 0);
      this.box(g, 3.1, 0.16, 2.5, roof, 0, 1.18, 0);
      // 双烟囱（顶部火光 = 厂房在"炼制"的读感）
      this.box(g, 0.34, 1.0, 0.34, stack, -0.9, 1.7, -0.6);
      this.box(g, 0.34, 0.8, 0.34, stack, 0.7, 1.6, -0.75);
      this.box(g, 0.24, 0.1, 0.24, glow, -0.9, 2.22, -0.6);
      this.box(g, 0.24, 0.1, 0.24, glow, 0.7, 2.02, -0.75);
      // 大门 + 侧窗
      this.box(g, 0.7, 0.8, 0.1, new THREE.MeshLambertMaterial({ color: 0x2a2018 }), 0, 0.4, 1.22);
      this.box(g, 0.3, 0.3, 0.08, glow, -1.05, 0.62, 1.21);
      this.box(g, 0.3, 0.3, 0.08, glow, 1.05, 0.62, 1.21);
      // 队色旗
      this.box(g, 0.07, 0.7, 0.07, new THREE.MeshLambertMaterial({ color: 0x6a4a28 }), 1.35, 1.5, 1.05);
      this.box(g, 0.34, 0.22, 0.04, teamMat, 1.53, 1.74, 1.05);
      return g;
    }

    if (kind === "boathouse") {
      // v0.32 船屋：高脚工作台＋后舱＋前伸码头（工作甲板面 0.6＝BOATHOUSE_DECK_Y，住户站位见 arrangeDwellers）。
      const wood = new THREE.MeshLambertMaterial({ color: 0x6a4a28 });
      const wall = new THREE.MeshLambertMaterial({ color: team === 0 ? 0x8a6a40 : 0x7a4a32 });
      const thatch = new THREE.MeshLambertMaterial({ color: 0xc4a44a });
      for (const [x, z] of [
        [0.9, 0.9],
        [-0.9, 0.9],
        [0.9, -0.9],
        [-0.9, -0.9],
      ] as const) {
        this.box(g, 0.14, 0.6, 0.14, wood, x, 0.3, z); // 高脚柱
      }
      this.box(g, 2.2, 0.1, 2.2, wood, 0, 0.55, 0); // 工作甲板（面 0.6）
      this.box(g, 1.4, 0.8, 1.2, wall, 0, 1.0, -0.4); // 后舱
      this.box(g, 1.6, 0.15, 1.4, thatch, 0, 1.48, -0.4); // 茅草顶
      this.box(g, 0.3, 0.06, 1.4, wood, -0.35, 0.5, 1.6); // 码头 plank×2（朝水一侧前伸）
      this.box(g, 0.3, 0.06, 1.4, wood, 0.35, 0.5, 1.6);
      this.box(g, 0.07, 0.7, 0.07, wood, 1.0, 1.0, -0.9); // 队色旗杆＋旗
      this.box(g, 0.34, 0.22, 0.04, teamMat, 1.18, 1.24, -0.9);
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

  /**
   * v0.40 独立废墟：八种建筑各一套残骸造型。共同约束：① 不超出原地基 footprint
   * （寻路/碰撞/占位零影响）；② 保留一处队色残片（远处可辨阵营）；③ 全静态，
   * 破损瞬间的撒点特效沿用既有 spawnWreck。
   */
  makeRuin(g: THREE.Group, team: Team, kind: string, teamMat: THREE.Material): THREE.Group {
    const char = new THREE.MeshLambertMaterial({ color: 0x2e2118 });
    const wood = new THREE.MeshLambertMaterial({ color: 0x6a4a22 });
    const stone = new THREE.MeshLambertMaterial({ color: 0x7a756a });
    if (kind === "hut") {
      // 茅屋：塌茅草（两块斜顶板）＋两根断柱＋ Cold 灶石圈。
      this.box(g, 1.0, 0.06, 1.0, char, 0, 0.03, 0);
      const r1 = this.box(g, 0.9, 0.08, 0.6, wood, -0.1, 0.28, 0.1);
      r1.rotation.z = 0.28;
      const r2 = this.box(g, 0.9, 0.08, 0.6, wood, 0.12, 0.22, -0.12);
      r2.rotation.z = -0.22;
      r2.rotation.y = 0.4;
      this.box(g, 0.12, 0.7, 0.12, wood, -0.4, 0.35, -0.4);
      const stump = this.box(g, 0.12, 0.35, 0.12, char, 0.42, 0.17, 0.38);
      stump.rotation.z = -0.15;
      for (let i = 0; i < 5; i++) {
        const a = (i / 5) * Math.PI * 2;
        this.box(g, 0.12, 0.1, 0.12, stone, Math.cos(a) * 0.3, 0.05, Math.sin(a) * 0.3);
      }
      this.box(g, 0.2, 0.16, 0.05, teamMat, 0, 0.12, 0.53);
      return g;
    }
    if (kind === "warriorHut") {
      // 武士营：折断的栅栏环＋倒下的兵器架＋断旗杆。
      this.box(g, 2.2, 0.06, 2.2, char, 0, 0.03, 0);
      for (let i = 0; i < 6; i++) {
        const a = (i / 6) * Math.PI * 2 + 0.2;
        const px = Math.cos(a) * 1.0;
        const pz = Math.sin(a) * 1.0;
        const h = i % 2 === 0 ? 0.7 : 0.35;
        const p = this.box(g, 0.12, h, 0.12, wood, px, h / 2, pz);
        if (i % 2 === 1) p.rotation.x = 0.3;
      }
      const rack = this.box(g, 0.08, 1.1, 0.08, wood, 0.3, 0.3, 0.2);
      rack.rotation.z = 1.25;
      this.box(g, 0.08, 0.5, 0.08, stone, 0.75, 0.25, -0.3);
      this.box(g, 0.5, 0.2, 0.05, teamMat, -0.5, 0.12, 0.6);
      return g;
    }
    if (kind === "temple") {
      // 神庙：两根卧倒的断柱＋裂开的祭坛＋滚落的金球。
      this.box(g, 2.3, 0.06, 2.3, char, 0, 0.03, 0);
      const c1 = this.box(g, 0.3, 0.3, 1.6, stone, -0.4, 0.18, 0.2);
      c1.rotation.y = 0.35;
      const c2 = this.box(g, 0.3, 0.3, 1.1, stone, 0.55, 0.18, -0.4);
      c2.rotation.y = -0.5;
      this.box(g, 0.9, 0.25, 0.9, stone, 0, 0.16, 0.1);
      const crack = this.box(g, 0.94, 0.26, 0.12, char, 0, 0.16, 0.1);
      crack.rotation.y = 0.5;
      this.box(g, 0.22, 0.22, 0.22, new THREE.MeshLambertMaterial({ color: 0xc9a227 }), 0.85, 0.11, 0.75);
      this.box(g, 0.4, 0.3, 0.06, teamMat, -0.7, 0.15, 0.9);
      return g;
    }
    if (kind === "fireHut") {
      // 火营：劈开的窑膛（半穹＋碎石）＋熄火的烟囱（火光灭）。
      this.box(g, 2.2, 0.06, 2.2, char, 0, 0.03, 0);
      const dome = this.box(g, 1.4, 0.5, 1.2, new THREE.MeshLambertMaterial({ color: 0x7a4a32 }), -0.2, 0.25, 0);
      dome.rotation.z = 0.18;
      this.box(g, 0.7, 0.35, 0.6, char, 0.55, 0.17, 0.15);
      this.box(g, 0.3, 0.3, 0.3, stone, -0.85, 0.15, 0.7);
      this.box(g, 0.25, 0.25, 0.25, stone, 0.9, 0.12, -0.6);
      const stack = this.box(g, 0.3, 0.7, 0.3, stone, 0.2, 0.3, -0.75);
      stack.rotation.x = 0.9;
      this.box(g, 0.3, 0.4, 0.06, teamMat, -0.9, 0.2, -0.5);
      return g;
    }
    if (kind === "spyHut") {
      // 间谍营：塌落的帐篷（两块相抵的斜板）＋折断的桅杆＋散落的黑布。
      this.box(g, 2.0, 0.06, 2.0, char, 0, 0.03, 0);
      const t1 = this.box(g, 1.6, 0.07, 1.2, new THREE.MeshLambertMaterial({ color: 0x2a2a30 }), -0.25, 0.4, 0);
      t1.rotation.z = 0.5;
      const t2 = this.box(g, 1.6, 0.07, 1.2, new THREE.MeshLambertMaterial({ color: 0x34343c }), 0.3, 0.38, 0.1);
      t2.rotation.z = -0.45;
      const mast = this.box(g, 0.07, 1.0, 0.07, wood, 0.7, 0.25, -0.5);
      mast.rotation.z = 1.1;
      this.box(g, 0.5, 0.08, 0.4, new THREE.MeshLambertMaterial({ color: 0x1a1a1e }), -0.6, 0.06, 0.7);
      this.box(g, 0.35, 0.25, 0.05, teamMat, 0.1, 0.14, 0.95);
      return g;
    }
    if (kind === "tower") {
      // 哨塔：1 米的断柱茬＋倚柱的瞭望台碎板＋折断的塔尖（碎石不出柱基一圈，倒塌感靠斜板给）。
      this.box(g, 0.7, 0.06, 0.7, char, 0, 0.03, 0);
      this.box(g, 0.5, 0.9, 0.5, stone, 0, 0.51, 0);
      this.box(g, 0.56, 0.18, 0.56, stone, 0.03, 1.0, -0.02);
      const deck = this.box(g, 0.85, 0.1, 0.85, stone, 0.3, 0.45, 0);
      deck.rotation.z = 1.0;
      const tip = new THREE.Mesh(new THREE.ConeGeometry(0.3, 0.45, 4), teamMat);
      tip.position.set(0.15, 0.12, 0.4);
      tip.rotation.set(1.35, Math.PI / 4, 0);
      g.add(tip);
      this.box(g, 0.24, 0.4, 0.06, wood, 0.1, 0.2, 0.42);
      this.box(g, 0.16, 0.14, 0.16, stone, -0.35, 0.07, 0.3);
      return g;
    }
    if (kind === "dragonFactory") {
      // 龙厂：拧转的框架梁＋坍落的烟囱＋散落的甲板。
      this.box(g, 3.0, 0.06, 2.4, char, 0, 0.03, 0);
      const b1 = this.box(g, 2.6, 0.18, 0.18, wood, -0.1, 0.5, 0.6);
      b1.rotation.z = 0.22;
      b1.rotation.y = 0.15;
      const b2 = this.box(g, 0.18, 0.18, 2.2, wood, 0.8, 0.4, -0.2);
      b2.rotation.x = -0.18;
      this.box(g, 1.2, 0.5, 1.0, new THREE.MeshLambertMaterial({ color: 0x5a5450 }), -0.6, 0.25, -0.4);
      const stack = this.box(g, 0.34, 0.8, 0.34, new THREE.MeshLambertMaterial({ color: 0x7a4432 }), 0.9, 0.25, -0.7);
      stack.rotation.z = 1.2;
      this.box(g, 0.8, 0.12, 0.6, new THREE.MeshLambertMaterial({ color: 0x3a3634 }), -0.2, 0.1, 0.9);
      this.box(g, 0.4, 0.25, 0.05, teamMat, 1.2, 0.15, 0.9);
      return g;
    }
    if (kind === "boathouse") {
      // 船屋：断成两截的船体（前后错开）＋歪斜的码头板＋倒下的旗杆。
      this.box(g, 2.2, 0.06, 2.6, char, 0, 0.03, 0);
      const hull = new THREE.MeshLambertMaterial({ color: 0x6a4a28 });
      const h1 = this.box(g, 0.7, 0.22, 0.9, hull, -0.25, 0.16, -0.6);
      h1.rotation.y = 0.3;
      const h2 = this.box(g, 0.7, 0.22, 0.8, hull, 0.3, 0.16, 0.65);
      h2.rotation.y = -0.35;
      const plank = this.box(g, 0.3, 0.06, 1.4, hull, -0.35, 0.12, 1.55);
      plank.rotation.y = 0.25;
      this.box(g, 0.5, 0.4, 0.5, wood, 0.5, 0.2, -0.5);
      const pole = this.box(g, 0.06, 0.8, 0.06, hull, -0.8, 0.2, 0.9);
      pole.rotation.z = 1.3;
      this.box(g, 0.3, 0.18, 0.04, teamMat, -0.35, 0.1, 1.15);
      return g;
    }
    // 重生点：裂开的石环（缺口＋倾倒的石块）＋熄灭的中央法阵。
    for (let i = 0; i < 8; i++) {
      if (i === 2) continue; // 缺口：被拆掉的那块
      const a = (i / 8) * Math.PI * 2;
      const tilt = i === 3 || i === 6 ? 0.35 : 0;
      const s = this.box(g, 0.28, i === 3 || i === 6 ? 0.5 : 0.9, 0.18, stone, Math.cos(a) * 1.3, 0.45, Math.sin(a) * 1.3);
      if (tilt) s.rotation.x = tilt;
    }
    this.box(g, 0.28, 0.5, 0.18, stone, 1.05, 0.2, 0.75); // 被拍进环内的断石
    this.box(g, 1.4, 0.05, 1.4, char, 0, 0.03, 0);
    this.box(g, 0.4, 0.12, 0.12, teamMat, 0, 0.08, 1.15);
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
      // v0.32 船屋生产条：住满开工即显示（住户条走 syncDwellPips 船屋分支，见下）。
      const isBoat = b.kind === "boathouse" && b.team === BLUE && b.hp > 0 && b.level >= 1 && b.dwell >= BOATHOUSE_DWELL;
      const isHut = b.kind === "hut" && b.team === BLUE && b.hp > 0 && b.level >= 1;
      if (!isHut && !isBoat) continue;
      if (isHut && (b.dwell <= 0 || b.dwell >= houseMaxPop(b.level))) continue;
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

  /**
   * v0.30 大龙训练营双进度条：上方进驻条（dwell/20 + 20 格刻度，进驻即显示），
   * 满 20 后下方出现生产条（prod 0..1）——对应"先进驻满格、再开工生产"的读法。
   */
  syncDragonBars(sim: SimClient): void {
    const live = new Set<number>();
    for (const b of sim.buildings) {
      if (b.kind !== "dragonFactory" || b.team !== BLUE || b.hp <= 0 || b.level < 1) continue;
      live.add(b.id);
      let g = this.dragonGarrisonBars.get(b.id);
      if (!g) {
        g = this.makeTrainBar();
        this.dragonGarrisonBars.set(b.id, g);
        this.dragonBarGroup.add(g);
      }
      g.visible = b.dwell > 0;
      if (g.visible) {
        const t = clamp(b.dwell / DRAGON_GARRISON_MAX, 0, 1);
        g.position.set(b.x, b.y + 2.5, b.z);
        const dx = this.camera.position.x - g.position.x;
        const dz = this.camera.position.z - g.position.z;
        g.rotation.y = Math.atan2(dx, dz);
        const fill = g.getObjectByName("fill") as THREE.Mesh;
        fill.scale.x = Math.max(0.001, t);
        fill.position.x = (t - 1) * 0.6;
        const marks = g.getObjectByName("marks") as THREE.Group;
        while (marks.children.length > DRAGON_GARRISON_MAX) marks.remove(marks.children[marks.children.length - 1]!);
        while (marks.children.length < DRAGON_GARRISON_MAX) {
          marks.add(new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.09, 0.09), this.trainBarMarkMat));
        }
        for (let i = 0; i < marks.children.length; i++) {
          marks.children[i]!.position.set(-0.6 + ((i + 0.5) / DRAGON_GARRISON_MAX) * 1.2, 0, 0.1);
        }
      }
      let p = this.dragonProdBars.get(b.id);
      if (!p) {
        p = this.makeProdBar();
        this.dragonProdBars.set(b.id, p);
        this.dragonBarGroup.add(p);
      }
      const producing = b.dwell >= DRAGON_GARRISON_MAX;
      p.visible = producing;
      if (producing) {
        const t = clamp(b.prod, 0, 1);
        p.position.set(b.x, b.y + 2.14, b.z);
        const dx = this.camera.position.x - p.position.x;
        const dz = this.camera.position.z - p.position.z;
        p.rotation.y = Math.atan2(dx, dz);
        const fill = p.getObjectByName("fill") as THREE.Mesh;
        fill.scale.x = Math.max(0.001, t);
        fill.position.x = (t - 1) * 0.6;
      }
    }
    for (const [id, g] of this.dragonGarrisonBars) {
      if (!live.has(id)) {
        this.dragonBarGroup.remove(g);
        this.dragonGarrisonBars.delete(id);
      }
    }
    for (const [id, g] of this.dragonProdBars) {
      if (!live.has(id)) {
        this.dragonBarGroup.remove(g);
        this.dragonProdBars.delete(id);
      }
    }
  }

  makeRoofIcon(): THREE.Group {    const g = new THREE.Group();
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
      // v0.32 船屋住户条：住满 10 开工一眼可见（与茅屋同构，maxPop 走船屋档）。
      const isBoat = b.kind === "boathouse" && b.hp > 0 && b.level >= 1 && b.dwell > 0;
      const isHut = b.kind === "hut" && b.hp > 0 && b.level >= 1 && b.dwell > 0;
      if (!isHut && !isBoat) continue;
      live.add(b.id);
      const maxPop = isBoat ? BOATHOUSE_DWELL : houseMaxPop(b.level);
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
      const roofY = isBoat ? 2.0 : b.level >= 3 ? 2.0 : b.level === 2 ? 1.6 : 1.22;
      const front = isBoat ? 1.5 : 1.02; // v0.11a：占地恒定后门面位置不随等级变化
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
