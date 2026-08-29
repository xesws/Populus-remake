// v0.17 敌方 AI：神力子脑——进攻性施法（末日/火山）轰击敌方密集点，逻辑自旧 ai.ts castOffense 迁移。

import { logger } from "../logger";
import type { Sim } from "../sim";
import { canUnlock, cast } from "../spells";
import type { SpellResult } from "../spells";
import { BLUE, RED, dist2, type Cell, type Team, type Tool } from "../types";
import type { AIProfile } from "./ai-profile";
import type { ISpellDirector } from "./types";

export class SpellDirector implements ISpellDirector {
  readonly team: Team;
  readonly profile: AIProfile;
  /** 施法冷却（秒）：基础 90s × (1/spellAggro)，激进度越高冷却越短 */
  private spellCd: number;
  /** tickSec 周期节流累加器 */
  private acc = 0;

  constructor(team: Team, profile: AIProfile) {
    this.team = team;
    this.profile = profile;
    this.spellCd = 90 * (1 / profile.spellAggro);
  }

  /** 每帧驱动：冷却递减 + tickSec 节流后尝试施法（父级 TribeBrain 亦按 tickSec 调用，双保险）。 */
  update(sim: Sim, dt: number): void {
    this.spellCd = Math.max(0, this.spellCd - dt);
    this.acc += dt;
    if (this.acc < this.profile.tickSec) return;
    this.acc = 0;
    if (sim.winner !== null) return; // 胜负已分不再施法（旧 GodAI.plan 同款守卫）
    this.castOffense(sim);
  }

  /** 进攻施法：末日优先、火山次之，都砸向敌方建筑+单位密集点（旧 castOffense 原样迁移）。 */
  private castOffense(sim: Sim): void {
    if (this.spellCd > 0 || sim.armageddon) return; // 冷却中或末日已开，不出手
    const foe: Team = this.team === RED ? BLUE : RED;
    const foeHouses = sim.buildings.filter((b) => b.team === foe);
    const foeUnits = sim.units.filter((u) => u.team === foe);
    const focus = this.cluster(foeHouses, foeUnits);
    if (!focus) return;
    // 密集度：靶心 4 格半径内的敌方建筑数（火山要求 ≥2 才值得砸）
    const density = foeHouses.filter((h) => dist2(h.x, h.z, focus.x, focus.z) < 16).length;
    const cap = sim.teams[this.team].manaCap;
    // v0.26 法力槽改为各技能独立充能：施法条件从"法力值够"变成"该技能有颗"。
    // v0.26b 施法失败也必须冷却：armageddon 是占位实现（恒返回失败），旧逻辑失败不设冷却，
    // AI 每秒空转重试 → 日志刷屏（实测 t=150~211 每秒一条"armageddon 失败"）。
    if (canUnlock("armageddon", cap) && sim.hasCharge(this.team, "armageddon")) {
      const res = cast(sim, this.team, "armageddon", focus.x, focus.z);
      this.logCast("armageddon", focus.x, focus.z, res);
      if (res.ok) {
        this.spellCd = 99;
        return;
      }
      this.spellCd = 10; // 失败也冷却 10s，避免每秒重试
    }
    if (canUnlock("volcano", cap) && sim.hasCharge(this.team, "volcano") && density >= 2) {
      const res = cast(sim, this.team, "volcano", focus.x, focus.z);
      this.logCast("volcano", focus.x, focus.z, res);
      if (res.ok) this.spellCd = 12;
      else this.spellCd = 8; // 火山施放失败（还在喷/法力不足）也冷却 8s
    }
  }

  /** 施法结果日志：成功与失败都记录，含坐标与法术名（cat: ai-spell）。 */
  private logCast(tool: Tool, x: number, z: number, res: SpellResult): void {
    logger.info("ai-spell", `${tool}@(${x.toFixed(1)},${z.toFixed(1)}) ${res.ok ? "成功" : "失败"}`, {
      team: this.team,
      tool,
      x,
      z,
      ok: res.ok,
      msg: res.msg || undefined,
    });
  }

  /** 敌方建筑+单位密集点：点群中邻居最多者作靶心，无目标返回 null（抄自旧 ai.ts cluster）。 */
  private cluster(
    houses: { x: number; z: number }[],
    units: { x: number; z: number }[],
  ): Cell | null {
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
}
