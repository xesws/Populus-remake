import { BLUE, inMap, isCampKind, Team } from "../types";
import { inPad } from "../world";
import type { Sim } from "../sim";
import { Spell, SpellResult } from "./spell";

export class LightningSpell extends Spell {
  readonly id = "lightning" as const;

  cast(sim: Sim, team: Team, x: number, z: number, _dt?: number): SpellResult {
    const empty: SpellResult = { ok: false, bolts: [], shake: 0, msg: "" };
    if (!inMap(x, z)) return empty;
    if (!sim.spend(team, this.cost)) return { ...empty, msg: "法力不足" };
    this.strikeLightning(sim, x, z);
    return { ok: true, bolts: [], shake: 0.45, msg: "天雷落下" };
  }

  strikeLightning(sim: Sim, x: number, z: number): void {
    sim.fxBolts.push({ x0: x, z0: z, x1: x, z1: z, life: 0.9 });
    sim.fxShake = Math.max(sim.fxShake, 0.5);
    sim.lightningHit = false;
    sim.lightningHouse = false;
    for (const u of sim.units) {
      if (u.hp <= 0) continue;
      const d = Math.hypot(u.x - x, u.z - z);
      if (d > 1.7) continue;
      let dx = u.x - x;
      let dz = u.z - z;
      const len = Math.hypot(dx, dz) || 1;
      dx /= len;
      dz /= len;
      u.fireT = 3.6;
      u.flyVx = dx * (4.4 + Math.random() * 0.6);
      u.flyVz = dz * (4.4 + Math.random() * 0.6);
      u.flyVy = 5.6;
      u.y = sim.world.heightAt(u.x, u.z) + 1.55;
      u.hp = Math.max(1, u.hp - 8);
      u.path = [];
      u.pathI = 0;
      u.think = 1.2;
      sim.lightningHit = true;
      sim.lightningHitX = u.x;
      sim.lightningHitZ = u.z;
      if (u.team === BLUE) sim.toast(u.kind === "shaman" ? "祭司被雷打飞" : "一名子民被雷打飞");
    }
    for (const b of sim.buildings) {
      if (b.hp <= 0 || b.kind === "rebirth") continue;
      const d = Math.hypot(b.x - x, b.z - z);
      if (d > 2.2 && !inPad(x, z, sim.buildingPad(b), 0.25)) continue;
      if (!b.shell) {
        b.shell = true;
        b.hp = Math.max(1, b.maxHp * 0.4);
        sim.lightningHouse = true;
        if (b.team === BLUE && (b.kind === "hut" || isCampKind(b.kind))) sim.toast("一座屋宇被劈成骨架");
      } else {
        b.hp = 0;
        sim.lightningHouse = true;
      }
    }
  }
}
