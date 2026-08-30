// v0.29c-1 Sim Worker 编解码器（纯函数，零 DOM/Worker 依赖，Node 可测）。
// 职责：
// - encodeWorld / encodeSnapshot：把真 Sim 的**数据字段**投影成 protocol 消息（typed arrays +
//   普通对象），worker 端 postMessage 时按 transferOf 走零拷贝 transfer；
// - applyWorld / applySnapshot：把消息应用到镜像状态 SimMirror。镜像实体用
//   Object.create(相关类.prototype) + 赋字段的方式造（**不跑构造函数**：Unit/Building 是带
//   默认值的 class，直接 new 会带错默认值且 BaseEntity 构造器要参数；类型断言成对应类，
//   语义是"仅数据镜像"，方法可调用、字段可读，但 mirror 永远不写回 sim）；
// - terrainTouched：地形置脏判定的纯函数（worker 每 tick 调）。
// 精度口径：units 走 Float32Array 载体，位置/血量等有 ≤1e-4 的 f32 截断（渲染无感），
// 镜像不承诺 bit-exact；其余字段是 structured clone 的原值，逐字段相等。
import { World } from "../world";
import type { Pad, StartPad, TreeBlock } from "../world";
import type { SmoothReport } from "../map-smoother";
import type { FeatureStat } from "../world-gen/terrain-features";
import {
  Building,
  FireHut,
  Firewarrior,
  Hut,
  Preacher,
  Rebirth,
  Shaman,
  Spy,
  SpyHut,
  Temple,
  Tower,
  Tree,
  Unit,
  Walker,
  Warrior,
  WarriorHut,
  Wildman,
} from "../entities";
import {
  BuildingKind,
  FxBolt,
  Job,
  Owner,
  Projectile,
  SAMPLES,
  Team,
  TeamState,
  TRAIN_FOR_CAMP,
  TrainKind,
  UnitKind,
} from "../types";
import type { Sim } from "../sim";
import type {
  BlastSnap,
  BuildingSnap,
  GuardFireSnap,
  MeteorSnap,
  QuakeSnap,
  SnapMsg,
  TerrainMsg,
  TornadoSnap,
  TreeSnap,
  VolcanoSnap,
  WorldMsg,
  WorkerMsg,
} from "./protocol";

// ---------------------------------------------------------------------------
// 索引表（SoA 的 kind/team/job/trainKind 全部按序号传输——跨端映射必须稳定，
// 只许往数组**末尾**追加新值，不许插入/重排）。
// ---------------------------------------------------------------------------

export const UNIT_KINDS: readonly UnitKind[] = [
  "shaman",
  "walker",
  "warrior",
  "preacher",
  "firewarrior",
  "spy",
  "wildman",
];
export const JOBS: readonly Job[] = ["idle", "chop", "haul", "train", "move"];
export const TRAIN_KINDS: readonly TrainKind[] = ["warrior", "preacher", "firewarrior", "spy"];
const DISGUISE_NONE = 255;
const TRAIN_NONE = 255;
/** flags 位定义。 */
const FLAG_CARRY = 1;

/**
 * Unit 的 Float32 槽位（每单位 UF_N 个）。字段集 = 主线程读面（grep 依据见各槽位注释）：
 * render.syncUnits（id/team/kind/disguise/phase/x/y/z/yaw/downT/carry/fireT/burnT/homeId/enterT）、
 * render.syncTrainBars（channel）、ui.drawMini（homeId/team/x/z）、game.ts（hp/atkId）、
 * shot-director（job 经 u8、think/pathI/targetId/atkId/maxHp/swampT/flyVx/Vy/Vz/trainKind）。
 * selected **不传**——选择集主线程自治（v0.29c 设计）。path 不传数组只传 pathLen
 *（主线程对 path 的读只有 length 判据，写 path 的摆拍流由 C2 重设计为命令）。
 */
export const UF = {
  id: 0,
  x: 1,
  y: 2,
  z: 3,
  yaw: 4,
  hp: 5,
  maxHp: 6,
  phase: 7,
  think: 8,
  channel: 9,
  downT: 10,
  fireT: 11,
  burnT: 12,
  burnDps: 13,
  enterT: 14,
  swampT: 15,
  flyVx: 16,
  flyVy: 17,
  flyVz: 18,
  pathI: 19,
  targetId: 20,
  atkId: 21,
  homeId: 22,
  pathLen: 23,
  str: 24,
  /** v0.29c-2 训练排队序号（trainQueue 按 channelId 排序，镜像上复刻训练队列渲染要读）。 */
  channelId: 25,
} as const;
export const UF_N = 26;

