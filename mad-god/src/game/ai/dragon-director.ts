// v0.37 敌方 AI：大龙计划子脑（DragonDirector）——"拿火武士训练大龙"这条链路的执行端。
// v0.38 两处战术修正：① 出动改打**软目标**（附近敌方军事单位/塔最少的建筑）——旧实现扑敌方
// 密集点＝玩家主力与塔群正上方，600 血的龙孤身进去必被集火；② 低血撤离（dragonRetreatHp）。
// 另外 dragonCap 语义改为每局总条数（龙死了不再重开龙厂又喂 20 名牛战士）。
//
// 职责边界（OOP 可分离）：
//   - 大龙训练营**怎么建**不在这里：人口达标即由 ArmyPolicy.dragonProgramActive 通告，
//     训兵子脑的 wantedCamps 把 dragonFactory 当第五座营地，走既有建营链路（落基/运木/
//     看门狗/被拆重建）——零新系统。
//   - 本类只做两件事：
//     ① 征召：把空闲牛战士逐批送进厂（sendMove 到厂边 + targetId 指厂，与驻塔同构，
//        thinkUnits.tryEnterFactory 在门口自动进驻，满 20 由 DragonSystem 开工）；
//     ② 出动：大龙出厂后，无目标时把它重新压向敌方密集点（Targeting.assaultFocus），
//        按 profile.dragonCrossSea 决定是否跨海——分岛图红方无船，只有龙够得到对岸。
//   - 需求口径（还缺多少牛战士）来自 ArmyPolicy：训兵子脑与本类读同一份纯策略，
//     不存在"两个子脑各自算一遍、算错就互相抢人"的可能。

import { logger } from "../logger";
import type { Sim } from "../sim";
import { DRAGON_GARRISON_MAX, Team } from "../types";
import { ArmyPolicy } from "./army-policy";
import { Targeting } from "./targeting";
import type { AIProfile } from "./ai-profile";
import type { IDragonDirector } from "./types";

export class DragonDirector implements IDragonDirector {
  readonly team: Team;
  readonly profile: AIProfile;
  readonly army: ArmyPolicy;
  private acc = 0;
  /** 上一次给大龙下出动令的时刻（秒）；-1e9 = 从未下令 */
  lastOrderAt = -1e9;
  /** v0.38 撤离冷却：低血龙召回后的一段时间内不再给出动令（让它待在家养伤） */
  private retreatUntil = -1e9;

  constructor(team: Team, profile: AIProfile, army: ArmyPolicy = new ArmyPolicy(profile)) {
    this.team = team;
    this.profile = profile;
    this.army = army;
  }

  update(sim: Sim, dt: number): void {
    this.acc += dt;
    if (this.acc < this.profile.tickSec) return;
    this.acc = 0;
    if (sim.winner !== null) return;
    this.army.syncDragons(sim, this.team); // v0.38 龙账本：抬到当前存活数（出厂即记账）
    this.tryFillFactory(sim);
    this.commandDragons(sim);
  }

  /** 大龙计划还缺多少牛战士进厂（0 = 不征召）。 */
  conscriptNeed(sim: Sim): number {
    return this.army.dragonConscriptNeed(sim, this.team);
  }

  /** 已拥有的大龙数（含工厂满员生产中的一条）。 */
  dragonCount(sim: Sim): number {
    return this.army.dragonCount(sim, this.team);
  }

  /**
   * 征召空闲牛战士进厂：就近取人，名额 = 20 − 已进驻 − 在途（防超派堵在厂门口）。
   * 与哨塔驻军同款写法（sendMove 到 padEdge + targetId 指建筑），玩家右键路径同构。
   */
  private tryFillFactory(sim: Sim): void {
    const need = this.conscriptNeed(sim);
    if (need <= 0) return;
    const f = sim.buildings.find(
      (b) => b.team === this.team && b.hp > 0 && b.kind === "dragonFactory" && b.level >= 1,
    );
    if (!f) return;
    const idle = sim.units
      .filter(
        (u) =>
          u.team === this.team &&
          u.kind === "firewarrior" &&
          u.hp > 0 &&
          u.homeId === 0 &&
          u.targetId === 0 &&
          u.atkId === 0 &&
          u.job === "idle",
      )
      .sort((a, b) => {
        const da = (a.x - f.x) * (a.x - f.x) + (a.z - f.z) * (a.z - f.z);
        const db = (b.x - f.x) * (b.x - f.x) + (b.z - f.z) * (b.z - f.z);
        return da - db;
      });
    let sent = 0;
    for (const u of idle) {
      if (sent >= need) break;
      const edge = sim.padEdge(f.x, f.z, f.padW, f.padD, f.yaw, u.x, u.z);
      sim.sendMove(u, edge.x, edge.z);
      u.targetId = f.id;
      u.atkId = 0;
      sent++;
    }
    if (sent) {
      logger.info("ai-dragon", `征召 ${sent} 名牛战士进驻大龙训练营`, {
        team: this.team,
        dwell: f.dwell,
        need,
        max: DRAGON_GARRISON_MAX,
      });
    }
  }

  /**
   * 大龙出动：出厂的大龙只要手上没目标，就按 dragonOrderSec 节拍重新压向**软目标**
   * （v0.38 改：不再扑敌方密集点——那是玩家主力与塔群顶上）。
   * 低血龙（hp < dragonRetreatHp）改为召回自家聚落并进入撤离冷却：龙不回血，
   * 硬拼到底就是白送一条 600 血的兵器。
   * 不跨海档（dragonCrossSea=false）用岛屿标签挡一道——同岛才给令。
   */
  private commandDragons(sim: Sim): void {
    const dragons = sim.units.filter(
      (u) => u.team === this.team && u.kind === "dragon" && u.hp > 0 && u.homeId === 0,
    );
    if (!dragons.length) return;
    const home = Targeting.homePoint(sim, this.team);
    for (const d of dragons) {
      // ① 低血保命（不受出动节流限制：救命优先）
      if (d.hp <= d.maxHp * this.profile.dragonRetreatHp) {
        if (sim.time >= this.retreatUntil) {
          sim.sendMove(d, home.x, home.z);
          this.retreatUntil = sim.time + this.profile.dragonOrderSec * 3;
          logger.info("ai-dragon", `大龙#${d.id} 低血撤离（${Math.round((d.hp / d.maxHp) * 100)}%）`, {
            team: this.team,
            hp: Math.round(d.hp),
          });
        }
        continue;
      }
      if (sim.time < this.retreatUntil) continue; // 撤离冷却中：别又把残血龙送回去
      if (sim.time - this.lastOrderAt < this.profile.dragonOrderSec) continue;
      if (d.atkId !== 0) continue; // 正在吐息，别打扰
      const focus = Targeting.softFocus(sim, this.team, { x: d.x, z: d.z }, this.profile.dragonSoftRadius);
      if (!focus) continue;
      if (!this.profile.dragonCrossSea && sim.world.islandAt(d.x, d.z) !== sim.world.islandAt(focus.x, focus.z)) {
        continue;
      }
      sim.sendMove(d, focus.x, focus.z);
      this.lastOrderAt = sim.time;
      logger.info("ai-dragon", `大龙出动 → 软目标#${focus.targetId}(${focus.x.toFixed(1)},${focus.z.toFixed(1)})`, {
        team: this.team,
        targetId: focus.targetId,
        crossSea: this.profile.dragonCrossSea,
        hp: Math.round(d.hp),
      });
      break; // 一次决策周期只给一条龙下令，避免多龙抢同一下令节拍
    }
  }
}
