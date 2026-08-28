// v0.17 敌方 AI：军事子脑（WarDirector）——进攻波次编成与受袭防御响应。
// 波次节奏（waveSize/waveGapSec/reactSec）全部取自 AIProfile；
// 只通过 Sim 既有接口（setOrder/setMagnet/sendMove/atkId）下发意图，不侵入寻路/战斗系统内部。

import { logger } from "../logger";
import type { Sim } from "../sim";
import { BLUE, Cell, dist2, RED, Team, UnitKind } from "../types";
import { AIProfile } from "./ai-profile";
import type { IWarDirector } from "./types";

/** 受袭事件：某时刻 (x,z) 处本队单位/建筑被攻击。 */
interface HurtEvent {
  x: number;
  z: number;
  /** 事件发生的游戏时刻（秒） */
  t: number;
}

export class WarDirector implements IWarDirector {
  readonly team: Team;
  readonly profile: AIProfile;
  /** 决策节流累计（秒）：达到 profile.tickSec 才处理一次 */
  private acc = 0;
  /** 上一波进攻发起的游戏时刻（秒）；-1e9 表示从未发波 */
  lastWaveTime = -1e9;
  /** 已发波次计数（自 1 起） */
  waves = 0;
  /** 受袭事件队列：按 profile.reactSec 延迟后就近派兵，处理完出队 */
  private hurtQueue: HurtEvent[] = [];

  constructor(team: Team, profile: AIProfile) {
    this.team = team;
    this.profile = profile;
  }

  /** 当前士兵总数（warrior/preacher/firewarrior/spy）。 */
  armySize(sim: Sim): number {
    return (
      sim.countKind(this.team, "warrior") +
      sim.countKind(this.team, "preacher") +
      sim.countKind(this.team, "firewarrior") +
      sim.countKind(this.team, "spy")
    );
  }

  /** 波次就绪：兵力 ≥ waveSize 且距上一波 ≥ waveGapSec（纯 sim.time 计算，无内部计时器）。 */
  waveReady(sim: Sim): boolean {
    return (
      this.armySize(sim) >= this.profile.waveSize &&
      sim.time - this.lastWaveTime >= this.profile.waveGapSec
    );
  }

  /** 发动进攻：setOrder("fight") + magnet 锁定敌方建筑/单位密集点，并给每个士兵显式行军目标与攻击目标。 */
  launchWave(sim: Sim): boolean {
    if (!this.waveReady(sim)) return false;
    const foe: Team = this.team === RED ? BLUE : RED;
    const foeHouses = sim.buildings.filter((b) => b.team === foe && b.hp > 0);
    const foeUnits = sim.units.filter((u) => u.team === foe && u.hp > 0 && u.homeId === 0);
    const focus = this.cluster(foeHouses, foeUnits);
    if (!focus) return false; // 敌方已无建筑/单位，无目标可打
    // 先收集可参战士兵：无人可发（全员训练/战损）则整波取消，避免空放波次。
    const marchers = sim.units.filter(
      (u) =>
        u.team === this.team &&
        u.hp > 0 &&
        u.homeId === 0 &&
        this.isFighter(u.kind) &&
        u.job !== "train",
    );
    if (!marchers.length) return false;
    sim.setMagnet(this.team, focus.x, focus.z);
    sim.setOrder(this.team, "fight");
    // v0.17 repath 对 fight 没有 magnet 寻路分支，setOrder 也不会改士兵个体 order：
    // 必须逐个 sendMove 显式下发行军目标，否则发波只是原地罚站。
    for (const u of marchers) {
      sim.sendMove(u, focus.x, focus.z);
      // sendMove 会清空 atkId：先行军、后挂最近敌方目标，到达密集点即转入 chaseAttack 进攻。
      const tid = this.nearestEnemyId(sim, u.x, u.z, foe);
      if (tid) u.atkId = tid;
    }
    this.lastWaveTime = sim.time;
    this.waves++;
    logger.info("ai-war", `第 ${this.waves} 波进攻`, {
      team: this.team,
      army: marchers.length,
      x: +focus.x.toFixed(1),
      z: +focus.z.toFixed(1),
    });
    return true;
  }

  /** 收兵回防：全队转 settle，magnet 拉回最近的自家茅屋（无茅屋则保持原地）。 */
  recall(sim: Sim): void {
    sim.setOrder(this.team, "settle");
    let hx = -1;
    let hz = -1;
    let bestD = 1e9;
    const mx = sim.teams[this.team].magnetX;
    const mz = sim.teams[this.team].magnetZ;
    for (const b of sim.buildings) {
      if (b.team !== this.team || b.hp <= 0 || b.kind !== "hut") continue;
      const d = dist2(b.x, b.z, mx, mz);
      if (d < bestD) {
        bestD = d;
        hx = b.x;
        hz = b.z;
      }
    }
    if (hx >= 0) sim.setMagnet(this.team, hx, hz);
  }

