import { BLUE, clamp, inMap, isCampKind, Team, WORLD } from "../types";
import type { Sim } from "../sim";
import { inPad } from "../world";
import { Spell, SpellResult } from "./spell";

export class TornadoSpell extends Spell {
  readonly id = "tornado" as const;

  cast(sim: Sim, team: Team, x: number, z: number, _dt?: number): SpellResult {
    const empty: SpellResult = { ok: false, bolts: [], shake: 0, msg: "" };
    if (!inMap(x, z)) return empty;
    if (sim.world.heightAt(x, z) <= 0.20) return { ...empty, msg: "水上不起龙卷风" };
    if (!sim.spend(team, this.cost)) return { ...empty, msg: "法力不足" };
    if (!this.beginTornado(sim, x, z)) {
      sim.teams[team].mana += this.cost;
      return { ...empty, msg: "龙卷风还在刮" };
    }
    return { ok: true, bolts: [], shake: 0.2, msg: "龙卷风升起" };
  }

  beginTornado(sim: Sim, x: number, z: number): boolean {
    if (sim.tornado && sim.tornado.t < sim.tornado.life - 0.4) return false;
    let vx = 1.15;
    let vz = 0.25;
    let best = 99;
    for (const b of sim.buildings) {
      if (b.hp <= 0 || b.kind === "rebirth") continue;
      const d = Math.hypot(b.x - x, b.z - z);
      if (d < best && d > 0.4) {
        best = d;
        vx = (b.x - x) / d;
        vz = (b.z - z) / d;
      }
    }
    const spd = 1.35;
    sim.tornado = { x, z, vx: vx * spd, vz: vz * spd, t: 0, life: 16, houseT: 0 };
    sim.fxShake = Math.max(sim.fxShake, 0.22);
    sim.tornadoLift = false;
    sim.tornadoHouse = false;
    return true;
  }

  tick(sim: Sim, dt: number): void {
    const tw = sim.tornado;
    if (!tw) return;
    tw.t += dt;
    if (tw.t > tw.life) {
      sim.tornado = null;
      return;
    }
    if (tw.t > 3.8 && Math.floor(tw.t / 1.7) !== Math.floor((tw.t - dt) / 1.7)) {
      const ang = Math.atan2(tw.vz, tw.vx) + (Math.random() - 0.5) * 1.1;
      const spd = 1.25 + Math.random() * 0.3;
      tw.vx = Math.cos(ang) * spd;
      tw.vz = Math.sin(ang) * spd;
    }
    let nx = tw.x + tw.vx * dt;
    let nz = tw.z + tw.vz * dt;
    if (!sim.world.land(nx, nz) || !inMap(nx, nz)) {
      tw.vx = -tw.vx + (Math.random() - 0.5) * 0.4;
      tw.vz = -tw.vz + (Math.random() - 0.5) * 0.4;
      nx = tw.x + tw.vx * dt;
      nz = tw.z + tw.vz * dt;
      if (!sim.world.land(nx, nz)) {
        nx = tw.x;
        nz = tw.z;
      }
    }
    tw.x = nx;
    tw.z = nz;
    for (const u of sim.units) {
      if (u.hp <= 0) continue;
      const d = Math.hypot(u.x - tw.x, u.z - tw.z);
      if (d > 1.7) continue;
      if (d > 0.08) {
        u.x += ((tw.x - u.x) / d) * 2.6 * dt;
        u.z += ((tw.z - u.z) / d) * 2.6 * dt;
      }
      const tang = 2.4 * dt;
      u.x += (-(tw.z - u.z) / Math.max(0.12, d)) * tang;
      u.z += ((tw.x - u.x) / Math.max(0.12, d)) * tang;
      u.x = clamp(u.x, 0.3, WORLD - 0.3);
      u.z = clamp(u.z, 0.3, WORLD - 0.3);
      const ground = sim.world.heightAt(u.x, u.z);
      u.y = ground + Math.min(2.1, (1.7 - d) * 1.35 + 0.25);
      u.path = [];
      u.pathI = 0;
      u.think = 0.8;
      sim.tornadoLift = true;
      sim.tornadoLiftX = u.x;
      sim.tornadoLiftZ = u.z;
      if (d < 0.62 && u.y > ground + 1.05) {
        u.hp = 0;
        if (u.team === BLUE) sim.toast(u.kind === "shaman" ? "祭司被龙卷风卷走" : "一名子民被龙卷风卷走");
      }
    }
    let touching = false;
    for (const b of sim.buildings) {
      if (b.hp <= 0 || b.kind === "rebirth") continue;
      const pad = sim.buildingPad(b);
      const d = Math.hypot(b.x - tw.x, b.z - tw.z);
      if (d > 2.05 && !inPad(tw.x, tw.z, pad, 0.35)) continue;
      touching = true;
      if (!b.shell) {
        b.shell = true;
        b.hp = Math.max(1, b.maxHp * 0.4);
        tw.houseT = 0;
        sim.tornadoHouse = true;
        if (b.team === BLUE && (b.kind === "hut" || isCampKind(b.kind))) sim.toast("一座屋宇被卷成骨架");
      } else {
        tw.houseT += dt;
        if (tw.houseT > 0.85) {
          b.hp = 0;
          sim.tornadoHouse = true;
        }
      }
    }
    if (!touching) tw.houseT = Math.max(0, tw.houseT - dt);
  }
}
