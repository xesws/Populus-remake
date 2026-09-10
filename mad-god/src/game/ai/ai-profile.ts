// v0.17 敌方 AI 系统：难度配置类（schema 契约文件之一）。
// 全部 AI 节奏参数集中于此——调难度 = 换一个 AIProfile 实例，不改任何逻辑代码。
// 三档预设：easy（慢/小波/迟钝）、normal（当前强度基准）、hard（快/大波/激进）。
//
// v0.37 军事升级：旧口径 armyCap=8 / waveSize=3 是"AI 只有不到 10 个武士、只会派 1~3 人骚扰"
// 的根因。现改为**按人口滚动的编制配额 + 集团波次 + 大龙计划**：
//   - 常备军 = clamp(人口 × armyRatio, armyFloor, armyMax)，其中 fireRatio 为牛战士占比；
//   - 每座训练营独立排队（queueDepth）与独立节流（trainGapSec）→ 武士营与牛战士营并行出人；
//   - 波次门槛 waveForce 随战损加码（waveForceStep / waveForceMax），失败越大下次来得越多；
//   - 人口达 dragonPopMin 后启动大龙计划：建大龙训练营 → 囤 20 名牛战士 → 空降大龙。
//
// v0.38 群众路线（用户拍板 "军事人口上限改成 100"）：
//   - armyMax normal 24→**100**（= 红方 200 人口的一半）、hard 140；armyRatio 0.3→**0.5**。
//     旧上限下 AI 常常 200 人口只养 24 个兵，其余全在茅屋里待着。
//   - trainGapSec normal 8→**5**：单营训完一人需 TRAIN_TIME/0.75 ≈ 5.33s，节流 8s 会让每座营
//     每轮空转 2.7s—
//     100 人的编制要靠两座营一刻不停地出人才能填满（双营约 22 人/分钟）。
//   - waveForceMax normal 20→**40**：大军压上时不要再被 20 人的门槛卡住。
//   - dragonCap 语义改为"**每局总共几条**"（不再看场上存活数）：旧口径下龙一死就重新开龙厂，
//     实测 9 分钟喂掉 40 名牛战士；另加龙的软目标与低血撤离（见 dragonRetreatHp）。