  /** 防御响应入口：sim.onTeamHurt 按 team 分发调用；事件入队，由 update 按 reactSec 延迟派兵。 */
  onHurt(sim: Sim, x: number, z: number): void {
    this.hurtQueue.push({ x, z, t: sim.time });
    // 队列上限：极端高频受袭时丢弃最旧事件，避免无限膨胀。
    if (this.hurtQueue.length > 8) this.hurtQueue.shift();
  }

  /** 每帧驱动：按 tickSec 节流，处理受袭队列（事件过 reactSec 触发防御波次）。
   *  波次冷却无需在此维护——waveReady 由 sim.time 纯计算；
   *  attack 状态的兵耗尽检测归 TribeBrain，本类只提供 armySize/waveReady。 */
  update(sim: Sim, dt: number): void {
    this.acc += dt;
    if (this.acc < this.profile.tickSec) return;
    this.acc = 0;
    if (sim.winner !== null) return;
    this.processHurt(sim);
  }

  /** 受袭事件到期处理：事件在队列中待满 reactSec（防御响应超时）即派兵，处理完出队。 */
  private processHurt(sim: Sim): void {
    if (!this.hurtQueue.length) return;
    const due = sim.time - this.profile.reactSec;
    const keep: HurtEvent[] = [];
    for (const e of this.hurtQueue) {
      if (e.t > due) {
        keep.push(e); // 尚未到反应延迟，留到下一个决策周期
        continue;
      }
      this.dispatchDefenders(sim, e.x, e.z);
    }
    this.hurtQueue = keep;
  }

  /** 就近派兵：取事发点最近的 min(waveSize, armySize) 名空闲士兵，sendMove 冲向事发点。 */
  private dispatchDefenders(sim: Sim, x: number, z: number): void {
    const pool = sim.units.filter(
      (u) =>
        u.team === this.team &&
        u.hp > 0 &&
        u.homeId === 0 &&
        this.isFighter(u.kind) &&
        u.atkId === 0 &&
        u.job !== "train",
    );
    pool.sort((a, b) => dist2(a.x, a.z, x, z) - dist2(b.x, b.z, x, z));
    const n = Math.min(this.profile.waveSize, this.armySize(sim), pool.length);
    for (let i = 0; i < n; i++) {
      const u = pool[i]!;
      sim.sendMove(u, x, z);
    }
    if (n > 0) {
      logger.info("ai-war", `受袭响应：${n} 兵驰援`, {
        team: this.team,
        x: +x.toFixed(1),
        z: +z.toFixed(1),
      });
    }
  }

  /** 战斗兵种判定（不含间谍：间谍只计入 armySize，不参与波次与防御）。 */
  private isFighter(kind: UnitKind): boolean {
    return kind === "warrior" || kind === "preacher" || kind === "firewarrior";
  }

  /** 敌方密集点：在敌方建筑/单位点集中取邻域（半径 √20 格）内同伴最多的点。 */
  private cluster(houses: { x: number; z: number }[], units: { x: number; z: number }[]): Cell | null {
    const pts = [
      ...houses.map((h) => ({ x: h.x, z: h.z })),
      ...units.map((u) => ({ x: u.x, z: u.z })),
    ];
    if (!pts.length) return null;
    let best = pts[0]!;
    let bestN = -1;
    for (const p of pts) {
      let n = 0;
      for (const q of pts) if (dist2(p.x, p.z, q.x, q.z) < 20) n++;
      if (n > bestN) {
        bestN = n;
        best = p;
      }
    }
    return best;
  }

  /** 离 (x,z) 最近的敌方单位/建筑 id（单位与建筑取更近者）；无目标返回 0。 */
  private nearestEnemyId(sim: Sim, x: number, z: number, foe: Team): number {
    let best = 0;
    let bestD = 1e9;
    for (const u of sim.units) {
      if (u.team !== foe || u.hp <= 0 || u.homeId > 0) continue;
      const d = dist2(x, z, u.x, u.z);
      if (d < bestD) {
        bestD = d;
        best = u.id;
      }
    }
    for (const b of sim.buildings) {
      if (b.team !== foe || b.hp <= 0) continue;
      const d = dist2(x, z, b.x, b.z);
      if (d < bestD) {
        bestD = d;
        best = b.id;
      }
    }
    return best;
  }
}
