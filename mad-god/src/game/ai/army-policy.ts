// v0.37 敌方 AI：军事策略口径（纯策略，无状态、只读 Sim）——全军唯一的"该有多少兵、由什么兵组成、
// 大龙还缺几人、下一波门槛多高"的算法来源。
//
// 为什么单独成模块：编制口径被三个子脑同时使用（训兵子脑算缺口、军事子脑算门槛与驻防优先级、
// 大龙计划算征召名额）。旧实现把这些数字散落在各子脑的 if 里（armyCap=8 / fireMin=1 / waveSize=3），
// 一处改动要同步三处、且无法单测。现在全部收敛到本类的纯函数上：
// 传入 (team, profile, sim) → 返回数字，不写任何状态、不下发任何指令。
//
// 口径约定（v0.37）：
// - **野战军 fieldForce**：战斗兵（武士/牛战士/传教士）中 homeId===0 且 targetId===0 者。
//   排除驻塔/驻厂（homeId>0，已被建筑吸收）、正在赶往哨塔或大龙训练营的（targetId>0，已在途驻防）、
//   以及间谍（侦察兵，不计进攻力）。
// - **人口 pop**：sim.countPop(team)（村民 + 士兵 + 大龙；船不占人口）。
// - **军力 armyTarget**：clamp(round(pop × armyRatio), armyFloor, armyMax)。
// - 大龙计划的进厂牛战士**不占**野战军编制（它们是消耗品），但占 armyMax + 征召名额的硬顶。

import type { Sim } from "../sim";
import { DRAGON_GARRISON_MAX, isSoldier, POP_CAP, Team, UnitKind } from "../types";
import type { AIProfile } from "./ai-profile";

export class ArmyPolicy {
  constructor(readonly profile: AIProfile) {}

  /** 野战军构成（人数口径，见文件头注释）。 */
  fieldForce(sim: Sim, team: Team): number {
    let n = 0;
    for (const u of sim.units) {
      if (u.team !== team || u.hp <= 0) continue;
      if (!isSoldier(u.kind)) continue;
      if (u.homeId > 0 || u.targetId > 0) continue;
      n++;
    }
    return n;
  }

  /** 野战军中的武士/牛战士人数（其余为传教士）。 */
  fieldKind(sim: Sim, team: Team, kind: "warrior" | "firewarrior"): number {
    let n = 0;
    for (const u of sim.units) {
      if (u.team !== team || u.hp <= 0 || u.kind !== kind) continue;
      if (u.homeId > 0 || u.targetId > 0) continue;
      n++;
    }
    return n;
  }

  /** 全军（含驻塔/驻厂/在途）战斗兵人数：仅用于日志与断言。 */
  totalFighters(sim: Sim, team: Team): number {
    let n = 0;
    for (const u of sim.units) {
      if (u.team === team && u.hp > 0 && isSoldier(u.kind)) n++;
    }
    return n;
  }

  /**
   * v0.37 **编制口径的军队人数**：野战军 + 驻塔/哨塔在途，**不含大龙计划的牛战士**
   *（已进厂 dwell 的 + 正在赶往工厂的）。
   *
   * 为何要把大龙计划的牛战士剔出去：它们是"已经付过钱的消耗品"，最终会变成龙而不是野战军。
   * 旧口径用"全军战斗兵 ≥ armyMax + 剩余征召名额"当硬顶，征召名额随着进驻而缩小，
   * 而进驻者仍被算在分子里——于是**名额收稿到 3 时硬顶反而低于现有兵力，训练永久停摆、
   * 工厂卡在 17/20 出不了龙**（实测探针复现）。按本口径，硬顶只看野战/驻塔部分。
   */
  armyCommitted(sim: Sim, team: Team): number {
    const factoryIds = new Set<number>();
    for (const b of sim.buildings) {
      if (b.team === team && b.kind === "dragonFactory" && b.hp > 0 && b.level >= 1) factoryIds.add(b.id);
    }
    let n = 0;
    for (const u of sim.units) {
      if (u.team !== team || u.hp <= 0 || !isSoldier(u.kind)) continue;
      if (u.homeId > 0 && factoryIds.has(u.homeId)) continue; // 已进厂的牛战士
      if (u.homeId === 0 && factoryIds.has(u.targetId)) continue; // 正在赶往工厂的牛战士
      n++;
    }
    return n;
  }

