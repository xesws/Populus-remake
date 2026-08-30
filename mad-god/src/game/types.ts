// v0.24 地图放大：52 → 72 格（SAMPLES = WORLD/STEP + 1 = 289；改 WORLD 必须同步 SAMPLES）。
export const WORLD = 72;
export const SIZE = WORLD;
export const RES = 4;
export const STEP = 0.25;
export const SAMPLES = 289;
export const MAX_H = 8;
export const WATER = 0.20;
export const MAX_SLOPE = 0.70;

export const BLUE = 0 as const;
export const RED = 1 as const;
export const NEUTRAL = 2 as const;
export type Team = 0 | 1;
export type Owner = 0 | 1 | 2;

export type UnitKind = "shaman" | "walker" | "warrior" | "preacher" | "firewarrior" | "spy" | "wildman";
export type TrainKind = "warrior" | "preacher" | "firewarrior" | "spy";
export type BuildingKind = "hut" | "warriorHut" | "temple" | "fireHut" | "spyHut" | "tower" | "rebirth";

export const TRAIN_COST: Record<TrainKind, number> = {
  warrior: 28,
  preacher: 34,
  firewarrior: 42,
  spy: 30,
};

export type Job = "idle" | "chop" | "haul" | "train" | "move";

export const CAMP_FOR: Record<TrainKind, BuildingKind> = {
  warrior: "warriorHut",
  preacher: "temple",
  firewarrior: "fireHut",
  spy: "spyHut",
};

export const TRAIN_FOR_CAMP: Partial<Record<BuildingKind, TrainKind>> = {
  warriorHut: "warrior",
  temple: "preacher",
  fireHut: "firewarrior",
  spyHut: "spy",
};

export function isCampKind(kind: BuildingKind): boolean {
  return kind === "warriorHut" || kind === "temple" || kind === "fireHut" || kind === "spyHut";
}

export function woodNeedFor(kind: BuildingKind, level: number): number {
  if (isCampKind(kind)) return level >= 1 ? 0 : 4;
  if (kind === "hut") return level >= 1 ? 0 : 2;
  // v0.27-3 哨塔：1 捆木头（比茅屋的 2 捆还少）——定位是速起的防御工事。
  if (kind === "tower") return level >= 1 ? 0 : 1;
  return 0;
}

export const CHOP_TIME = 1.2;
export const TRAIN_TIME = 4;
export const TREE_REGEN = 25;

export function isSoldier(kind: UnitKind): boolean {
  return kind === "warrior" || kind === "preacher" || kind === "firewarrior";
}

export function canConvert(kind: UnitKind): boolean {
  return kind !== "shaman" && kind !== "preacher";
}

export const UNIT_RADIUS: Record<UnitKind, number> = {
  shaman: 0.24,
  walker: 0.22,
  warrior: 0.25,
  preacher: 0.24,
  firewarrior: 0.25,
  spy: 0.22,
  wildman: 0.22,
};

// v0.7 战斗数值表：伤害 = max(1, round(攻击 × 克制系数 − 受击护甲))，集中在此调参。
export const UNIT_ATTACK: Record<UnitKind, number> = {
  shaman: 3,
  walker: 2,
  warrior: 6,
  preacher: 3,
  firewarrior: 5,
  spy: 3,
  wildman: 2,
};

export const UNIT_ARMOR: Record<UnitKind, number> = {
  shaman: 0,
  walker: 0,
  warrior: 2,
  preacher: 1,
  firewarrior: 0,
  spy: 0,
  wildman: 0,
};

// 攻击距离（格）。火战士 v0.9 起为远程火球；v0.27g 4.5→7（×1.5，用户口径
// "1.5~2 倍攻击范围"）：v0.27-2 站桩化后 4.5 格射程外的路人它只会站着看，
// 敌人从 5~7 格路过必须直接开火。哨塔 ×2 = 14（≈ 基础 4.5 的 3 倍距离）。
export const UNIT_RANGE: Record<UnitKind, number> = {
  shaman: 0.95,
  walker: 0.95,
  warrior: 0.95,
  preacher: 0.95,
  firewarrior: 7,
  spy: 0.95,
  wildman: 0.95,
};

