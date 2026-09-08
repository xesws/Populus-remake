// v0.17 敌方 AI：经济子脑（入住指派 / 法力扩张平地）。
// 只依赖 Sim 既有接口（sendMove/targetId/magnet 下发意图），不侵入移动/寻路/生产系统内部。
// v0.34 训兵/建营已拆到 TrainingDirector；本类只留入住与扩张。
// 节流统一走 profile.tickSec；扩张按 profile.expandDrive 概率执行。

import { LogLevel, logger } from "../logger";
import type { Sim } from "../sim";
import { flattenToward } from "../spells";
import { BLUE, Building, Cell, dist2, houseMaxPop, inMap, RED, Team, WORLD } from "../types";
import type { World } from "../world";
import type { AIProfile } from "./ai-profile";
import type { IEconomyDirector } from "./types";

export class EconomyDirector implements IEconomyDirector {
  readonly team: Team;
  readonly profile: AIProfile;

  /** 决策计时器：每累计到 profile.tickSec 秒执行一轮（入住指派 / 扩张）。 */
  private acc = 0;

  constructor(team: Team, profile: AIProfile) {
    this.team = team;
    this.profile = profile;
  }

  update(sim: Sim, dt: number): void {
    if (sim.winner !== null) return;
    this.acc += dt;
    if (this.acc < this.profile.tickSec) return;
    this.acc = 0;
    this.assignHomes(sim);
    this.expand(sim);
  }

  /** 经济健康度 0~1：茅屋平均入住率 ×0.7 + 人口规模（/30 封顶）×0.3；无茅屋返回 0。 */
  economyScore(sim: Sim): number {
    const huts = sim.buildings.filter((b) => b.team === this.team && b.kind === "hut" && b.level >= 1 && b.hp > 0);
    if (!huts.length) return 0;
    let occ = 0;
    for (const h of huts) occ += h.dwell / houseMaxPop(h.level);
    occ /= huts.length;
    return occ * 0.7 + Math.min(1, sim.countPop(this.team) / 30) * 0.3;
  }

  // ── (a) 入住指派 ──────────────────────────────────────────────────────────
  // 修"红方永不入住→茅屋不生产"断链：把空闲村民派往最欠人的茅屋。
  // 走路采用与 sim.orderMove 相同的入住模式（sendMove 到门口 + targetId），
  // 后续由 thinkUnits 的既有 tryOccupy 链在门口 1.2 格内完成入住。
  private assignHomes(sim: Sim): void {
    const free = sim.units.filter(
      (u) =>
        u.team === this.team &&
        u.kind === "walker" &&
        u.homeId === 0 &&
        u.targetId === 0 &&
        u.carry === 0 &&
        // v0.31 建营者保护：带建设任务（foundKind）的村民不拉去入住，
        // 否则训练营工地永远没人起（旧实现 here 被吸走 + occupy 不清 foundKind 双重锁死）。
        u.foundKind === null &&
        u.job !== "train" &&
        u.job !== "move",
    );
    if (!free.length) return;
    const huts = sim.buildings.filter(
      (b) => b.team === this.team && b.kind === "hut" && b.level >= 1 && b.hp > 0 && this.freeSpots(sim, b) > 0,
    );
    if (!huts.length) return;
    for (const u of free) {
      const hut = this.neediestHut(sim, huts);
      if (!hut) break;
      const door = sim.hutDoor(hut);
      sim.sendMove(u, door.x, door.z);
      u.targetId = hut.id;
      u.atkId = 0;
      logger.throttled("ai-economy:occupy", 2000, LogLevel.Info, "ai-economy", `指派村民#${u.id} 入住茅屋#${hut.id}`, {
        level: hut.level,
        dwell: hut.dwell,
        spots: this.freeSpots(sim, hut),
      });
    }
  }

  /** 某茅屋剩余可入住名额 = 容量 − 已入住 − 已指派（targetId 指向它的在途村民）。 */
  private freeSpots(sim: Sim, hut: Building): number {
    const max = houseMaxPop(hut.level);
    let assigned = 0;
    for (const u of sim.units) {
      if (u.team === this.team && u.kind === "walker" && u.homeId === 0 && u.targetId === hut.id) assigned++;
    }
    return max - hut.dwell - assigned;
  }

  /** 最欠人的茅屋：剩余名额最多者（名额 0 时返回 null 结束本轮指派）。 */
  private neediestHut(sim: Sim, huts: Building[]): Building | null {
    let best: Building | null = null;
    let bestSpots = 0;
    for (const h of huts) {
      const spots = this.freeSpots(sim, h);
      if (spots > bestSpots) {
        bestSpots = spots;
        best = h;
      }
    }
    return best;
  }

