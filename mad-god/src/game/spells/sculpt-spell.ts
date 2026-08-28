import { inMap, Team } from "../types";
import type { Sim } from "../sim";
import { Spell, SpellResult } from "./spell";

// v0.18 范围放大：1.4 → 3.0，一次罩住整个部落聚居地，大面积整地/削山更顺手；
// 单位时间抬升量 1.5 → 1.1：半径变大后单次形变总量更大，稍降保持手感。
const SCULPT_RADIUS = 3.0;
const SCULPT_DH_PER_SEC = 1.1;

export class SculptSpell extends Spell {
  readonly id: "raise" | "lower";

  constructor(id: "raise" | "lower") {
    super();
    this.id = id;
  }

  cast(sim: Sim, team: Team, x: number, z: number, dt = 0.2): SpellResult {
    const empty: SpellResult = { ok: false, bolts: [], shake: 0, msg: "" };
    if (!inMap(x, z)) return empty;
    const sign = this.id === "raise" ? 1 : -1;
    // v0.18 消耗链路：每秒费率取自 TOOL_COST（建议 raise 12 / lower 9，主 agent 统一调）；
    // 按帧计费 cost = max(0.04, perSec * dt)，最小计价 0.04 保证任何一次雕刻都要付出法力。
    const perSec = this.cost;
    const cost = Math.max(0.04, perSec * dt);
    const t = sim.teams[team];
    if (!sim.spend(team, cost)) return { ...empty, msg: "法力不足" };
    const dh = sign * SCULPT_DH_PER_SEC * dt;
    const ok = sim.world.sculpt(x, z, SCULPT_RADIUS, dh);
    if (!ok && this.id === "raise" && sim.world.heightAt(x, z) >= 8 - 1e-4) {
      t.mana += cost;
      return { ...empty, msg: "无法再升高" };
    }
    if (!ok && this.id === "lower" && sim.world.heightAt(x, z) <= 0.02) {
      t.mana += cost;
      return { ...empty, msg: "已是水面" };
    }
    return { ok: true, bolts: [], shake: 0, msg: "" };
  }
}