/** Unit 的 Uint8 槽位（枚举型字段）。 */
export const UU = {
  kind: 0,
  team: 1,
  disguise: 2,
  job: 3,
  trainKind: 4,
  flags: 5,
} as const;
export const UU_N = 6;

// ---------------------------------------------------------------------------
// 镜像实体工厂：Object.create(类.prototype) + 默认值表（默认值必须与 entities/ 的
// class 字段初始化器逐一对应；数组/对象默认值每实例单独建，防共享引用）。
// ---------------------------------------------------------------------------

const UNIT_PROTOS: Record<UnitKind, object> = {
  shaman: Shaman.prototype,
  walker: Walker.prototype,
  warrior: Warrior.prototype,
  preacher: Preacher.prototype,
  firewarrior: Firewarrior.prototype,
  spy: Spy.prototype,
  wildman: Wildman.prototype,
};

const BUILDING_PROTOS: Record<BuildingKind, object> = {
  hut: Hut.prototype,
  warriorHut: WarriorHut.prototype,
  temple: Temple.prototype,
  fireHut: FireHut.prototype,
  spyHut: SpyHut.prototype,
  tower: Tower.prototype,
  rebirth: Rebirth.prototype,
};

/** 与 entities/unit.ts 的字段初始化器对齐（BaseEntity 的 id/team/x/z/y/hp/maxHp 由消息赋）。 */
const UNIT_DEFAULTS: Record<string, unknown> = {
  yaw: 0,
  str: 1,
  order: "settle",
  // path 每实例重建（makeMirrorUnit），这里不设；pathLen 是镜像专有字段（path 数组不跨线程传）。
  pathI: 0,
  think: 0,
  atkCd: 0,
  selected: false,
  phase: 0,
  settleT: 0,
  settleX: -1,
  settleZ: -1,
  settleYaw: 0,
  moveX: -1,
  moveZ: -1,
  ghostT: 0,
  channel: 0,
  channelId: 0,
  disguise: null,
  carry: 0 as 0 | 1,
  job: "idle",
  targetId: 0,
  atkId: 0,
  homeId: 0,
  trainKind: null,
  foundKind: null,
  swampT: 0,
  fireT: 0,
  burnT: 0,
  burnDps: 0,
  flyVx: 0,
  flyVz: 0,
  flyVy: 0,
  enterT: 0,
  agroX: -1,
  agroZ: -1,
  flyDmg: 0,
  downT: 0,
  downDmg: 0,
  flyKill: false,
  buildId: 0,
  climbX: 0,
  climbY: 0,
  climbZ: 0,
};

/** 与 entities/building.ts 的字段初始化器对齐。 */
const BUILDING_DEFAULTS: Record<string, unknown> = {
  yaw: 0,
  padW: 0,
  padD: 0,
  level: 0,
  prod: 0,
  wood: 0,
  need: 0,
  built: 0,
  shell: false,
  dwell: 0,
  born: 0,
  wantLevel: 0,
};

/** 仅数据镜像的 Unit：不跑构造函数（Object.create + 默认值表 + 消息字段）。 */
function makeMirrorUnit(kind: UnitKind): Unit {
  const u = Object.create(UNIT_PROTOS[kind]) as unknown as Unit;
  Object.assign(u, UNIT_DEFAULTS);
  u.path = []; // 数组默认值必须每实例独立
  // pathLen 是镜像专有的附加字段（真 Unit 没有；主线程对 u.path 的读只有 length 判据）。
  (u as unknown as { pathLen: number }).pathLen = 0;
  u.kind = kind;
  return u;
}

/** 仅数据镜像的 Building：训练营补 trainKind（TrainingCamp 的 readonly 字段初始化器等价物）。 */
function makeMirrorBuilding(snap: BuildingSnap): Building {
  const b = Object.create(BUILDING_PROTOS[snap.kind]) as unknown as Building;
  Object.assign(b, BUILDING_DEFAULTS);
  Object.assign(b, snap); // 全部消息字段（id/team/x/y/z/hp/...，含 readonly 的 kind）
  const tk = TRAIN_FOR_CAMP[snap.kind];
  if (tk) (b as unknown as { trainKind: TrainKind }).trainKind = tk;
  return b;
}

