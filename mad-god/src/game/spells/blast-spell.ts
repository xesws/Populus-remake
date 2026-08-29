import { BLUE, inMap, Team } from "../types";
import type { Sim } from "../sim";
import { Spell, SpellResult } from "./spell";

export class BlastSpell extends Spell {
  readonly id = "blast" as const;

  cast(sim: Sim, team: Team, x: number, z: number, _dt?: number): SpellResult {
    const empty: SpellResult = { ok: false, bolts: [], shake: 0, msg: "" };
    if (!inMap(x, z)) return empty;
    if (!sim.spendCharge(team, this.id)) return { ...empty, msg: "法力不足" };
    this.blastAt(sim, x, z);
    return { ok: true, bolts: [], shake: 0.28, msg: "一股气浪打出" };
  }

  blastAt(sim: Sim, x: number, z: number): void {
    sim.blast = { x, z, t: 0, life: 0.8 };
    sim.fxShake = Math.max(sim.fxShake, 0.3);
    sim.blastHit = false;
    for (const u of sim.units) {
      if (u.hp <= 0) continue;
      const d = Math.hypot(u.x - x, u.z - z);
      if (d > 1.7) continue;
      let dx = u.x - x;
      let dz = u.z - z;
      const len = Math.hypot(dx, dz) || 1;
      dx /= len;
      dz /= len;
      u.fireT = 0;
      u.flyVx = dx * 4.6;
      u.flyVz = dz * 4.6;
      u.flyVy = 5.8;
      u.y = sim.world.heightAt(u.x, u.z) + 0.35;
      u.path = [];
      u.pathI = 0;
      u.think = 1.2;
      sim.blastHit = true;
      sim.blastHitX = u.x;
      sim.blastHitZ = u.z;
      sim.blastFlyer = { x: u.x, y: u.y, z: u.z };
      if (u.team === BLUE) sim.toast(u.kind === "shaman" ? "祭司被气浪打飞" : "一名子民被气浪打飞");
    }
  }

  tick(sim: Sim, dt: number): void {
    if (!sim.blast) return;
    sim.blast.t += dt;
    if (sim.blast.t > sim.blast.life) sim.blast = null;
  }
}