// 攻击间隔（秒）：atkCd 归零才能出刀。
export const UNIT_ATK_CD: Record<UnitKind, number> = {
  shaman: 1.5,
  walker: 1.4,
  warrior: 1.1,
  preacher: 1.3,
  firewarrior: 1.8,
  spy: 1.0,
  wildman: 1.2,
};

// 自动索敌半径（格）；0 = 不主动索敌、只还手。v0.8 生效；v0.19 武士 10 步、间谍 4 步；
// v0.23 武士 13、牛头人 8（射程 4.5 的 ~1.8 倍）——用户要求"范围广一点才能主动扑过去"。
// v0.27-2 扩过一轮：武士 13→20、牛头人 8→12、传教士 3→4.5。
// v0.27h 用户拍板回调：武士 20→8（近战索敌不该比远程牛头人 12 还大）。
// v0.28 大祭司入列近战索敌（跟随牵引）：0→6。
export const UNIT_SIGHT: Record<UnitKind, number> = {
  shaman: 6,
  walker: 0,
  warrior: 8,
  preacher: 4.5,
  firewarrior: 12,
  spy: 4,
  wildman: 0,
};

// 克制系数（攻击方 → 受击方，缺省 1）。
export const COUNTER_MULT: Partial<Record<UnitKind, Partial<Record<UnitKind, number>>>> = {
  firewarrior: { walker: 1.2 },
};

// 自动索敌/还手的追击拴绳（格）；玩家手动指令不受拴绳限制。
// v0.28 牵引语义：**目标**逃出追击者自身锁敌圈 +2 格才放手（原锚点制废除——
// "必须一直跟着他"，只要贴得住就无限追，绝不被出发点的距离掐断）。
export function agroLeash(kind: UnitKind): number {
  const s = UNIT_SIGHT[kind];
  return s > 0 ? s + 2 : 0;
}

/**
 * v0.28 索敌角色（近战/远程分流，用户拍板）：
 * - "follow" 跟随索敌：武士/传教士/间谍/大祭司/村民（还手时）——锁了就追，
 *   目标逃出牵引范围（agroLeash）前绝不放手；
 * - "hold" 站桩索敌：牛头人（及未来的巫师/法师）——射程远，原地开火，
 *   绝不跟随、绝不移动，目标进出射程由每轮重选自然处理。
 */
export type AcquireRole = "follow" | "hold";
export function acquireRole(kind: UnitKind): AcquireRole {
  return kind === "firewarrior" ? "hold" : "follow";
}

// v0.9/v0.12 火球参数：弹速、暴击击飞（落地即死）与默认击退倒地。
export const FIREBALL_SPEED = 5.2; // v0.28a 提速 1.3×（原 4）：弹道更利落，塔上齐射更凶
// v0.27f 火球法术重构为"天降陨石"：施放后火球从高空坠落（约 0.85s 落地），
// 撞击只造成小直接伤害（FIREBALL_IMPACT_DMG，村民 6 血剩 3，不再瞬间蒸发），
// 主伤害靠点燃：fireT 视觉火焰 + burnT/burnDps 持续掉血把目标烧死。
export const FIREBALL_IMPACT_R = 1.7; // 撞击半径（沿用旧法术口径）
export const METEOR_START_Y = 13;
export const METEOR_FALL_V = 15;
export const FIREBALL_IMPACT_DMG = 3;
export const FIREBALL_BURN_T = 6;
export const FIREBALL_BURN_DPS = 1.6;
export const FIREBALL_FIRE_T = 4;
// v0.26 转化法术：施法点须距己方存活大祭司 CONVERT_CAST_RANGE 内，圈内 CONVERT_RADIUS 生效。
export const CONVERT_CAST_RANGE = 4;
export const CONVERT_RADIUS = 2.5;
export const FIRE_CRIT_CHANCE = 0.2; // 暴击：像闪电一样真正打飞，摔下来直接死亡
export const FIRE_KNOCK_DIST = 1.0; // v0.28a 每发必击退：沿弹道方向（远离射手）推一步
export const FIRE_DOWN_TIME = 0.6; // 短暂倒地，站起瞬间才结算伤害（原 0.9）