/** 仅数据镜像的 Tree。 */
function makeMirrorTree(snap: TreeSnap): Tree {
  const t = Object.create(Tree.prototype) as unknown as Tree;
  t.id = snap.id;
  t.x = snap.x;
  t.z = snap.z;
  t.y = snap.y;
  t.alive = snap.alive;
  t.regen = snap.regen;
  return t;
}

// ---------------------------------------------------------------------------
// 镜像状态容器
// ---------------------------------------------------------------------------

/**
 * SimMirror：主线程侧的 sim 纯数据镜像（v0.29c-2 由镜像客户端包装成 SimClient）。
 * units 按 id 复用对象原地更新（unitsById 为 codec 内部索引）；消失单位从两个集合同时删除。
 */
export interface SimMirror {
  /** 仅数据镜像的 World（Object.create(World.prototype)，heightAt/sampleAt/walkableAt 等纯数据方法可用；setSample/mark* 一律禁止——地形更新走消息）。 */
  world: World;
  units: Unit[];
  buildings: Building[];
  trees: Tree[];
  shots: Projectile[];
  meteors: MeteorSnap[];
  guardFires: GuardFireSnap[];
  teams: [TeamState, TeamState];
  volcano: VolcanoSnap | null;
  quake: QuakeSnap | null;
  tornado: TornadoSnap | null;
  blast: BlastSnap | null;
  blastFlyer: { x: number; y: number; z: number } | null;
  swampKill: boolean;
  swampKillX: number;
  swampKillZ: number;
  tornadoLift: boolean;
  tornadoLiftX: number;
  tornadoLiftZ: number;
  tornadoHouse: boolean;
  stuckWatch: Map<number, { x: number; z: number; t: number }>;
  time: number;
  winner: Team | -1 | null;
  logs: string[];
  toastGen: number;
  armageddon: boolean;
  review: boolean;
  freezeProd: boolean;
  lockWin: boolean;
  fxBolts: FxBolt[];
  fxShake: number;
  fxQuake: { x: number; z: number } | null;
  fxVolcano: { x: number; z: number } | null;
  fxSplash: { x: number; z: number }[];
  /** codec 内部：id → 镜像单元（复用与删除判定）。 */
  unitsById: Map<number, Unit>;
}

/** 建一个全空的镜像（world 的数据字段置零但方法可用；等第一条 world 消息填充）。 */
export function createSimMirror(): SimMirror {
  const n = SAMPLES * SAMPLES;
  // 仅数据镜像的 World：补齐 World 的私有脏区簿记字段（takeDirtyWindow/clearDirtyWindow 可用，
  // mirror 只读不写地形，mark* 永远不会被 mirror 自己触发）。
  const world = Object.create(World.prototype) as unknown as World;
  Object.assign(world, {
    h: new Float32Array(n),
    fmask: new Uint8Array(n),
    lava: new Float32Array(n),
    scorch: new Float32Array(n),
    swamp: new Float32Array(n),
    pads: [] as Pad[],
    trees: [] as TreeBlock[],
    dirty: true,
    dirtyAll: true,
    dirtyMinX: 0,
    dirtyMinZ: 0,
    dirtyMaxX: SAMPLES - 1,
    dirtyMaxZ: SAMPLES - 1,
    hasWindow: true,
    lavaScratch: null,
    paintCells: [] as number[],
    geomCells: [] as number[],
    paintAlt: [] as number[],
    geomAlt: [] as number[],
    paintMark: new Uint32Array(n),
    geomMark: new Uint32Array(n),
    epoch: 1,
    rng: null,
    starts: [
      { x: 0, z: 0, yaw: 0, h: 0 },
      { x: 0, z: 0, yaw: 0, h: 0 },
    ] as [StartPad, StartPad],
    lastSwampX: 0,
    lastSwampZ: 0,
    genSeed: 0,
    smoothReport: null as SmoothReport | null,
    templateId: "",
    templateName: "",
    fordCount: 0,
    genFeatures: [] as FeatureStat[],
    lastRiverTips: [],
    lastRiverCells: [],
  });
  return {
    world,
    units: [],
    buildings: [],
    trees: [],
    shots: [],
    meteors: [],
    guardFires: [],
    teams: [
      {
        manaCap: 0,
        charges: {},
        order: "settle",
        magnetX: 0,
        magnetZ: 0,
        hasShaman: false,
        shamanRevive: 0,
        wanted: [],
      },
      {
        manaCap: 0,
        charges: {},
        order: "settle",
        magnetX: 0,
        magnetZ: 0,
        hasShaman: false,
        shamanRevive: 0,
        wanted: [],
      },
    ],
    volcano: null,
    quake: null,
    tornado: null,
    blast: null,
    blastFlyer: null,
    swampKill: false,
    swampKillX: 0,
    swampKillZ: 0,
    tornadoLift: false,
    tornadoLiftX: 0,
    tornadoLiftZ: 0,
    tornadoHouse: false,
    stuckWatch: new Map(),
    time: 0,
    winner: null,
    logs: [],
    toastGen: 0,
    armageddon: false,
    review: false,
    freezeProd: false,
    lockWin: false,
    fxBolts: [],
    fxShake: 0,
    fxQuake: null,
    fxVolcano: null,
    fxSplash: [],
    unitsById: new Map(),
  };
}