export class AIProfile {
  /** 决策周期（秒）：TribeBrain 每隔该时长思考一次 */
  tickSec = 1.0;
  /** 每座茅屋期望入住村民数（经济优先度；越高人口滚得越快） */
  occupyTarget = 2;
  /** 每座训练营自己的训兵节流（秒）：v0.37 起按营独立计时，不再全局串行；
   *  v0.38：normal 8→5（红方单营训一人约 5.33s，节流 5 = 营地近乎不停机） */
  trainGapSec = 5;
  /** 出兵下限（军力）：人口再少也保底的常备军规模 */
  armyFloor = 4;
  /** 常备军占人口比例：目标军力 = clamp(round(人口 × armyRatio), armyFloor, armyMax) */
  armyRatio = 0.5;
  /** 常备军上限（含野战军；大龙计划的进厂牛战士另计配额）：normal 100 = 红方 200 人口的一半 */
  armyMax = 100;
  /** 牛战士（firewarrior）占常备军的目标比例：0 = 只出武士 */
  fireRatio = 0.5;
  /** 村民劳动保底（名）：始终留出不参与征召的户外村民 伐木/搬运/建营/入住 */
  laborFloor = 2;
  /** 单座训练营同时排队人数（含正在训的那名）：让营地不停机 */
  queueDepth = 2;
  /** 首波进攻门槛（军力 = 可出击士兵数） */
  waveForce = 8;
  /** 每惨败一波（战损 ≥ waveRetreatRatio）下一次波次门槛加码 */
  waveForceStep = 4;
  /** 波次门槛上限：再惨败也不超过这个兵力才出发（normal 40 = 常备军上限的 4 成） */
  waveForceMax = 40;
  /** 两波进攻之间的冷却（秒） */
  waveGapSec = 45;
  /** 单波最长持续时间（秒）：超时即收兵重整，不许在外面磨成添油 */
  waveTimeoutSec = 60;
  /** 收兵线：波次兵力掉到出发时的该比例即撤退 */
  waveRetreatRatio = 0.5;
  /** 集结窗口上限（秒）：攒够兵后在集结点最多再等这么久，到点必须出发 */
  marshalSec = 12;
  /** 受袭驰援兵力上限（名）：留守池派兵，绝不拆散正在进攻的波次 */
  defenseSize = 4;
  /** 老家告警半径（格）：波次在外时，此半径内受袭即判定老家告急、整波回防 */
  homeThreatR = 14;
  /** 被击反应延迟（秒）：部落防御响应的迟钝程度——难度核心人机差异 */
  reactSec = 1.5;
  /** 扩张野心 0~1：法力花在平地/开拓新宅基地的比例 */
  expandDrive = 0.5;
  /** 施法激进度 0~1：越高施法冷却越短、越敢砸大法术 */
  spellAggro = 0.6;
  /** v0.31 同时存在的哨塔上限（含 L0 地基）：0 = 不造塔 */
  towerCap = 2;
  /** v0.31 两次落塔之间的最小间隔（秒） */
  towerGapSec = 45;
  /** v0.34 常备武士下限：缺口优先补，不因战死重跑兵种阶梯 */
  warriorMin = 2;
  /** v0.34 常备牛战士（firewarrior）下限：武士营落成后并行开训 */
  fireMin = 1;
  /** v0.35 建营机动名额：训兵保底 = 入住需求 + 该值，禁止把村民训光 */
  founderSlack = 1;
  /** v0.37 传教士上限（神庙线 Trickle，不占用常备军配额） */
  preacherMax = 2;
  /** v0.37 间谍上限（间谍营线 Trickle） */
  spyMax = 1;
  /** v0.37 大龙计划启动人口：人口达到该值开始建大龙训练营并囤 20 牛战士；0 = 本档不追龙 */
  dragonPopMin = 24;
  /** v0.37 大龙条数上限：v0.38 起口径为**每局总条数**（不为场上存活数）——
   *  旧口径下龙一被集火秒掉就重新开龙厂又喂 20 名牛战士，实测 9 分钟能把整支牛战士军团喂光。 */
  dragonCap = 1;
  /** v0.38 大龙低血撤离线（血量占比）：低于此比例飞回自家保命（龙不回血，硬拼就是白送） */
  dragonRetreatHp = 0.35;
  /** v0.38 大龙软目标威胁半径（格）：候选建筑此半径内的敌方军事单位（含塔）越少越优先 */
  dragonSoftRadius = 12;
  /** v0.37 大龙出动指令节流（秒）：无目标时每隔这么久把龙重新压向敌方密集点 */
  dragonOrderSec = 8;
  /** v0.37 大龙是否允许跨海作战（分岛图：红方无船，只有龙够得到对岸） */
  dragonCrossSea = true;

  static easy(): AIProfile {
    const p = new AIProfile();
    p.tickSec = 1.6;
    p.occupyTarget = 1;
    p.trainGapSec = 10;
    p.armyFloor = 2;
    p.armyRatio = 0.25;
    p.armyMax = 30;
    p.fireRatio = 0.3;
    p.laborFloor = 1;
    p.queueDepth = 1;
    p.waveForce = 4;
    p.waveForceStep = 2;
    p.waveForceMax = 10;
    p.waveGapSec = 90;
    p.waveTimeoutSec = 45;
    p.waveRetreatRatio = 0.6;
    p.marshalSec = 18;
    p.defenseSize = 2;
    p.reactSec = 3.0;
    p.expandDrive = 0.3;
    p.spellAggro = 0.35;
    p.towerCap = 1;
    p.towerGapSec = 90;
    p.preacherMax = 1;
    p.spyMax = 1;
    p.dragonPopMin = 0;
    p.dragonCap = 0;
    p.dragonCrossSea = false;
    return p;
  }

  static normal(): AIProfile {
    return new AIProfile(); // 字段默认值即 normal 基准
  }

  static hard(): AIProfile {
    const p = new AIProfile();
    p.tickSec = 0.7;
    p.occupyTarget = 3;
    p.trainGapSec = 3;
    p.armyFloor = 6;
    p.armyRatio = 0.6;
    p.armyMax = 140;
    p.fireRatio = 0.5;
    p.laborFloor = 3;
    p.queueDepth = 3;
    p.waveForce = 10;
    p.waveForceStep = 5;
    p.waveForceMax = 60;
    p.waveGapSec = 30;
    p.waveTimeoutSec = 75;
    p.waveRetreatRatio = 0.4;
    p.marshalSec = 9;
    p.defenseSize = 6;
    p.reactSec = 0.6;
    p.expandDrive = 0.75;
    p.spellAggro = 0.9;
    p.towerCap = 3;
    p.towerGapSec = 30;
    p.preacherMax = 2;
    p.spyMax = 1;
    p.dragonPopMin = 18;
    p.dragonCap = 1;
    p.dragonOrderSec = 6;
    return p;
  }
}
