import { inMap, Team } from "../types";
import type { Sim } from "../sim";
import { Spell, SpellResult } from "./spell";

export class SwampSpell extends Spell {
  readonly id = "swamp" as const;

  cast(sim: Sim, team: Team, x: number, z: number, _dt?: number): SpellResult {
    const empty: SpellResult = { ok: false, bolts: [], shake: 0, msg: "" };
    if (!inMap(x, z)) return empty;
    if (sim.world.heightAt(x, z) <= 0.20) return { ...empty, msg: "水里不长沼泽" };
    if (!sim.spendCharge(team, this.id)) return { ...empty, msg: "法力不足" };
    const n = sim.world.paintSwamp(x, z);
    if (!n) {
      sim.refundCharge(team, this.id, 1); // 长不出沼泽，退还
      return { ...empty, msg: "这里长不出沼泽" };
    }
    return { ok: true, bolts: [], shake: 0, msg: "毒气沼泽落下" };
  }
}
