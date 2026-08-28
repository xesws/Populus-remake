import { inMap, Team } from "../types";
import type { Sim } from "../sim";
import { Spell, SpellResult } from "./spell";

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
    const perSec = this.cost;
    const cost = Math.max(0.04, perSec * dt);
    const t = sim.teams[team];
    if (!sim.spend(team, cost)) return { ...empty, msg: "法力不足" };
    const dh = sign * 1.5 * dt;
    const ok = sim.world.sculpt(x, z, 1.4, dh);
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
