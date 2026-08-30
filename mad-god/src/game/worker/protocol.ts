// v0.29c-1 主线程 ↔ Sim Worker 消息协议（纯类型，零运行时）。
// 约定：
// - 主→Worker 命令 = MainCmd（判别字段 t），每条命令注释对应 game.ts 本地模式的指令入口；
// - Worker→主 = WorkerMsg：ready（脚本已加载）/ world（初始/重开后的全量）/ snapshot（每 tick 状态）/
//   foundRes（found 命令的回执，本地模式 foundSite 的返回值在 worker 里拿不到，需回传）。
// - 设计决定：toast 日志尾巴、winner、armageddon 等事件性字段并入 snapshot 标量（codec.ts），
//   不设独立 events 消息——省一条消息类型，也避免 events 与 snapshot 的乱序/重复投递问题。
// 编解码实体见 codec.ts；本文件只放类型。
import type { BuildingKind, FxBolt, Order, Projectile, Team, TeamState, Tool, TrainKind } from "../types";
import type { Pad, StartPad, TreeBlock } from "../world";
import type { FeatureStat } from "../world-gen/terrain-features";
import type { SmoothReport } from "../map-smoother";

/** AI 难度档（对应 AIProfile.easy/normal/hard，与 game.ts 的 ?ai= 参数同口径）。 */
export type AiLevel = "easy" | "normal" | "hard";

/**
 * 主→Worker 命令。除 init/restart 外都要求 worker 已完成 init（sim 就绪）。
 * 团队恒为 BLUE：主线程只代表玩家发令（红方由 worker 内的 AIDirector 驱动）。
 */
export type MainCmd =
  /** 建 World+Sim+AIDirector（AIProfile 按 ai 档）并 attach；完成后回发 world 消息。 */
  | { t: "init"; seed: number; ai: AiLevel }
  /** 重建对局（新 seed、重建 AIDirector）；ai 缺省沿用上次 init 的档位。完成后回发 world 消息。 */
  | { t: "restart"; seed: number; ai?: AiLevel }
  /** 开始/恢复固定步长自驱循环（= game.ts start/togglePause 的继续）。 */
  | { t: "start" }
  /** 暂停循环（= game.ts paused；tick 停，指令仍接收）。 */
  | { t: "pause"; on: boolean }
  /** 导演镜头期间暂停 AI（= game.ts 循环里 shotDirector.isShotActive() 门）：tick 照跑，跳过 aiDirector.update。 */
  | { t: "aiHold"; on: boolean }
  /** 选择集同步：清全部单位 selected 再置 ids（选择集主线程自治，sim 侧 selectedOf 依赖它）。 */
  | { t: "select"; ids: number[] }
  /** 谕令 = sim.setOrder(BLUE, order)（game.ts setOrder）。 */
  | { t: "order"; order: Order }
  /** 聚集标记 = sim.setMagnet(BLUE, x, z)（game.ts primary 的 pendingMagnet 分支）。 */
  | { t: "magnet"; x: number; z: number }
  /** 训兵 = sim.train(BLUE, k)（game.ts train）。 */
  | { t: "train"; k: TrainKind }
  /** 对 ids 逐个 sendMove（= game.ts secondary 末尾右键空地的循环，含先清 atkId）。 */
  | { t: "move"; ids: number[]; x: number; z: number }
  /** 右键建筑/进塔语义 = sim.orderMove(BLUE, x, z)（game.ts secondary 的自家建筑分支）。 */
  | { t: "orderMove"; x: number; z: number }
  /** 攻击目标 = sim.orderAttackTarget(BLUE, targetId 对应的单位或建筑)（game.ts secondary 的敌人分支）。 */
  | { t: "attack"; targetId: number }
  /** 落基 = sim.foundSite(BLUE,...)，成功则 sim.assignBuilders(BLUE, 建成对象)；回发 foundRes。 */
  | { t: "found"; x: number; z: number; yaw: number; kind: BuildingKind }
  /** 施法 = spells.cast(sim, BLUE, tool, x, z, dt)（雕塑流式按帧直调即可）；msg 非空时 worker 侧 toast。 */
  | { t: "cast"; tool: Tool; x: number; z: number; dt?: number }
  /** sim.freezeProd / sim.review 直写（shot-director 摆拍与暂停生产用）。 */
  | { t: "setFlag"; freezeProd?: boolean; review?: boolean }
  /** v0.29c-2 客户端本地 toast 的 worker 回执：sim.toast(msg)，让 toastGen/logs 以 worker 为准
   * （镜像本地 push 只为即时显示；若不回执，worker 计数不增，后续 toast 会被 HUD 的
   * toastGen 去重吞掉——见 worker-sim-client.toast 的注释）。 */
  | { t: "toast"; msg: string }
  /** v0.29c-2 右键自家未完工工地 = sim.assignBuilders(BLUE, buildingById(targetId))（game.ts secondary）。 */
  | { t: "assignBuilders"; targetId: number };

/** 初始/重开后的世界全量（数据字段 + sim 初始实体）。字段枚举依据：主线程对 world 的读点
 * （render.ts 地形网格/沼泽/岩浆/焦土/熔岩流、ui.ts drawMini、game.ts logWorld）——方法都是
 * 纯数据推导不传；fmask 只在生成期有意义且主线程不读，不传。 */