// ---------------------------------------------------------------------------
// 编码
// ---------------------------------------------------------------------------

/** Unit 列表 → SoA（f32 数值面 + u8 枚举面）。两个数组的 buffer 可直接进 transfer list。 */
export function encodeUnitSoA(units: Unit[]): { f32: Float32Array; u8: Uint8Array } {
  const n = units.length;
  const f32 = new Float32Array(n * UF_N);
  const u8 = new Uint8Array(n * UU_N);
  const kindIdx = new Map<UnitKind, number>(UNIT_KINDS.map((k, i) => [k, i]));
  const jobIdx = new Map<Job, number>(JOBS.map((k, i) => [k, i]));
  const trainIdx = new Map<TrainKind, number>(TRAIN_KINDS.map((k, i) => [k, i]));
  for (let i = 0; i < n; i++) {
    const u = units[i]!;
    const fo = i * UF_N;
    const uo = i * UU_N;
    f32[fo + UF.id] = u.id;
    f32[fo + UF.x] = u.x;
    f32[fo + UF.y] = u.y;
    f32[fo + UF.z] = u.z;
    f32[fo + UF.yaw] = u.yaw;
    f32[fo + UF.hp] = u.hp;
    f32[fo + UF.maxHp] = u.maxHp;
    f32[fo + UF.phase] = u.phase;
    f32[fo + UF.think] = u.think;
    f32[fo + UF.channel] = u.channel;
    f32[fo + UF.downT] = u.downT;
    f32[fo + UF.fireT] = u.fireT;
    f32[fo + UF.burnT] = u.burnT;
    f32[fo + UF.burnDps] = u.burnDps;
    f32[fo + UF.enterT] = u.enterT;
    f32[fo + UF.swampT] = u.swampT;
    f32[fo + UF.flyVx] = u.flyVx;
    f32[fo + UF.flyVy] = u.flyVy;
    f32[fo + UF.flyVz] = u.flyVz;
    f32[fo + UF.pathI] = u.pathI;
    f32[fo + UF.targetId] = u.targetId;
    f32[fo + UF.atkId] = u.atkId;
    f32[fo + UF.homeId] = u.homeId;
    f32[fo + UF.pathLen] = u.path.length;
    f32[fo + UF.str] = u.str;
    f32[fo + UF.channelId] = u.channelId;
    u8[uo + UU.kind] = kindIdx.get(u.kind)!;
    u8[uo + UU.team] = u.team;
    u8[uo + UU.disguise] = u.disguise === null ? DISGUISE_NONE : u.disguise;
    u8[uo + UU.job] = jobIdx.get(u.job)!;
    u8[uo + UU.trainKind] = u.trainKind === null ? TRAIN_NONE : trainIdx.get(u.trainKind)!;
    u8[uo + UU.flags] = u.carry === 1 ? FLAG_CARRY : 0;
  }
  return { f32, u8 };
}

function encodeBuildingSnap(b: Building): BuildingSnap {
  return {
    id: b.id,
    team: b.team,
    kind: b.kind,
    x: b.x,
    y: b.y,
    z: b.z,
    yaw: b.yaw,
    hp: b.hp,
    maxHp: b.maxHp,
    level: b.level,
    prod: b.prod,
    wood: b.wood,
    need: b.need,
    built: b.built,
    shell: b.shell,
    dwell: b.dwell,
    born: b.born,
    wantLevel: b.wantLevel,
    padW: b.padW,
    padD: b.padD,
  };
}

