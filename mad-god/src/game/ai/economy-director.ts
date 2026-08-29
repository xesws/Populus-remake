// v0.17 敌方 AI：经济子脑（入住指派 / 训兵供给 / 法力扩张平地）。
// 只依赖 Sim 既有接口（sendMove/targetId/train/magnet 下发意图），不侵入移动/寻路/生产系统内部。
// 节流统一走 profile.tickSec；训练间隔走 profile.trainGapSec；扩张按 profile.expandDrive 概率执行。

import { LogLevel, logger } from "../logger";
import type { Sim } from "../sim";
import { flattenToward } from "../spells";
import { BLUE, Building, Cell, dist2, houseMaxPop, inMap, RED, Team, TrainKind, WORLD } from "../types";
import type { World } from "../world";
import type { AIProfile } from "./ai-profile";
import type { IEconomyDirector } from "./types";

export class EconomyDirector implements IEconomyDirector {
  readonly team: Team;
  readonly profile: AIProfile;

  /** 决策计时器：每累计到 profile.tickSec 秒执行一轮（入住指派 / 训兵 / 扩张）。 */
  private acc = 0;
  /** 训兵冷却：成功后置 profile.trainGapSec，失败（缺营地）置更长以等建营地。 */
  private trainCd = 0;

  constructor(team: Team, profile: AIProfile) {
    this.team = team;
    this.profile = profile;
  }

  update(sim: Sim, dt: number): void {
    this.trainCd = Math.max(0, this.trainCd - dt);
    if (sim.winner !== null) return;
    this.acc += dt;
    if (this.acc < this.profile.tickSec) return;
    this.acc = 0;
    this.assignHomes(sim);
    this.tryTrain(sim);
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

  // ── (b) 训兵供给 ──────────────────────────────────────────────────────────
  // 村民池 >= armyCap+2 才允许训练（经济优先），士兵数达到 armyCap 即暂停（把村民留给经济）。
  private tryTrain(sim: Sim): void {
    if (this.trainCd > 0) return;
    const walkers = sim.countKind(this.team, "walker");
    if (walkers < this.profile.armyCap + 2) return;
    const soldiers = this.armyCount(sim);
    if (soldiers >= this.profile.armyCap) return;
    const kind = this.pickTrainKind(sim);
    // 参考旧 ai.ts:46 的 find：得有可派出的空闲村民才训练。
    const trainee = sim.units.find(
      (u) => u.team === this.team && u.kind === "walker" && u.carry === 0 && u.job !== "train",
    );
    if (!trainee) return;
    const ok = sim.train(this.team, kind);
    this.trainCd = ok ? this.profile.trainGapSec : Math.max(2, this.profile.trainGapSec * 1.5);
    if (ok) {
      logger.info("ai-economy", `训练 ${kind}：村民#${trainee.id} 前往营地`, {
        walkers,
        army: soldiers,
        cap: this.profile.armyCap,
      });
    } else {
      logger.throttled("ai-economy:train-fail", 2000, LogLevel.Warn, "ai-economy", `训练 ${kind} 失败：缺训练营或村民不可用`, {
        walkers,
        army: soldiers,
      });
    }
  }

  /** 士兵总数（与 IWarDirector.armySize 口径一致：warrior/preacher/firewarrior/spy）。 */
  private armyCount(sim: Sim): number {
    return (
      sim.countKind(this.team, "warrior") +
      sim.countKind(this.team, "preacher") +
      sim.countKind(this.team, "firewarrior") +
      sim.countKind(this.team, "spy")
    );
  }

  /** 兵种优先级（迁移自旧 ai.ts 第 38-45 行）：先武士、视敌方村民补传教士、再火战士/间谍。 */
  private pickTrainKind(sim: Sim): TrainKind {
    const me = this.team;
    const foe: Team = me === RED ? BLUE : RED;
    const myWar = sim.countKind(me, "warrior");
    const myPreach = sim.countKind(me, "preacher");
    const myFire = sim.countKind(me, "firewarrior");
    const mySpy = sim.countKind(me, "spy");
    const foeWalk = sim.countKind(foe, "walker");
    if (myWar < 2) return "warrior";
    if (myPreach < 1 && foeWalk >= 1) return "preacher";
    if (myFire < 1) return "firewarrior";
    if (mySpy < 1) return "spy";
    if (myPreach < 2 && foeWalk >= 2) return "preacher";
    if (myFire < myWar) return "firewarrior";
    return "warrior";
  }

  // ── (c) 扩张平地 ──────────────────────────────────────────────────────────
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