export interface WorldMsg {
  t: "world";
  /** world.genSeed（v0.24：与 rng.s 区分，rng.s 会被推进）。 */
  seed: number;
  templateId: string;
  templateName: string;
  smoothReport: SmoothReport | null;
  fordCount: number;
  genFeatures: FeatureStat[];
  starts: [StartPad, StartPad];
  /** 高度场全量（SAMPLES²=289² floats ≈ 328KB，仅 init/restart 一次）。 */
  h: Float32Array;
  swamp: Float32Array;
  lava: Float32Array;
  scorch: Float32Array;
  lastSwampX: number;
  lastSwampZ: number;
  /** markHouseBlocks 后的通行阻挡（walkableAt 数据基础；每 tick 由 snapshot 的 pads/treeBlocks 刷新）。 */
  pads: Pad[];
  treeBlocks: TreeBlock[];
  lastRiverTips: { x: number; z: number }[];
  lastRiverCells: { x: number; z: number; ang: number }[];
  /** sim 初始实体全量：units 走与 snapshot 相同的 SoA 编码，buildings/trees 为普通对象投影。 */
  unitF32: Float32Array;
  unitU8: Uint8Array;
  buildings: BuildingSnap[];
  trees: TreeSnap[];
}

/** v0.29c-1 建筑投影（普通对象，structured clone 直传；字段 = 主线程读面：render 的
 * syncHouses/syncProdBars/syncRoofIcons/syncDwellPips/syncTrainBars、ui.drawMini、
 * shot-director 的 b.hp/b.level/b.maxHp 等 + sim.buildingPad 依赖的 padW/padD）。 */
export interface BuildingSnap {
  id: number;
  team: Team;
  kind: BuildingKind;
  x: number;
  y: number;
  z: number;
  yaw: number;
  hp: number;
  maxHp: number;
  level: number;
  prod: number;
  wood: number;
  need: number;
  /** v0.28i 渐进式建造进度（脚手架起升）。 */
  built: number;
  shell: boolean;
  dwell: number;
  born: number;
  wantLevel: number;
  padW: number;
  padD: number;
}

export interface TreeSnap {
  id: number;
  x: number;
  z: number;
  y: number;
  alive: boolean;
  regen: number;
}

/** 地形全量载荷（terrainDirty 的 tick 随 snapshot 携带；连同 swamp/lava/scorch 一起传，
 * 因为雕塑/火山/地震/沼泽窗内这四张场都会变，主线程的小地图/岩浆/焦土视觉同源）。 */
export interface TerrainMsg {
  h: Float32Array;
  swamp: Float32Array;
  lava: Float32Array;
  scorch: Float32Array;
}

/** sim.volcano 的传输投影：剥掉 origH（20KB Float32Array，火山期每帧克隆太贵；主线程不读）。 */
export interface VolcanoSnap {
  x: number;
  z: number;
  t: number;
  dur: number;
  biasPhi: number;
  biasWidth: number;
  shapePhase: number;
  liftBase: number;
}

/** sim.quake 的传输投影（angs/lens/opened 主线程画裂缝要读）。 */
export interface QuakeSnap {
  x: number;
  z: number;
  t: number;
  dur: number;
  angs: number[];
  lens: number[];
  opened: number[];
}

/** sim.tornado 的传输投影：剥掉 flungIds（sim 内部甩飞判定集，主线程不读）。 */
export interface TornadoSnap {
  x: number;
  z: number;
  vx: number;
  vz: number;
  t: number;
  life: number;
  houseT: number;
  waterspout?: boolean;
}

export interface BlastSnap {
  x: number;
  z: number;
  t: number;
  life: number;
}

export interface MeteorSnap {
  x: number;
  z: number;
  y: number;
  vy: number;
  team: Team;
}

export interface GuardFireSnap {
  x: number;
  z: number;
  team: Team;
}

/** 每 tick 的增量状态。标量/小对象直接 structured clone；units 用 SoA typed arrays
 *（布局见 codec.ts 的 UF/UU 表）；terrainDirty 时附带地形全量。 */
export interface SnapMsg {
  t: "snapshot";
  time: number;
  winner: Team | -1 | null;
  toastGen: number;
  /** toast 日志尾巴（sim.logs 本身 ≤8 条，直接拷贝）。 */
  logs: string[];
  armageddon: boolean;
  review: boolean;
  freezeProd: boolean;
  lockWin: boolean;
  unitF32: Float32Array;
  unitU8: Uint8Array;
  buildings: BuildingSnap[];
  trees: TreeSnap[];
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
  /** stuckWatch 以 Map 传输（structured clone 原生支持）。 */
  stuckWatch: Map<number, { x: number; z: number; t: number }>;
  fxBolts: FxBolt[];
  fxShake: number;
  fxQuake: { x: number; z: number } | null;
  fxVolcano: { x: number; z: number } | null;
  fxSplash: { x: number; z: number }[];
  /** 通行阻挡快照（markHouseBlocks 每 tick 重建，主线程 walkableAt 数据基础）。 */
  pads: Pad[];
  treeBlocks: TreeBlock[];
  riverTips: { x: number; z: number }[];
  riverCells: { x: number; z: number; ang: number }[];
  lastSwampX: number;
  lastSwampZ: number;
  /** 本 tick 地形是否被改（判定见 codec.terrainTouched + worker 的尾部策略）。 */
  terrainDirty: boolean;
  /** terrainDirty 时为全量地形载荷，否则 null。 */
  terrain: TerrainMsg | null;
}

/** found 命令回执：本地模式 game.ts 靠 foundSite 返回值判成功并联动 assignBuilders/showMoveMark，
 * worker 化后主线程拿不到返回值，由 worker 显式回传（id=0 表示失败）。 */
export interface FoundResMsg {
  t: "foundRes";
  ok: boolean;
  id: number;
}

/** Worker→主 消息全集。 */
export type WorkerMsg =
  /** 脚本已加载（main 收到后可发 init）。 */
  | { t: "ready" }
  | WorldMsg
  | SnapMsg
  | FoundResMsg;
