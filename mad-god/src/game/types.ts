export const WORLD = 52;
export const SIZE = WORLD;
export const RES = 4;
export const STEP = 0.25;
export const SAMPLES = 209;
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

// 攻击距离（格）。火战士 v0.9 起为远程火球。
export const UNIT_RANGE: Record<UnitKind, number> = {
  shaman: 0.95,
  walker: 0.95,
  warrior: 0.95,
  preacher: 0.95,
  firewarrior: 4.5,
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

// 自动索敌半径（格）；0 = 不主动索敌、只还手。v0.8 生效。
export const UNIT_SIGHT: Record<UnitKind, number> = {
  shaman: 0,
  walker: 0,
  warrior: 3.5,
  preacher: 3.0,
  firewarrior: 5.5,
  spy: 0,
  wildman: 0,
};

// 克制系数（攻击方 → 受击方，缺省 1）。
export const COUNTER_MULT: Partial<Record<UnitKind, Partial<Record<UnitKind, number>>>> = {
  firewarrior: { walker: 1.2 },
};

// 自动索敌/还手的追击拴绳（格）：自动获得的目标离锚点超过该距离就放弃；玩家手动指令不受拴绳限制。
export const AGRO_LEASH = 8;

// v0.9/v0.12 火球参数：弹速、暴击击飞（落地即死）与默认击退倒地。
export const FIREBALL_SPEED = 4;
export const FIRE_CRIT_CHANCE = 0.2; // 暴击：像闪电一样真正打飞，摔下来直接死亡
export const FIRE_KNOCK_DIST = 0.5; // 默认命中：随机方向击退半格并倒地
export const FIRE_DOWN_TIME = 0.9; // 倒地时长，站起瞬间才结算伤害

// v0.12 武士暴击：概率击退并追加伤害（村民/传教士/间谍/萨满无暴击）。
export const WARRIOR_CRIT_CHANCE = 0.5;
export const WARRIOR_CRIT_MULT = 2;
export const WARRIOR_CRIT_KNOCK_MIN = 2;
export const WARRIOR_CRIT_KNOCK_MAX = 3;

// v0.16 传教士感化：站桩引导转化身边野人/敌方单位（祭司与传教士免疫感化）。
export const PREACH_REACH = 1.25; // 引导射程（格），站桩不追击
export const PREACH_TIME = 1.35; // 引导时长（秒），中途目标离开则重来

// v0.11a 修复：房屋升级不再扩大占地（否则升级会把邻居挤掉）。各级 pad / 墙体面积恒定为 L1 尺寸，只许长高。
export const HOUSE_WALL = [0, 2.2, 2.2, 2.2] as const;
export const HOUSE_ROOF = [0, 2.2, 2.2, 2.2] as const;
export const HOUSE_PAD = [0, 2.6, 2.6, 2.6] as const;

export function houseHalf(level: number): number {
  const lv = level >= 3 ? 3 : level === 2 ? 2 : 1;
  return Math.max(HOUSE_WALL[lv], HOUSE_ROOF[lv]) / 2;
}

export function padSize(level: number): { w: number; d: number } {
  const lv = level >= 3 ? 3 : level === 2 ? 2 : 1;
  const s = HOUSE_PAD[lv];
  return { w: s, d: s };
}

export type Order = "settle" | "gather" | "fight" | "shaman";
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
  | "armageddon";

export const TOOL_COST: Record<Tool, number> = {
  select: 0,
  raise: 7,
  lower: 5,
  lightning: 20,
  quake: 50,
  swamp: 36,
  volcano: 80,
  tornado: 55,
  blast: 28,
  armageddon: 100,
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
};

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
  mana: number;
  manaCap: number;
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