  /**
   * 编制硬顶是否已达（armyMax）：只看 armyCommitted。
   * 大龙计划的牛战士不受本上限约束——否则名额与上限互相卡死，龙永远出不来。
   */
  atArmyCeiling(sim: Sim, team: Team): boolean {
    return this.armyCommitted(sim, team) >= this.profile.armyMax;
  }

  /** 常备军目标（军力）：随人口滚动，最少 armyFloor、最多 armyMax。 */
  armyTarget(sim: Sim, team: Team): number {
    const raw = Math.round(sim.countPop(team) * this.profile.armyRatio);
    return Math.max(this.profile.armyFloor, Math.min(this.profile.armyMax, raw));
  }

  /** 目标编成：牛战士 = 常备军 × fireRatio，其余为武士。 */
  compositionTarget(sim: Sim, team: Team): { warrior: number; firewarrior: number } {
    const total = this.armyTarget(sim, team);
    const firewarrior = Math.round(total * this.profile.fireRatio);
    return { warrior: total - firewarrior, firewarrior };
  }

  /** 武士编制缺口（0 = 满编）：野战军缺口与 warriorMin 保底取较大者。 */
  warriorGap(sim: Sim, team: Team): number {
    const want = this.compositionTarget(sim, team).warrior;
    const field = this.fieldKind(sim, team, "warrior");
    const floor = this.profile.warriorMin - this.countKind(sim, team, "warrior");
    return Math.max(0, want - field, floor);
  }

  /**
   * 牛战士编制缺口（0 = 满编）：常备军配比缺口 + 大龙计划的进厂征召名额。
   * 大龙计划跑起来后牛战士们优先喂给工厂——这正是"拿火武士去训大龙"的配额接线。
   */
  firewarriorGap(sim: Sim, team: Team): number {
    const want = this.compositionTarget(sim, team).firewarrior;
    const field = this.fieldKind(sim, team, "firewarrior");
    const floor = this.profile.fireMin - this.countKind(sim, team, "firewarrior");
    return Math.max(0, want - field, floor) + this.dragonConscriptNeed(sim, team);
  }

  /**
   * 训兵硬顶：不再用"armyMax + 征召名额"这种动态上限（会与征召名额互相卡死，见 armyCommitted 注释）。
   * 判定直接走 atArmyCeiling；本方法保留为"本档实际能养多少兵"的展示口径。
   */
  armyCeiling(sim: Sim, team: Team): number {
    return this.profile.armyMax + this.dragonConscriptNeed(sim, team);
  }

  /**
   * 可动员的住户数（v0.37 战争经济）：人口已到分队上限时茅屋本就停产（produce 在 POP_CAP 处只暂停、
   * 不丢进度），此时屋里的人是不产生任何收益的纯冗余人口，可以拉出来当兵；
   * 每座茅屋至少留 1 名住户——保住"住户生产-新生儿"这条链条，营房不会因为抽空住户而彻底停摆。
   *
   * 为何需要它：探针实测（pop 卡在 200）——户外空闲村民被抽完后，AI 就只能干等新生儿，
   * 大龙计划永远卡在 12/20。这正是用户口径里的"从来不知道主动把大量村民转化为更多武士"。
   */
  surplusDwellers(sim: Sim, team: Team): number {
    if (sim.countPop(team) < POP_CAP[team] - 1) return 0; // 未到人口上限：住户还在生产，不动
    let huts = 0;
    for (const b of sim.buildings) {
      if (b.team === team && b.kind === "hut" && b.level >= 1 && b.hp > 0) huts++;
    }
    let dwellers = 0;
    for (const u of sim.units) {
      if (u.team !== team || u.hp <= 0 || u.kind !== "walker") continue;
      if (u.homeId > 0) dwellers++;
    }
    return Math.max(0, dwellers - Math.max(1, huts));
  }