function encodeTreeSnap(t: Tree): TreeSnap {
  return { id: t.id, x: t.x, z: t.z, y: t.y, alive: t.alive, regen: t.regen };
}

/** terrainDirty 时把四张地形场全量切片（新 buffer，可 transfer）。 */
function encodeTerrain(w: World): TerrainMsg {
  return { h: w.h.slice(), swamp: w.swamp.slice(), lava: w.lava.slice(), scorch: w.scorch.slice() };
}

/** 初始/重开后的世界全量。world 传数据字段，sim 传初始实体。 */
export function encodeWorld(world: World, sim: Sim): WorldMsg {
  const soa = encodeUnitSoA(sim.units);
  return {
    t: "world",
    seed: world.genSeed,
    templateId: world.templateId,
    templateName: world.templateName,
    smoothReport: world.smoothReport ? { ...world.smoothReport } : null,
    fordCount: world.fordCount,
    genFeatures: world.genFeatures.map((f) => ({ ...f })),
    starts: [{ ...world.starts[0]! }, { ...world.starts[1]! }],
    h: world.h.slice(),
    swamp: world.swamp.slice(),
    lava: world.lava.slice(),
    scorch: world.scorch.slice(),
    lastSwampX: world.lastSwampX,
    lastSwampZ: world.lastSwampZ,
    pads: world.pads.map((p) => ({ ...p })),
    treeBlocks: world.trees.map((t) => ({ ...t })),
    lastRiverTips: world.lastRiverTips.map((p) => ({ ...p })),
    lastRiverCells: world.lastRiverCells.map((c) => ({ ...c })),
    unitF32: soa.f32,
    unitU8: soa.u8,
    buildings: sim.buildings.map(encodeBuildingSnap),
    trees: sim.trees.map(encodeTreeSnap),
  };
}

/** sim.volcano 投影：剥掉 origH（主线程不读，省 20KB/帧克隆）。 */
function encodeVolcano(v: Sim["volcano"]): VolcanoSnap | null {
  if (!v) return null;
  return {
    x: v.x,
    z: v.z,
    t: v.t,
    dur: v.dur,
    biasPhi: v.biasPhi,
    biasWidth: v.biasWidth,
    shapePhase: v.shapePhase,
    liftBase: v.liftBase,
  };
}

/** sim.tornado 投影：剥掉 flungIds（Set 克隆贵且主线程不读）。 */
function encodeTornado(t: Sim["tornado"]): TornadoSnap | null {
  if (!t) return null;
  const snap: TornadoSnap = {
    x: t.x,
    z: t.z,
    vx: t.vx,
    vz: t.vz,
    t: t.t,
    life: t.life,
    houseT: t.houseT,
  };
  if (t.waterspout !== undefined) snap.waterspout = t.waterspout;
  return snap;
}

/** TeamState 深拷（charges 的 ChargeSlot 与 wanted 数组都是 sim 侧原地可变对象，必须逐层拷）。 */
function encodeTeam(t: TeamState): TeamState {
  const charges: TeamState["charges"] = {};
  for (const k of Object.keys(t.charges) as (keyof TeamState["charges"])[]) {
    const c = t.charges[k];
    if (c) charges[k] = { ...c };
  }
  return { ...t, charges, wanted: [...t.wanted] };
}

/**
 * 每 tick 的增量快照。terrainDirty=true 时附带地形全量（判定由 worker 侧
 * terrainTouched + 尾部策略决定，codec 只负责按需切片）。
 * sim 侧原地可变的对象（shots/meteors/guardFires/teams/法术现场/fx/logs/trees）在此逐层拷贝，
 * 保证 apply(encode(x)) 与 x 的镜像读面相等且后续 sim mutation 不渗入镜像。
 */