// v0.12 武士暴击：概率击退并追加伤害（村民/传教士/间谍/萨满无暴击）。
export const WARRIOR_CRIT_CHANCE = 0.5;
export const WARRIOR_CRIT_MULT = 2;
export const WARRIOR_CRIT_KNOCK_MIN = 2;
export const WARRIOR_CRIT_KNOCK_MAX = 3;

// v0.16 传教士感化：站桩引导转化身边野人/敌方单位（祭司与传教士免疫感化）。
export const PREACH_REACH = 1.25; // 引导射程（格），站桩不追击
export const PREACH_TIME = 1.35; // 引导时长（秒），中途目标离开则重来

// v0.19 守卫命令：围篝火跳舞回血，敌人进入索敌范围即退出（退出的单位转为 fight，不自动回圈）。
export const GUARD_R = 5; // 篝火判定圈半径（格）：圈内跳舞回血
export const GUARD_HEAL = 1.0; // 跳舞回血速率（hp/秒）
export const GUARD_DANCE_R = 2.2; // 绕圈跳舞的圆周半径（格）

// v0.11a 修复：房屋升级不再扩大占地（否则升级会把邻居挤掉）。各级 pad / 墙体面积恒定为 L1 尺寸，只许长高。
export const HOUSE_WALL = [0, 2.2, 2.2, 2.2] as const;
export const HOUSE_ROOF = [0, 2.2, 2.2, 2.2] as const;
export const HOUSE_PAD = [0, 2.6, 2.6, 2.6] as const;

// v0.27h 住户"上房"：茅屋住户站上屋顶（按等级的屋顶面高度），玩家可直接点选拉出。
// 高度对齐 render 的各级屋顶尖：L1 茅草尖 ~1.2 / L2 石檐 ~1.65 / L3 城堡顶 ~2.1。
export const HOUSE_ROOF_Y = [0, 1.2, 1.65, 2.1] as const;

// v0.27-3 哨塔 → v0.27f 瘦身加高：占地缩为小圆口径（TOWER_PAD 0.9，直径 ≈ 旧边长 1.8 的一半），
// 外观改为"魔法哨塔"——细高石柱 + 瞭望台 + 四面栅栏（栏间即窗口，驻塔牛战士可见/开火）+ 队色尖顶。
// 塔上射程与视野都是地面 2 倍：射程 4.5→9、锁敌 12→24（用户口径"哨塔上最远 3 倍距离"）；
// 火球发射原点在窗口高度（TOWER_TOP），弹道俯冲而出、永不与自家塔体判撞。
export const TOWER_PAD = 0.9;
export const TOWER_DECK_Y = 3.38; // 瞭望台面高度（驻军站位 / 渲染基准）
export const TOWER_TOP = 3.9; // 火球发射原点（窗口高度，尖顶之下）
export const TOWER_RANGE_MULT = 2;
export const TOWER_SIGHT_MULT = 2;
export const TOWER_GARRISON_MAX = 1;

export function houseHalf(level: number): number {
  const lv = level >= 3 ? 3 : level === 2 ? 2 : 1;
  return Math.max(HOUSE_WALL[lv], HOUSE_ROOF[lv]) / 2;
}

export function padSize(level: number): { w: number; d: number } {
  const lv = level >= 3 ? 3 : level === 2 ? 2 : 1;
  const s = HOUSE_PAD[lv];
  return { w: s, d: s };
}

export type Order = "settle" | "gather" | "fight" | "shaman" | "guard";
export type Tool =
  | "select"
  | "raise"
  | "lower"
  | "lightning"
  | "quake"
  | "swamp"
  | "volcano"
  | "tornado"
  | "blast"
  | "armageddon"
  | "fireball"
  | "convert";

export const TOOL_COST: Record<Tool, number> = {
  select: 0,
  // v0.18 雕刻费率上调（7→12 / 5→9 每秒）：避免"感觉免费"的无限抬地；按住 1 秒约 12 法力。
  raise: 12,
  lower: 9,
  lightning: 20,
  quake: 50,
  swamp: 36,
  volcano: 80,
  tornado: 55,
  blast: 28,
  armageddon: 100,
  fireball: 16,
  convert: 40,
};

