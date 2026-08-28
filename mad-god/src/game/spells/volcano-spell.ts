import { inMap, Team } from "../types";
import type { Sim } from "../sim";
import { Spell, SpellResult } from "./spell";

export class VolcanoSpell extends Spell {
  readonly id = "volcano" as const;

  cast(sim: Sim, team: Team, x: number, z: number, _dt?: number): SpellResult {
    const empty: SpellResult = { ok: false, bolts: [], shake: 0, msg: "" };
    if (!inMap(x, z)) return empty;
    if (!sim.spend(team, this.cost)) return { ...empty, msg: "法力不足" };
    if (!this.beginVolcano(sim, x, z)) {
      sim.teams[team].mana += this.cost;
      return { ...empty, msg: "火山还在喷" };
    }
    return { ok: true, bolts: [], shake: 0.25, msg: "火山抬起" };
  }

  beginVolcano(sim: Sim, x: number, z: number): boolean {
    if (sim.volcano && sim.volcano.t < sim.volcano.dur + 1.2) return false;
    sim.volcano = { x, z, t: 0, dur: 2.6 };
    sim.fxShake = Math.max(sim.fxShake, 0.28);
    return true;
  }

  holdPadsNearVolcano(sim: Sim): void {
    const v = sim.volcano;
    if (!v) return;
    for (const b of sim.buildings) {
      if (b.hp <= 0 || b.kind === "rebirth") continue;
      if (Math.hypot(b.x - v.x, b.z - v.z) < 2.8) continue;
      const h = Math.max(sim.world.heightAt(b.x, b.z), 0.8);
      sim.world.flattenPad(b.x, b.z, b.padW, b.padD, b.yaw, h);
      b.y = sim.world.heightAt(b.x, b.z);
    }
  }

  tick(sim: Sim, dt: number): void {
    const v = sim.volcano;
    if (v) {
      v.t += dt;
      if (v.t <= v.dur) {
        sim.world.sculpt(v.x, v.z, 2.5, 1.35 * dt);
        sim.world.sculpt(v.x, v.z, 1.05, 0.45 * dt);
      }
      if (v.t > 1.1 && v.t <= v.dur + 2.0) {
        const reach = 5 + Math.floor((v.t - 1.1) * 6);
        sim.world.growRivers(v.x, v.z, Math.min(12, reach));
        sim.world.seedLava(v.x, v.z, 0.22, 3.8);
      }
      if (v.t > v.dur + 8) sim.volcano = null;
      this.holdPadsNearVolcano(sim);
    }
    sim.burnBuildings(dt);
  }
}
