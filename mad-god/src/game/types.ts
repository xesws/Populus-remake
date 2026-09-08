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

// v0.30 大龙（飞龙）：新作战单位 kind；dragonFactory = 大龙训练营（外观类似工厂）。
export type UnitKind =
  | "shaman"
  | "walker"
  | "warrior"
  | "preacher"
  | "firewarrior"
  | "spy"
  | "wildman"
  | "dragon"
  // v0.32 战船：两栖载具单位（船员 homeId 挂船，见 BoatSystem）。
  | "boat";
export type TrainKind = "warrior" | "preacher" | "firewarrior" | "spy";
export type BuildingKind =
  | "hut"
  | "warriorHut"
  | "temple"
  | "fireHut"
  | "spyHut"
  | "tower"
  | "rebirth"
  | "dragonFactory"
  // v0.32 船屋：住满 10 村民产船（见 ProductionSystem 船屋分支）。
  | "boathouse";

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
  // v0.30 大龙训练营：大厂房，6 捆木头。
  if (kind === "dragonFactory") return level >= 1 ? 0 : DRAGON_FACTORY_WOOD;
  // v0.32 船屋：训练营档（4 捆），单级，完工后 need 归零。
  if (kind === "boathouse") return level >= 1 ? 0 : BOATHOUSE_WOOD;
  return 0;
}

export const CHOP_TIME = 1.2;
// v0.28i 渐进式建造：木料交付后堆在地基上，建筑按 built += dt × BASE × (0.5 + 存木) 起升——
// 放的木头越多建得越快（两村民供木翻倍 + 存量更高 = 显著加速）。
export const BUILD_RATE_BASE = 0.3;
export const TRAIN_TIME = 4;
export const TREE_REGEN = 25;

export function isSoldier(kind: UnitKind): boolean {
  return kind === "warrior" || kind === "preacher" || kind === "firewarrior";
}

export function canConvert(kind: UnitKind): boolean {
  // v0.30 大龙是战争兵器，传教士/转化术说不动人。
  // v0.32 战船是器物不是人，不许感化（船员 homeId>0 本来就索敌不到）。
  return kind !== "shaman" && kind !== "preacher" && kind !== "dragon" && kind !== "boat";
}

export const UNIT_RADIUS: Record<UnitKind, number> = {
  shaman: 0.24,
  walker: 0.22,
  warrior: 0.25,
  preacher: 0.24,
  firewarrior: 0.25,
  spy: 0.22,
  wildman: 0.22,
  dragon: 0.9, // v0.30 龙体地面投影半径（命中/影环基准）
  boat: 0.8, // v0.32 船体半径（点选/命中/靠岸判定基准）
};

// v0.7 战斗数值表：伤害 = max(1, round(攻击 × 克制系数 − 受击护甲))，集中在此调参。
export const UNIT_ATTACK: Record<UnitKind, number> = {
  shaman: 3,
  walker: 2,
  warrior: 4, // v0.28b 平衡回调：6→4（原一刀带走村民太超模）
  preacher: 3,
  firewarrior: 5,
  spy: 3,
  wildman: 2,
  dragon: 0, // v0.30 大龙无直接攻击数值：伤害全部走吐息火 patch（衰减 DoT）
  boat: 0, // v0.32 船体无武器：伤害全靠船上船员（boatCombat 独立通道），船自己不开火
};

export const UNIT_ARMOR: Record<UnitKind, number> = {
  shaman: 0,
  walker: 0,
  warrior: 2,
  preacher: 1,
  firewarrior: 0,
  spy: 0,
  wildman: 0,
  dragon: 2, // v0.30 龙鳞：轻甲（对火战士 5 攻 → 3/发）
  boat: 1, // v0.32 木船壳：火战士 5 攻 → 4/发，150 血约 38 发，上岸集火可沉
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
  dragon: 10, // v0.30 喷火射程 = 索敌/脱锁半径
  boat: 0, // v0.32 船自己不开火（射程 0），只当载具与靶子
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
  dragon: 2.4, // v0.30 吐息间隔
  boat: 1.8, // v0.32 占位（船不开火，此值不用）
};