export const UNLOCK_CAP: Record<Tool, number> = {
  select: 0,
  raise: 0,
  lower: 0,
  lightning: 0,
  quake: 0,
  swamp: 0,
  volcano: 0,
  tornado: 0,
  blast: 0,
  armageddon: 200,
  fireball: 0,
  convert: 0,
};

/**
 * v0.26 技能充能槽（《王者荣耀》充能技 / 提莫蘑菇式）：
 * - 离散技能（神迹）：`cur` 是当前可用颗数，用掉 1 颗后 `fill` 从 0 起充，
 *   每 `recharge` 秒 +1 颗，封顶 `max`。基础技回得快攒得多、大招回得慢攒得少。
 * - 连续技能（雕刻 raise/lower）：`cur` 是能量值，`recharge` 秒回满整槽，
 *   按住施放按帧扣能量（保持旧法力 12/9 每秒的节奏）。
 * - `manaCap` 已降级为"神迹解锁进度"（仍由房子+人口增长，canUnlock/UNLOCK_CAP 语义不变），
 *   不再作为资源；`TeamState.mana` 已删除。
 */
export interface ChargeSlot {
  cur: number;
  /** 充能进度（秒）。离散槽：满 recharge 秒 +1 颗；连续槽：满 recharge 秒回满整槽。 */
  fill: number;
  max: number;
  recharge: number;
  continuous?: boolean;
}

export const SKILL_CHARGE: Partial<Record<Tool, ChargeSlot>> = {
  // v0.26d 平衡：开局除转化外全部 0 颗（大招不能开局就甩）；
  // 大招充能按"人口 <50 的基础速度"定档——火山 240s（4 分钟）、地震/龙卷风 200s、
  // 末日 300s；人口越多充得越快（chargePopMult，见下）。
  quake: { cur: 0, fill: 0, max: 2, recharge: 200 },
  volcano: { cur: 0, fill: 0, max: 2, recharge: 240 },
  tornado: { cur: 0, fill: 0, max: 2, recharge: 200 },
  armageddon: { cur: 0, fill: 0, max: 1, recharge: 300 },
  // 基础：12s 一颗，上限 5 颗（开局同样 0 颗，很快回第一颗）。
  lightning: { cur: 0, fill: 0, max: 5, recharge: 12 },
  blast: { cur: 0, fill: 0, max: 5, recharge: 12 },
  fireball: { cur: 0, fill: 0, max: 5, recharge: 12 },
  // 中间档。转化是唯一开局带 1 颗的法术（用户拍板）。
  swamp: { cur: 0, fill: 0, max: 4, recharge: 18 },
  convert: { cur: 1, fill: 0, max: 2, recharge: 30 },
  // 雕刻：独立小能量槽（30 点，12s 回满 ≈ 2.5/s），按住每秒扣 12/9。
  // 地形工具不是魔法（用户拍板）：开局满能量可用。
  raise: { cur: 30, fill: 0, max: 30, recharge: 12, continuous: true },
  lower: { cur: 30, fill: 0, max: 30, recharge: 12, continuous: true },
};

/**
 * v0.26d 充能速度的人口档位（每队各自按 countPop 算）：
 * <50 人 ×1.0；≥50 ×1.3；≥100 ×1.6；≥150 ×1.9；≥200 ×2.3；
 * ≥250 起每加 50 人再 +0.5（×2.8、×3.3…）。例：火山 10 人 240s/颗，
 * 100 人 150s/颗，200 人约 104s/颗。
 */
export const POP_CHARGE_TIERS: readonly number[] = [1, 1.3, 1.6, 1.9, 2.3];
export function chargePopMult(pop: number): number {
  const tier = Math.floor(pop / 50);
  return tier < POP_CHARGE_TIERS.length ? POP_CHARGE_TIERS[tier]! : 2.3 + (tier - 4) * 0.5;
}


export interface Waypoint {
  x: number;
  z: number;
}

export { BaseEntity } from "./entities/entity";
export { Unit } from "./entities/unit";
export { Building } from "./entities/building";
export { Tree } from "./entities/tree";

export interface Cell {
  x: number;
  z: number;
}