export function encodeSnapshot(sim: Sim, terrainDirty = false): SnapMsg {
  const soa = encodeUnitSoA(sim.units);
  const q = sim.quake;
  const quake: QuakeSnap | null = q
    ? { x: q.x, z: q.z, t: q.t, dur: q.dur, angs: [...q.angs], lens: [...q.lens], opened: [...q.opened] }
    : null;
  return {
    t: "snapshot",
    time: sim.time,
    winner: sim.winner,
    toastGen: sim.toastGen,
    logs: [...sim.logs],
    armageddon: sim.armageddon,
    review: sim.review,
    freezeProd: sim.freezeProd,
    lockWin: sim.lockWin,
    unitF32: soa.f32,
    unitU8: soa.u8,
    buildings: sim.buildings.map(encodeBuildingSnap),
    trees: sim.trees.map(encodeTreeSnap),
    shots: sim.shots.map((p) => ({ ...p })),
    meteors: sim.meteors.map((m) => ({ ...m })),
    guardFires: sim.guardFires.map((f) => ({ ...f })),
    teams: [encodeTeam(sim.teams[0]), encodeTeam(sim.teams[1])],
    volcano: encodeVolcano(sim.volcano),
    quake,
    tornado: encodeTornado(sim.tornado),
    blast: sim.blast ? { ...sim.blast } : null,
    blastFlyer: sim.blastFlyer ? { ...sim.blastFlyer } : null,
    swampKill: sim.swampKill,
    swampKillX: sim.swampKillX,
    swampKillZ: sim.swampKillZ,
    tornadoLift: sim.tornadoLift,
    tornadoLiftX: sim.tornadoLiftX,
    tornadoLiftZ: sim.tornadoLiftZ,
    tornadoHouse: sim.tornadoHouse,
    stuckWatch: new Map(sim.stuckWatch),
    fxBolts: sim.fxBolts.map((b) => ({ ...b })),
    fxShake: sim.fxShake,
    fxQuake: sim.fxQuake ? { ...sim.fxQuake } : null,
    fxVolcano: sim.fxVolcano ? { ...sim.fxVolcano } : null,
    fxSplash: sim.fxSplash.map((s) => ({ ...s })),
    // world.pads/treeBlocks/lastRiver* 由 markHouseBlocks/growRivers 每 tick 整组重建（对象字面量
    // 都是新的），直接引用不会与 sim 侧后续写入混叠。
    pads: sim.world.pads,
    treeBlocks: sim.world.trees,
    riverTips: sim.world.lastRiverTips,
    riverCells: sim.world.lastRiverCells,
    lastSwampX: sim.world.lastSwampX,
    lastSwampZ: sim.world.lastSwampZ,
    terrainDirty,
    terrain: terrainDirty ? encodeTerrain(sim.world) : null,
  };
}

/** postMessage 的 transfer list：消息里所有 typed array 的 buffer（一次性移交，避免结构化克隆拷贝）。 */
export function transferOf(msg: WorldMsg | SnapMsg): ArrayBuffer[] {
  const bufs: ArrayBuffer[] = [];
  const push = (a: Float32Array | Uint8Array | null | undefined) => {
    if (a && a.buffer instanceof ArrayBuffer) bufs.push(a.buffer);
  };
  if (msg.t === "world") {
    push(msg.h);
    push(msg.swamp);
    push(msg.lava);
    push(msg.scorch);
    push(msg.unitF32);
    push(msg.unitU8);
  } else if (msg.t === "snapshot") {
    push(msg.unitF32);
    push(msg.unitU8);
    if (msg.terrain) {
      push(msg.terrain.h);
      push(msg.terrain.swamp);
      push(msg.terrain.lava);
      push(msg.terrain.scorch);
    }
  }
  return bufs;
}

// ---------------------------------------------------------------------------
// 解码 / 镜像应用
// ---------------------------------------------------------------------------