// 自动索敌半径（格）；0 = 不主动索敌、只还手。v0.8 生效；v0.19 武士 10 步、间谍 4 步；
// v0.23 武士 13、牛头人 8（射程 4.5 的 ~1.8 倍）——用户要求"范围广一点才能主动扑过去"。
// v0.27-2 扩过一轮：武士 13→20、牛头人 8→12、传教士 3→4.5。
// v0.27h 用户拍板回调：武士 20→8（近战索敌不该比远程牛头人 12 还大）。
// v0.28 大祭司入列近战索敌（跟随牵引）：0→6。
// v0.30 大龙 10（= 喷火射程；实际索敌由 DragonSystem 自己做，此值仅供数值表完整性）。
export const UNIT_SIGHT: Record<UnitKind, number> = {
  shaman: 6,
  walker: 0,
  warrior: 8,
  preacher: 4.5,
  firewarrior: 12,
  spy: 4,
  wildman: 0,
  dragon: 10,
  boat: 0, // v0.32 船不主动索敌（0＝只还手；还手由 boatCombat 接管船员，船体不还手）
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
// v0.28j 火球衰减：飞出 FIREBALL_RANGE_HARD 格后弹体燃尽，每帧 FIREBALL_FIZZLE_CHANCE 概率凭空熄灭
//（远程白嫖不再：25 格 ≈ 19 座房宽之外的目标基本打不着）。
export const FIREBALL_RANGE_HARD = 25;
export const FIREBALL_FIZZLE_CHANCE = 0.5;
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
// v0.28c 茅屋缩半（用户拍板：原 2.2/2.6 太大）：墙体 2.2→1.1、地基 2.6→1.3；
// 训练营不缩（本来就该是大建筑，见 CAMP_PAD）。
export const HOUSE_WALL = [0, 1.1, 1.1, 1.1] as const;
export const HOUSE_ROOF = [0, 1.1, 1.1, 1.1] as const;
export const HOUSE_PAD = [0, 1.3, 1.3, 1.3] as const;

/** v0.28c 训练营占地：保持大尺寸 2.6（茅屋缩半但训练营不缩，用户拍板）。 */
export const CAMP_PAD = 2.6;


// v0.27h 住户"上房"：茅屋住户站上屋顶（按等级的屋顶面高度），玩家可直接点选拉出。
// 高度对齐 render 的各级屋顶尖：L1 茅草尖 ~1.2 / L2 石檐 ~1.65 / L3 城堡顶 ~2.1。
export const HOUSE_ROOF_Y = [0, 1.2, 1.65, 2.1] as const;

// v0.27-3 哨塔 → v0.27f 瘦身加高：占地缩为小圆口径（TOWER_PAD 0.9，直径 ≈ 旧边长 1.8 的一半），
// 外观改为"魔法哨塔"——细高石柱 + 瞭望台 + 四面栅栏（栏间即窗口，驻塔牛战士可见/开火）+ 队色尖顶。
// 塔上射程与视野都是地面 2 倍：射程 4.5→9、锁敌 12→24（用户口径"哨塔上最远 3 倍距离"）；
// 火球发射原点在窗口高度（TOWER_TOP），弹道俯冲而出、永不与自家塔体判撞。
export const TOWER_PAD = 0.6; // v0.28c 地基贴塔身（建模宽 0.5，原 0.9 明显偏宽）
export const TOWER_DECK_Y = 3.38; // 瞭望台面高度（驻军站位 / 渲染基准）
export const TOWER_TOP = 3.9; // 火球发射原点（窗口高度，尖顶之下）
export const TOWER_RANGE_MULT = 1.5; // v0.28j 2→1.5：14 格太超模，现为 7×1.5=10.5 格
export const TOWER_SIGHT_MULT = 2;
export const TOWER_GARRISON_MAX = 3; // v0.28e 塔上最多驻 3 名牛战士
export const TOWER_CLIMB_T = 1.1; // 爬塔动画时长（秒）：从塔脚走到瞭望台

// ---------------------------------------------------------------------------
// v0.30 大龙（飞龙）与大龙训练营：全部数值集中在此调参。
// 训练链路：建 dragonFactory → 20 名牛战士（firewarrior）进驻（dwell 计数）→
// 满 20 开始生产（prod 0..1，60s）→ 完成后 20 名进驻者移除、大龙在工厂上空空降。
// ---------------------------------------------------------------------------
export const DRAGON_GARRISON_MAX = 20; // 进驻满员数（进驻条满格阈值）
export const DRAGON_PROD_T = 60; // 生产时长（秒）
export const DRAGON_HP = 600; // = 100 × 村民 6 血
export const DRAGON_SPEED = 1.5; // 飞行速度（村民 2.4，"偏慢"）
export const DRAGON_RANGE = 10; // 喷火射程 = 索敌半径 = 脱锁距离（格）
export const DRAGON_CRUISE = 2.2; // 巡航高度（贴地表上空）
export const DRAGON_ACQUIRE_INTERVAL = 0.4; // 索敌节流（秒）
export const DRAGON_SPAWN_DROP_Y = 6; // 空降初始高度（高于地表）
export const DRAGON_DROP_SPEED = 3; // 空降下降速度（格/秒）
export const DRAGON_FACTORY_PAD = 3.2; // 工厂地基（比训练营 2.6 大一圈）
export const DRAGON_FACTORY_WOOD = 6; // 工厂建造成本（木）
export const DRAGON_FACTORY_DOOR_REACH = 3.4; // 到门口该距离内即触发走进工厂（覆盖地基斜角站位 ~2.9~3.14）
export const DRAGON_FACTORY_ENTER_T = 0.6; // 走入动画时长（秒）
// 吐息：落地生成火 patch，持续燃烧一小会儿、伤害随剩余寿命线性衰减。
export const FIRE_PATCH_R = 1.2;
export const FIRE_PATCH_LIFE = 4.5;
export const FIRE_PATCH_DPS0 = 8; // 起始每秒伤害（不经过护甲，火烧）
export const FIRE_IMPACT_DMG = 2; // 吐息对点名目标的直接伤害
export const DRAGON_BREATH_SPEED = 9; // 吐息弹速（格/秒）

// ---------------------------------------------------------------------------
// v0.32 船屋＋战船（两栖载具）：全部数值集中在此调参。
// 链路：船屋住满 BOATHOUSE_DWELL 开工 → BOAT_BUILD_T 秒下水一条 → 同屋最多
// BOATHOUSE_FLEET_CAP 条存活（producedBoatIds 懒清理，沉一补一）；详见 BOAT.md。
// ---------------------------------------------------------------------------
export const BOAT_CAPACITY = 6; // 每船载员上限（第 7 人拒绝上船）
export const BOAT_HP = 150; // 船血量（≈2× L3 茅屋，火战士 4/发约 38 发）
export const BOAT_SPEED = 4.0; // 船速（村民 2.6，水上快车）
export const BOAT_BOARD_RANGE = 2.5; // 上船半径（人↔船）
export const BOAT_DOCK_RANGE = 2.5; // 停靠半径（船↔可走岸）：超此距红叉禁上船/禁下船
export const BOAT_FLOAT_Y = WATER + 0.15; // 吃水线（船体 y 钉在此，不跟地形）
export const SINK_T = 2.0; // 沉没动画时长（秒）：下沉＋倾斜，到 0 时船员团灭
// v0.32 船屋：单级建筑（无升级链），训练营尺寸/木料档。
export const BOATHOUSE_PAD = 2.6;
export const BOATHOUSE_WOOD = 4;
export const BOATHOUSE_DWELL = 10; // 住满开工线（produce 分支口径）
export const BOAT_BUILD_T = 25; // 住满后每条船生产时长（秒）
export const BOATHOUSE_FLEET_CAP = 3; // 同屋同时存活上限
// v0.32 船屋必须建在岸边：pad 为陆地（走既有 padReady）且此半径内有水格。
export const BOATHOUSE_WATER_RANGE = 7;
export const LAUNCH_RANGE = 6; // 下水半径（屋旁找水格出生）
export const BOATHOUSE_DECK_Y = 0.6; // 住户甲板站位高度（船屋建模带工作平台，仿哨塔 TOWER_DECK_Y）

export function houseHalf(level: number): number {
  const lv = level >= 3 ? 3 : level === 2 ? 2 : 1;
  return Math.max(HOUSE_WALL[lv], HOUSE_ROOF[lv]) / 2;
}

export function padSize(level: number): { w: number; d: number } {
  const lv = level >= 3 ? 3 : level === 2 ? 2 : 1;
  const s = HOUSE_PAD[lv];
  return { w: s, d: s };
}

/** v0.28c 各建筑的落基/完工占地：茅屋=padSize(级)，训练营=CAMP_PAD（不缩），哨塔=贴塔身。 */
export function sitePad(kind: BuildingKind): { w: number; d: number } {
  if (isCampKind(kind)) return { w: CAMP_PAD, d: CAMP_PAD };
  if (kind === "tower") return { w: TOWER_PAD, d: TOWER_PAD };
  // v0.30 大龙训练营：独立大厂房占地。
  if (kind === "dragonFactory") return { w: DRAGON_FACTORY_PAD, d: DRAGON_FACTORY_PAD };
  // v0.32 船屋：训练营尺寸（岸边大屋＋码头）。
  if (kind === "boathouse") return { w: BOATHOUSE_PAD, d: BOATHOUSE_PAD };
  return padSize(1);
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
  // v0.30 大龙：血量 = 100 个村民（6 血）= 600。
  if (kind === "dragon") return DRAGON_HP;
  // v0.28b 平衡回调（用户拍板）：武士 27→15（12+3s，原 3× 火战士太强）；
  // 火战士 9→10（9+s，脆皮略微加强）。武士对牛头人从两刀变三刀。
  if (kind === "warrior") return 12 + str * 3;
  if (kind === "preacher") return 7 + str;
  if (kind === "firewarrior") return 9 + str;
  if (kind === "spy") return 4 + str;
  if (kind === "wildman") return 3 + str * 2;
  // v0.32 战船血量（与 str 无关，船不吃力量加成）。
  if (kind === "boat") return BOAT_HP;
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

// v0.15 全局人口上限曾移除（出生被拦死导致茅屋假死）。
// v0.28h 重新引入**分队**人口上限（用户拍板，性能考虑）：蓝 350 / 红 200。
// 与旧实现的关键区别：到上限时茅屋只是**暂停出生（进度保留）**，人口一降下一帧立即
// 恢复生产，绝不丢弃进度——不会再现 v0.15 之前的假死/卡死。上限是可变 Record，
// 测试可临时改小（用完记得还原）。
export const POP_CAP: Record<Team, number> = { [BLUE]: 350, [RED]: 200 };

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