  // ── 大龙计划 ────────────────────────────────────────────────────────────

  /** 大龙计划是否推进中：人口达标、名额未满（含在生产中的龙）。 */
  dragonProgramActive(sim: Sim, team: Team): boolean {
    const p = this.profile;
    if (p.dragonCap <= 0 || p.dragonPopMin <= 0) return false;
    if (sim.countPop(team) < p.dragonPopMin) return false;
    return this.dragonCount(sim, team) < p.dragonCap;
  }

  /** 大龙条数：已出厂的 + 工厂满员生产中（60s 后必然出厂）的。 */
  dragonCount(sim: Sim, team: Team): number {
    let n = this.countKind(sim, team, "dragon");
    for (const b of sim.buildings) {
      if (b.team !== team || b.hp <= 0 || b.kind !== "dragonFactory" || b.level < 1) continue;
      if (b.dwell >= DRAGON_GARRISON_MAX) n++;
    }
    return n;
  }

  /** 本队 L1 大龙训练营（无则 null）。 */
  dragonFactory(sim: Sim, team: Team): { id: number; dwell: number; x: number; z: number } | null {
    const b = sim.buildings.find(
      (o) => o.team === team && o.hp > 0 && o.kind === "dragonFactory" && o.level >= 1,
    );
    return b ? { id: b.id, dwell: b.dwell, x: b.x, z: b.z } : null;
  }

  /**
   * 大龙还缺多少牛战士进厂（0 = 不征召）：
   * 计划未启动 / 工厂没落成 / 工厂还在生产（dwell 满）→ 0；否则 = 20 − 已进驻 − 在途。
   */
  dragonConscriptNeed(sim: Sim, team: Team): number {
    if (!this.dragonProgramActive(sim, team)) return 0;
    const f = this.dragonFactory(sim, team);
    if (!f) return 0;
    const inbound = this.inboundFirewarriors(sim, team, f.id);
    const got = f.dwell + inbound;
    return Math.max(0, DRAGON_GARRISON_MAX - got);
  }

  /** 已领命赶往工厂（targetId 指向该厂）的牛战士数——与驻塔名额计算同款，防超派堵门。 */
  inboundFirewarriors(sim: Sim, team: Team, factoryId: number): number {
    let n = 0;
    for (const u of sim.units) {
      if (u.team !== team || u.hp <= 0 || u.kind !== "firewarrior") continue;
      if (u.homeId === 0 && u.targetId === factoryId) n++;
    }
    return n;
  }

  /**
   * 是否轮到大龙计划垄断牛战士：还在囤人时，哨塔停止征兵驻塔（塔可以等，龙不能等）。
   * v0.37 由军事子脑在驻塔前调用——避免同一批空闲牛战士被塔和工厂两头抢。
   */
  dragonNeedsConscripts(sim: Sim, team: Team): boolean {
    return this.dragonConscriptNeed(sim, team) > 0;
  }

  // ── 波次门槛（惨败加码）────────────────────────────────────────────────

  /**
   * 下一波门槛：惨败（战损比例 ≥ waveRetreatRatio）加 step，打得还行则回落 2（不低于首波门槛）。
   * 纯函数便于单测；离散波次门槛由军事子脑持有状态。
   */
  nextWaveForce(current: number, lostRatio: number): number {
    const p = this.profile;
    if (lostRatio >= p.waveRetreatRatio) return Math.min(p.waveForceMax, current + p.waveForceStep);
    return Math.max(p.waveForce, current - 2);
  }

  /** 门槛夹取：任何来路（含测试直接注入）的门槛都夹在 [waveForce, waveForceMax]。 */
  clampWaveForce(current: number): number {
    return Math.max(this.profile.waveForce, Math.min(this.profile.waveForceMax, current));
  }

  private countKind(sim: Sim, team: Team, kind: UnitKind): number {
    let n = 0;
    for (const u of sim.units) {
      if (u.team === team && u.hp > 0 && u.kind === kind) n++;
    }
    return n;
  }
}
