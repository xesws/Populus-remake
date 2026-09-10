// v0.17 敌方 AI 系统：模块间接口协议（schema 契约文件之一）。
// 各子脑（Director）只依赖本文件与 AIProfile，互不 import 彼此实现——保证可并行开发与替换。
// 驱动原则：AI 只通过 Sim 既有接口（order/targetId/atkId/magnet/train/assignCampFounder/leaveBuilding）下发意图，
// 不侵入移动/寻路/生产等系统内部。

import type { Sim } from "../sim";
import type { Team } from "../types";
import type { AIProfile } from "./ai-profile";

/** TribeBrain 战略状态机：发展 → 攒兵 → 集结 → 进攻 → 重整 → 循环；
 *  被袭时由 WarDirector 即时防御，不切状态。
 *  v0.37 新增 marshal（集结）：兵力攒到门槛后先把队伍在自家前沿收紧，成型才整队压上——
 *  旧状态机只有 develop→growArmy→attack，兵一到 3 人就出门，看起来就是零散骚扰。 */
export type StrategicState = "develop" | "growArmy" | "marshal" | "attack" | "regroup";

/** 所有子脑的共同契约。 */
export interface ITribeDirector {
  readonly team: Team;
  readonly profile: AIProfile;
  /** 每帧由 TribeBrain 调用（内部自行做周期节流）。 */
  update(sim: Sim, dt: number): void;
}

/**
 * 经济子脑契约（EconomyDirector 实现）。
 * 职责：入住指派（修"红方永不入住→不生产"断链）、法力扩张平地。
 * v0.34 训兵/建营已拆到 ITrainingDirector，不再由经济子脑副作用触发。
 */
export interface IEconomyDirector extends ITribeDirector {
  /** 经济健康度 0~1：茅屋入住率与人口规模的综合评分，供状态机迁移使用。 */
  economyScore(sim: Sim): number;
}

/**
 * 训兵子脑契约（TrainingDirector 实现）。
 * 职责：营地维护（缺营派建、雷电拆营后重建；v0.37 含大龙训练营）与编制补缺。
 * v0.37：四条产线（武士营/牛战士营/神庙/间谍营）各自排队与冷却，缺口由 ArmyPolicy 的
 * 常备军配额（随人口滚动 + 大龙征召名额）决定；每座营不再被全局 trainCd 杖着一起空转。
 */
export interface ITrainingDirector extends ITribeDirector {}

/**
 * 军事子脑契约（WarDirector 实现）。
 * 职责：姿态（守家/集结）、进攻集团波次、被袭防御响应（onHurt 由 sim.onTeamHurt 钩子转发）。
 * v0.37：门槛与战损结算由本类自持（waveThreshold），战略大脑只问“能不能发、该不该撒”。
 */
export interface IWarDirector extends ITribeDirector {
  /** 当前士兵总数（warrior/preacher/firewarrior/spy，含在途征召者）。 */
  armySize(sim: Sim): number;
  /** v0.37 可出击兵力：野战军中未在途驻防者（波次门槛口径）。 */
  readyForce(sim: Sim): number;
  /** 波次就绪：可出击兵力 ≥ 当前门槛（waveThreshold）且距上一波 ≥ waveGapSec。 */
  waveReady(sim: Sim): boolean;
  /** v0.37 守家姿态：锚点回自家聚落 + 空闲士兵归队（发展/攒兵/重整期调用）。 */
  hold(sim: Sim): void;
  /** v0.37 集结姿态：锚点前移到前沿 + 逐兵下发集合令（集结期每周期调用，幂等）。 */
  marshal(sim: Sim): void;
  /** v0.37 集结完成：兵力达门槛且主力到位（或集结窗口超时）。 */
  gathered(sim: Sim): boolean;
  /** 发波：setOrder 已删，改为逐一 sendMove 到集火点 + atkId 挂同一焦点目标。返回是否真发起。 */
  launchWave(sim: Sim): boolean;
  /** v0.37 波次中续压：焦点被拆/漂移后给无目标士兵补挂新焦点。 */
  commandWave(sim: Sim): void;
  /** v0.37 该不该收兵：战损过半 / 超时 / 老家告急 / 敌方已无目标。 */
  shouldRecall(sim: Sim): boolean;
  /** 收兵回防：逐兵回撤自家聚落 + 战损结算（决定下一波门槛）。 */
  recall(sim: Sim): void;
  /** v0.37 集结长期发不出去（隔海无路等）→ 放弃本轮。 */
  marshalStalled(sim: Sim): boolean;
  /** 防御响应入口：本队单位/建筑在 (x,z) 受袭时被调用；内部按 profile.reactSec 延迟后就近派兵反击。 */
  onHurt(sim: Sim, x: number, z: number): void;
}

/**
 * 大龙计划子脑契约（DragonDirector 实现）。
 * 职责：把空闲牛战士逐步送进大龙训练营（20 名满员开工），并在大龙出厂后把它压向敌方密集点。
 * 建厂不归它：人口达标后由训兵子脑的营地愿望单落地（见 RosterPolicy.wantedCamps）。
 */
export interface IDragonDirector extends ITribeDirector {
  /** 还缺多少牛战士进厂（0 = 不征召：计划未启动 / 工厂未落成 / 已满员 / 已出厂）。 */
  conscriptNeed(sim: Sim): number;
  /** 已拥有的大龙数（含工厂满员生产中的一条）。 */
  dragonCount(sim: Sim): number;
}

/**
 * 神力子脑契约（SpellDirector 实现）。
 * 职责：进攻性施法（火山/末日）与聚落平地维护；冷却乘 1/profile.spellAggro。
 * 无额外语义，实现自旧 GodAI 迁移。
 */
export interface ISpellDirector extends ITribeDirector {}

/**
 * sim.onTeamHurt 钩子约定（Sim 上的可空字段）：
 *   onTeamHurt?: (team: Team, x: number, z: number) => void
 * - 调用方：火球命中（fireballHit，含发射点方向信息）与法术伤害结算处，
 *   以【被伤害方】的 team 与事发坐标调用；仅对部落（BLUE/RED）调用，野人(NEUTRAL)不调。
 * - 订阅方：AIDirector 接线时把它指到对应 TribeBrain 的 war.onHurt（按 team 分发）。
 * - 钩子可为空（无 AI 时），调用方必须用 `sim.onTeamHurt?.(...)` 形式。
 */
export type TeamHurtHook = (team: Team, x: number, z: number) => void;
