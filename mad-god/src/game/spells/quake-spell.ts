import { BLUE, clamp, inMap, Team, WATER, WORLD } from "../types";
import type { Sim } from "../sim";
import { inPad } from "../world";
import { Spell, SpellResult } from "./spell";

export class QuakeSpell extends Spell {
  readonly id = "quake" as const;

  cast(sim: Sim, team: Team, x: number, z: number, _dt?: number): SpellResult {
    const empty: SpellResult = { ok: false, bolts: [], shake: 0, msg: "" };
    if (!inMap(x, z)) return empty;
    if (!sim.spend(team, this.cost)) return { ...empty, msg: "法力不足" };
    if (!this.beginQuake(sim, x, z)) {
      sim.teams[team].mana += this.cost;
      return { ...empty, msg: "大地震还在裂" };
    }
    return { ok: true, bolts: [], shake: 0.4, msg: "大地震动" };
  }

  beginQuake(sim: Sim, x: number, z: number): boolean {
    if (sim.quake && sim.quake.t < sim.quake.dur + 0.35) return false;
    sim.quake = {
      x,
      z,
      t: 0,
      dur: 2.0,
      angs: [3.86, 5.96, 1.76],
      lens: [4.6, 4.4, 4.8],
      opened: [0, 0, 0],
    };
    sim.fxQuake = { x, z };
    sim.fxShake = Math.max(sim.fxShake, 0.45);
    return true;
  }

  crackPoint(q: { x: number; z: number; angs: number[] }, k: number, s: number): { x: number; z: number } {
    const ang = q.angs[k]!;
    const wob = Math.sin(s * 2.1 + k * 1.3) * 0.22;
    const c = Math.cos(ang);
    const si = Math.sin(ang);
    return { x: q.x + c * s - si * wob, z: q.z + si * s + c * wob };
  }

  nearestOpenCrack(sim: Sim, x: number, z: number): { d: number; x: number; z: number } {
    const q = sim.quake;
    let best = { d: 99, x, z };
    if (!q) return best;
    for (let k = 0; k < q.angs.length; k++) {
      const opened = q.opened[k]!;
      if (opened < 0.08) continue;
      for (let s = 0; s <= opened; s += 0.18) {
        const p = this.crackPoint(q, k, s);
        const d = Math.hypot(p.x - x, p.z - z);
        if (d < best.d) best = { d, x: p.x, z: p.z };
      }
    }
    return best;
  }

  tick(sim: Sim, dt: number): void {
    const q = sim.quake;
    if (!q) return;
    q.t += dt;
    const prog = Math.min(1, q.t / q.dur);
    for (let k = 0; k < q.angs.length; k++) {
      const target = q.lens[k]! * prog;
      const prev = q.opened[k]!;
      if (target > prev) {
        for (let s = prev; s < target; s += 0.14) {
          const p = this.crackPoint(q, k, s);
          sim.world.sinkTrench(p.x, p.z, 0.64, 0.4);
        }
        const tip = this.crackPoint(q, k, target);
        sim.world.sinkTrench(tip.x, tip.z, 0.64, 0.4);
        q.opened[k] = target;
      }
    }
    this.slideIntoCracks(sim, dt);
    this.collapseCutHouses(sim);
    if (q.t > q.dur + 4) sim.quake = null;
  }

  slideIntoCracks(sim: Sim, dt: number): void {
    const q = sim.quake;
    if (!q || q.t < 0.12) return;
    for (const u of sim.units) {
      if (u.hp <= 0) continue;
      const n = this.nearestOpenCrack(sim, u.x, u.z);
      if (n.d > 0.9) continue;
      if (n.d > 0.02) {
        const nx = (n.x - u.x) / n.d;
        const nz = (n.z - u.z) / n.d;
        const spd = 2.6 * (1 - n.d / 0.9);
        u.x = clamp(u.x + nx * spd * dt, 0.3, WORLD - 0.3);
        u.z = clamp(u.z + nz * spd * dt, 0.3, WORLD - 0.3);
        u.y = sim.world.heightAt(u.x, u.z);
        u.path = [];
        u.pathI = 0;
        u.think = 1.2;
      }
      const rim = sim.world.heightAt(u.x + 0.55, u.z);
      const here = sim.world.heightAt(u.x, u.z);
      if (q.t > 1.38 && n.d < 0.28 && (here < WATER + 0.06 || rim - here > 0.22)) {
        u.hp = 0;
        sim.quakeKill = true;
        sim.quakeKillX = u.x;
        sim.quakeKillZ = u.z;
        if (u.team === BLUE) sim.toast(u.kind === "shaman" ? "祭司坠入地缝" : "一名子民坠入地缝");
      }
    }
  }

  collapseCutHouses(sim: Sim): void {
    const q = sim.quake;
    if (!q) return;
    for (const b of sim.buildings) {
      if (b.hp <= 0 || b.kind === "rebirth") continue;
      const pad = sim.buildingPad(b);
      let hit = false;
      for (let k = 0; k < q.angs.length && !hit; k++) {
        const opened = q.opened[k]!;
        for (let s = 0; s <= opened; s += 0.22) {
          const p = this.crackPoint(q, k, s);
          if (inPad(p.x, p.z, pad, 0.22)) {
            hit = true;
            break;
          }
        }
      }
      if (!hit) continue;
      b.hp = 0;
      sim.quakeHutDown = true;
    }
  }
}