  // ── (b) 扩张平地 ──────────────────────────────────────────────────────────
  // 法力 > 容量 55% 时按 profile.expandDrive 概率执行；四个方法自旧 GodAI 原样迁移。
  private expand(sim: Sim): void {
    const t = sim.teams[this.team];
    // v0.26 法力槽改为技能独立充能：扩张时机改为"雕刻能量过半"（无全局法力可看）。
    if (sim.chargeState(this.team, "raise").cur < 15) return;
    if (Math.random() >= this.profile.expandDrive) return;
    const foe: Team = this.team === RED ? BLUE : RED;
    const mine = sim.buildings.filter((b) => b.team === this.team && b.hp > 0);
    const foeHouses = sim.buildings.filter((b) => b.team === foe && b.hp > 0);
    this.improveSettlements(sim, mine);
    this.expandFrontier(sim, mine, foeHouses);
    logger.throttled("ai-economy:expand", 2000, LogLevel.Info, "ai-economy", "扩张平地执行", {
      raiseEnergy: +sim.chargeState(this.team, "raise").cur.toFixed(1),
      cap: +t.manaCap.toFixed(1),
      drive: this.profile.expandDrive,
    });
  }

  /** 整平自家聚落：优先补最不平的茅屋周边（旧 GodAI.improveSettlements 迁移）。 */
  private improveSettlements(sim: Sim, houses: { x: number; z: number }[]): void {
    if (!houses.length) {
      const w = sim.units.find((u) => u.team === this.team && u.kind === "walker");
      if (w) this.flattenPatch(sim, w.x, w.z, 1.4);
      return;
    }
    let best: { x: number; z: number; miss: Cell[] } | null = null;
    for (const h of houses) {
      const th = sim.world.heightAt(h.x, h.z);
      const miss = sim.world.countMismatch(h.x, h.z, 2.2, th);
      if (miss.length && (!best || miss.length > best.miss.length)) {
        best = { x: h.x, z: h.z, miss };
      }
    }
    if (!best) return;
    let n = 0;
    for (const c of best.miss) {
      if (n >= 4) break;
      const th = sim.world.heightAt(best.x, best.z);
      if (flattenToward(sim, this.team, c.x, c.z, th)) n++;
    }
  }

  /** 以 (cx,cz) 为中心半径 r 的网格逐格向目标高度整平（旧 GodAI.flattenPatch 迁移）。 */
  private flattenPatch(sim: Sim, cx: number, cz: number, r: number): void {
    let th = sim.world.heightAt(cx, cz);
    if (th <= 0.2) th = 1.6;
    let n = 0;
    for (let z = cz - r; z <= cz + r; z += 0.6) {
      for (let x = cx - r; x <= cx + r; x += 0.6) {
        if (n >= 5) return;
        if (flattenToward(sim, this.team, x, z, th)) n++;
      }
    }
  }

  /** 沿"家→敌"连线铺一条通向敌人的平地走廊，顺带挑新宅基地（旧 GodAI.expandFrontier 迁移）。 */
  private expandFrontier(sim: Sim, mine: { x: number; z: number }[], foe: { x: number; z: number }[]): void {
    // v0.24 兜底坐标改从出生点取（大地图上写死旧图坐标会指错位置）。
    const dest = foe[0] ?? sim.world.startPad(this.team === RED ? BLUE : RED);
    const from = mine[0] ?? sim.world.startPad(this.team);
    let edits = 0;
    for (let i = 1; i <= 10 && edits < 3; i++) {
      const t = i / 12;
      const x = from.x + (dest.x - from.x) * t;
      const z = from.z + (dest.z - from.z) * t;
      if (!inMap(x, z)) continue;
      if (sim.world.heightAt(x, z) <= 1) {
        if (flattenToward(sim, this.team, x, z, 1.8)) edits++;
      }
    }
    if (sim.hasCharge(this.team, "raise") && mine.length < 8) {
      const site = this.pickNewPlot(sim.world, from, dest);
      if (site) this.flattenPatch(sim, site.x, site.z, 1.4);
    }
  }

  /** 在自家附近随机采样 20 点，按"靠近敌人 + 平地好建 + 地势高"打分选新宅基地（旧 GodAI.pickNewPlot 迁移）。 */
  private pickNewPlot(world: World, from: Cell, dest: Cell): Cell | null {
    let best: Cell | null = null;
    let bestScore = -1e9;
    for (let i = 0; i < 20; i++) {
      const x = Math.max(2, Math.min(WORLD - 3, from.x + Math.random() * 17 - 6));
      const z = Math.max(2, Math.min(WORLD - 3, from.z + Math.random() * 17 - 6));
      if (world.heightAt(x, z) <= 0.2) continue;
      const toward = -dist2(x, z, dest.x, dest.z) * 0.02;
      const lv = world.houseLevelAt(x, z, 0);
      const score = toward + lv * 3 + world.heightAt(x, z);
      if (score > bestScore) {
        bestScore = score;
        best = { x, z };
      }
    }
    return best;
  }
}
