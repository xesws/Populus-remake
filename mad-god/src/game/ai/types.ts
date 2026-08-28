// v0.17 敌方 AI 系统：模块间接口协议（schema 契约文件之一）。
// 各子脑（Director）只依赖本文件与 AIProfile，互不 import 彼此实现——保证可并行开发与替换。
// 驱动原则：AI 只通过 Sim 既有接口（order/targetId/atkId/magnet/train）下发意图，
// 不侵入移动/寻路/生产等系统内部。

import type { Sim } from "../sim";
import type { Team } from "../types";
import type { AIProfile } from "./ai-profile";

/** TribeBrain 战略状态机：发展 → 攒兵 → 进攻 → 重整 → 循环；被袭时由 WarDirector 即时防御，不切状态。 */
export type StrategicState = "develop" | "growArmy" | "attack" | "regroup";

/** 所有子脑的共同契约。 */
export interface ITribeDirector {
  readonly team: Team;
  readonly profile: AIProfile;
  /** 每帧由 TribeBrain 调用（内部自行做周期节流）。 */
  update(sim: Sim, dt: number): void;
}

/**
 * 经济子脑契约（EconomyDirector 实现）。
 * 职责：入住指派（修"红方永不入住→不生产"断链）、训兵供给、法力扩张平地。
 */
export interface IEconomyDirector extends ITribeDirector {
  /** 经济健康度 0~1：茅屋入住率与人口规模的综合评分，供状态机迁移使用。 */
  economyScore(sim: Sim): number;
}

/**
 * 军事子脑契约（WarDirector 实现）。
 * 职责：进攻波次、被袭防御响应（onHurt 由 sim.onTeamHurt 钩子转发）。
 */
export interface IWarDirector extends ITribeDirector {
  /** 当前士兵总数（warrior/preacher/firewarrior/spy）。 */
  armySize(sim: Sim): number;
  /** 波次就绪：兵力 ≥ profile.waveSize 且距上一波 ≥ profile.waveGapSec。 */
  waveReady(sim: Sim): boolean;
  /** 发动进攻：setOrder(team,"fight") + magnet 锁定敌方建筑/单位密集点。返回是否真的发起。 */
  launchWave(sim: Sim): boolean;
  /** 收兵回防：setOrder(team,"settle")，magnet 拉回自家聚落。 */
  recall(sim: Sim): void;
  /** 防御响应入口：本队单位/建筑在 (x,z) 受袭时被调用；内部按 profile.reactSec 延迟后就近派兵反击。 */
  onHurt(sim: Sim, x: number, z: number): void;
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