export interface Projectile {
  x: number;
  z: number;
  y: number;
  vx: number;
  vz: number;
  /** v0.27-3 垂直速度（可选）：哨塔火球从塔顶俯冲到目标高度；地面平射不填（0）。 */
  vy?: number;
  team: Team;
  dmg: number;
  life: number;
  knock: number;
  ox: number;
  oz: number;
}

export interface Ankh {
  team: Team;
  x: number;
  z: number;
}

export interface FxBolt {
  x0: number;
  z0: number;
  x1: number;
  z1: number;
  life: number;
}

export interface TeamState {
  /** v0.26 已删除 mana（总法力槽取消）；manaCap 仅作为神迹解锁进度保留。 */
  manaCap: number;
  /** 各技能独立充能槽（懒初始化，见 Sim.chargeState）。 */
  charges: Partial<Record<Tool, ChargeSlot>>;
  order: Order;
  magnetX: number;
  magnetZ: number;
  hasShaman: boolean;
  shamanRevive: number;
  wanted: BuildingKind[];
}

export function inMap(x: number, z: number): boolean {
  return x >= 0 && z >= 0 && x <= WORLD && z <= WORLD;
}

export function clamp(v: number, a: number, b: number): number {
  return v < a ? a : v > b ? b : v;
}

export function dist2(ax: number, az: number, bx: number, bz: number): number {
  const dx = ax - bx;
  const dz = az - bz;
  return dx * dx + dz * dz;
}

export function unitHp(kind: UnitKind, str: number): number {
  if (kind === "shaman") return 14;
  // v0.12：武士（盾+刀）恒为火战士（无甲远程脆皮）的 3 倍血量：24+3s = 3×(8+s)。
  if (kind === "warrior") return 24 + str * 3;
  if (kind === "preacher") return 7 + str;
  if (kind === "firewarrior") return 8 + str;
  if (kind === "spy") return 4 + str;
  if (kind === "wildman") return 3 + str * 2;
  return 3 + str * 3;
}

export function unitAttack(kind: UnitKind): number {
  return UNIT_ATTACK[kind];
}

export function unitRange(kind: UnitKind): number {
  return UNIT_RANGE[kind];
}

export function attackInterval(kind: UnitKind): number {
  return UNIT_ATK_CD[kind];
}

export function counterMult(atk: UnitKind, def: UnitKind): number {
  return COUNTER_MULT[atk]?.[def] ?? 1;
}

export function damageAfterArmor(atk: UnitKind, def: UnitKind): number {
  return Math.max(1, Math.round(unitAttack(atk) * counterMult(atk, def) - UNIT_ARMOR[def]));
}

export function unitDamageToBuilding(kind: UnitKind): number {
  return Math.max(1, Math.round(unitAttack(kind) * 0.6));
}

export function houseHp(level: number): number {
  return level === 3 ? 70 : level === 2 ? 36 : 18;
}

export function houseMaxPop(level: number): number {
  return level === 3 ? 10 : level === 2 ? 5 : 2;
}

// v0.15：全局人口上限已移除——传教感化会持续加人，出生被上限拦死会让所有茅屋假死；
// 生产只受"屋里是否有人"约束，人口数字仅作统计（HUD 显示子民数）。

// v0.11 生产速率：基础速率按等级，且每多一名住户加速（dwell=1 时即基础速率）。
export function houseBaseRate(level: number): number {
  return level === 3 ? 0.28 : level === 2 ? 0.18 : 0.1;
}

export const HOUSE_DWELL_BONUS = 0.12;

export function snapYaw(yaw: number): number {
  const step = Math.PI / 4;
  return Math.round(yaw / step) * step;
}

export function isTribe(team: Owner): team is Team {
  return team === 0 || team === 1;
}

export class RNG {
  s: number;
  constructor(seed: number) {
    this.s = seed >>> 0;
  }
  next(): number {
    this.s = (Math.imul(this.s, 1664525) + 1013904223) >>> 0;
    return this.s / 4294967296;
  }
  float(a: number, b: number): number {
    return a + (b - a) * this.next();
  }
  int(a: number, b: number): number {
    return Math.floor(this.float(a, b + 1 - 1e-9));
  }
  pick<T>(arr: T[]): T {
    return arr[this.int(0, arr.length - 1)]!;
  }
}