/** SoA → 镜像 units：按 id 复用对象原地更新；消失的从 units/unitsById 删除。 */
function applyUnits(mirror: SimMirror, f32: Float32Array, u8: Uint8Array): void {
  const n = Math.min(Math.floor(f32.length / UF_N), Math.floor(u8.length / UU_N));
  const seen = new Set<number>();
  for (let i = 0; i < n; i++) {
    const fo = i * UF_N;
    const uo = i * UU_N;
    const id = f32[fo + UF.id]!;
    const kind = UNIT_KINDS[u8[uo + UU.kind]!] ?? "walker";
    let u = mirror.unitsById.get(id);
    if (!u) {
      u = makeMirrorUnit(kind);
      mirror.unitsById.set(id, u);
      mirror.units.push(u);
    }
    u.id = id; // BaseEntity 的 id 不经构造函数，必须显式赋
    u.x = f32[fo + UF.x]!;
    u.y = f32[fo + UF.y]!;
    u.z = f32[fo + UF.z]!;
    u.yaw = f32[fo + UF.yaw]!;
    u.hp = f32[fo + UF.hp]!;
    u.maxHp = f32[fo + UF.maxHp]!;
    u.phase = f32[fo + UF.phase]!;
    u.think = f32[fo + UF.think]!;
    u.channel = f32[fo + UF.channel]!;
    u.downT = f32[fo + UF.downT]!;
    u.fireT = f32[fo + UF.fireT]!;
    u.burnT = f32[fo + UF.burnT]!;
    u.burnDps = f32[fo + UF.burnDps]!;
    u.enterT = f32[fo + UF.enterT]!;
    u.swampT = f32[fo + UF.swampT]!;
    u.flyVx = f32[fo + UF.flyVx]!;
    u.flyVy = f32[fo + UF.flyVy]!;
    u.flyVz = f32[fo + UF.flyVz]!;
    u.pathI = f32[fo + UF.pathI]!;
    u.targetId = f32[fo + UF.targetId]!;
    u.atkId = f32[fo + UF.atkId]!;
    u.homeId = f32[fo + UF.homeId]!;
    (u as unknown as { pathLen: number }).pathLen = f32[fo + UF.pathLen]!;
    u.str = f32[fo + UF.str]!;
    u.channelId = f32[fo + UF.channelId]!;
    u.kind = kind;
    u.team = u8[uo + UU.team]! as Owner;
    const dg = u8[uo + UU.disguise]!;
    u.disguise = dg === DISGUISE_NONE ? null : (dg as Team);
    u.job = JOBS[u8[uo + UU.job]!] ?? "idle";
    const tk = u8[uo + UU.trainKind]!;
    u.trainKind = tk === TRAIN_NONE ? null : (TRAIN_KINDS[tk] ?? null);
    u.carry = (u8[uo + UU.flags]! & FLAG_CARRY) !== 0 ? 1 : 0;
    seen.add(id);
  }
  if (mirror.units.length !== n) {
    mirror.units = mirror.units.filter((u) => seen.has(u.id));
  }
  // 重建索引：保证 id→镜像单元 与 units 数组一致（消失单位出索引）。
  mirror.unitsById.clear();
  for (const u of mirror.units) mirror.unitsById.set(u.id, u);
}

/** world 消息 → 镜像（首条消息：地形/元数据/初始实体全量落地）。 */
export function applyWorld(mirror: SimMirror, msg: WorldMsg): void {
  const w = mirror.world;
  w.h = msg.h;
  w.swamp = msg.swamp;
  w.lava = msg.lava;
  w.scorch = msg.scorch;
  w.starts = [{ ...msg.starts[0]! }, { ...msg.starts[1]! }];
  w.genSeed = msg.seed;
  w.templateId = msg.templateId;
  w.templateName = msg.templateName;
  w.smoothReport = msg.smoothReport ? { ...msg.smoothReport } : null;
  w.fordCount = msg.fordCount;
  w.genFeatures = msg.genFeatures.map((f) => ({ ...f }));
  w.lastSwampX = msg.lastSwampX;
  w.lastSwampZ = msg.lastSwampZ;
  w.pads = msg.pads;
  w.trees = msg.treeBlocks;
  w.lastRiverTips = msg.lastRiverTips.map((p) => ({ ...p }));
  w.lastRiverCells = msg.lastRiverCells.map((c) => ({ ...c }));
  // 全量换图：主线程地形网格整图重建（镜像的脏区语义：dirtyAll = 包围盒不可信，整图重建）。
  Object.assign(w, {
    dirty: true,
    dirtyAll: true,
    hasWindow: true,
    dirtyMinX: 0,
    dirtyMinZ: 0,
    dirtyMaxX: SAMPLES - 1,
    dirtyMaxZ: SAMPLES - 1,
  });
  applyUnits(mirror, msg.unitF32, msg.unitU8);
  mirror.buildings = msg.buildings.map(makeMirrorBuilding);
  mirror.trees = msg.trees.map(makeMirrorTree);
}

/** snapshot 消息 → 镜像（原地更新实体、替换集合与标量；terrainDirty 时换地形场）。 */
export function applySnapshot(mirror: SimMirror, msg: SnapMsg): void {
  mirror.time = msg.time;
  mirror.winner = msg.winner;
  mirror.toastGen = msg.toastGen;
  mirror.logs = [...msg.logs];
  mirror.armageddon = msg.armageddon;
  mirror.review = msg.review;
  mirror.freezeProd = msg.freezeProd;
  mirror.lockWin = msg.lockWin;
  applyUnits(mirror, msg.unitF32, msg.unitU8);
  mirror.buildings = msg.buildings.map(makeMirrorBuilding);
  mirror.trees = msg.trees.map(makeMirrorTree);
  mirror.shots = msg.shots.map((p) => ({ ...p }));
  mirror.meteors = msg.meteors.map((m) => ({ ...m }));
  mirror.guardFires = msg.guardFires.map((f) => ({ ...f }));
  mirror.teams = [encodeTeam(msg.teams[0]), encodeTeam(msg.teams[1])];
  mirror.volcano = msg.volcano ? { ...msg.volcano } : null;
  mirror.quake = msg.quake
    ? { ...msg.quake, angs: [...msg.quake.angs], lens: [...msg.quake.lens], opened: [...msg.quake.opened] }
    : null;
  mirror.tornado = msg.tornado ? { ...msg.tornado } : null;
  mirror.blast = msg.blast ? { ...msg.blast } : null;
  mirror.blastFlyer = msg.blastFlyer ? { ...msg.blastFlyer } : null;
  mirror.swampKill = msg.swampKill;
  mirror.swampKillX = msg.swampKillX;
  mirror.swampKillZ = msg.swampKillZ;
  mirror.tornadoLift = msg.tornadoLift;
  mirror.tornadoLiftX = msg.tornadoLiftX;
  mirror.tornadoLiftZ = msg.tornadoLiftZ;
  mirror.tornadoHouse = msg.tornadoHouse;
  mirror.stuckWatch = new Map(msg.stuckWatch);
  mirror.fxBolts = msg.fxBolts.map((b) => ({ ...b }));
  mirror.fxShake = msg.fxShake;
  mirror.fxQuake = msg.fxQuake ? { ...msg.fxQuake } : null;
  mirror.fxVolcano = msg.fxVolcano ? { ...msg.fxVolcano } : null;
  mirror.fxSplash = msg.fxSplash.map((s) => ({ ...s }));
  const w = mirror.world;
  w.pads = msg.pads;
  w.trees = msg.treeBlocks;
  w.lastRiverTips = msg.riverTips.map((p) => ({ ...p }));
  w.lastRiverCells = msg.riverCells.map((c) => ({ ...c }));
  w.lastSwampX = msg.lastSwampX;
  w.lastSwampZ = msg.lastSwampZ;
  if (msg.terrain) {
    w.h = msg.terrain.h;
    w.swamp = msg.terrain.swamp;
    w.lava = msg.terrain.lava;
    w.scorch = msg.terrain.scorch;
    // 地形全量替换：整图重建（worker 侧的局部脏区窗口不跨线程传，C2 后续可优化为窗口差分）。
    Object.assign(w, {
      dirty: true,
      dirtyAll: true,
      hasWindow: true,
      dirtyMinX: 0,
      dirtyMinZ: 0,
      dirtyMaxX: SAMPLES - 1,
      dirtyMaxZ: SAMPLES - 1,
    });
  }
}

// ---------------------------------------------------------------------------
// 地形置脏判定（纯函数）
// ---------------------------------------------------------------------------

/**
 * 本 tick 地形是否被改（worker 每 tick 调，决定 snapshot 是否携带地形全量）。
 * 依据（读 spells/ 确认的激活期字段）：
 * - lastCastTool ∈ raise/lower：SculptSpell.cast → world.sculpt 直改 h；
 *   ∈ swamp：SwampSpell.cast → world.paintSwamp 直改 swamp（swamp 场在脏载荷里，一并置脏）；
 * - sim.volcano 非空：VolcanoSpell 激活期（raisePlateau/flowLava 改 h/lava，直到 t > dur+8 才置 null）；
 * - sim.quake 非空：QuakeSpell 激活期（sinkTrench/seedLava 改 h/lava，直到 t > dur+4 才置 null）；
 * - 其余工具（lightning/fireball/blast/tornado/convert/armageddon）不改地形场 → false。
 * 注意：sim.quake/volcano 置 null 后岩浆还在冷却（约 5~10s 干涸）——由 worker 侧的
 * 尾部策略（活动结束后再传 TERRAIN_TAIL 秒）兜底，本函数保持纯函数不携带状态。
 */
export function terrainTouched(
  sim: { volcano: { t: number; dur: number } | null; quake: { t: number; dur: number } | null },
  lastCastTool: string | null,
): boolean {
  if (lastCastTool === "raise" || lastCastTool === "lower" || lastCastTool === "swamp") return true;
  return sim.volcano !== null || sim.quake !== null;
}
