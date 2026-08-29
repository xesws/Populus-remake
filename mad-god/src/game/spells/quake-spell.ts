import { BLUE, clamp, inMap, Team, TREE_REGEN, WATER, WORLD } from "../types";
import type { Sim } from "../sim";
import { inPad } from "../world";
import { Spell, SpellResult } from "./spell";

export class QuakeSpell extends Spell {
  readonly id = "quake" as const;

  cast(sim: Sim, team: Team, x: number, z: number, _dt?: number): SpellResult {
    const empty: SpellResult = { ok: false, bolts: [], shake: 0, msg: "" };
    if (!inMap(x, z)) return empty;
    if (!sim.spendCharge(team, this.id)) return { ...empty, msg: "法力不足" };
    if (!this.beginQuake(sim, x, z)) {
      sim.refundCharge(team, this.id, 1); // 施放失败退还这一颗
      return { ...empty, msg: "大地震还在裂" };
    }
    return { ok: true, bolts: [], shake: 0.4, msg: "大地震动" };
  }

  // v0.18 范围扩张：5~6 条裂缝、每条长 8~10 格，角度 360° 均匀分布 + 随机抖动，
  // 最远覆盖半径 ≥ 8，与新版火山爆发（半径 6.5~7）持平甚至更大。angs/lens/opened 同步同长。
  beginQuake(sim: Sim, x: number, z: number): boolean {
    if (sim.quake && sim.quake.t < sim.quake.dur + 0.35) return false;
    const n = 5 + (Math.random() < 0.5 ? 1 : 0);
    const angs: number[] = [];
    const lens: number[] = [];
    const opened: number[] = [];
    for (let k = 0; k < n; k++) {
      const base = (k / n) * Math.PI * 2; // 均匀铺满 360°
      const jitter = (Math.random() - 0.5) * 0.5; // ±0.25 rad 随机抖动，避免蛛网对称
      angs.push(base + jitter);
      lens.push(8 + Math.random() * 2);
      opened.push(0);
    }
    sim.quake = { x, z, t: 0, dur: 2.0, angs, lens, opened };
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
        // v0.18 地裂冒浆：新展开段沿缝每 ~0.5 格涌出岩浆，走既有 tickFx 冷却（约 5~10 秒干涸）。
        // 裂缝根部（靠近震中）裂得最深、涌浆最猛：半径与余量都随深度加深而加厚。
        for (let s = prev; s < target; s += 0.5) {
          const p = this.crackPoint(q, k, s);
          const depth = 1 - s / q.lens[k]!; // 0=尖端 1=根部
          sim.world.seedLava(p.x, p.z, 0.5 + 0.45 * depth, 6 + Math.random() * 3 + depth);
        }
        const tip = this.crackPoint(q, k, target);
        sim.world.sinkTrench(tip.x, tip.z, 0.64, 0.4);
        q.opened[k] = target;
      }
    }
    this.slideIntoCracks(sim, dt);
    this.collapseCutHouses(sim);
    this.burnTrees(sim);
    // v0.18 岩浆灼烧房屋：复用既有 burnBuildings 链路（shell 骨架化后持续掉血）。
    // 注意 volcanoSpell.tick 也每帧无条件调 burnBuildings——同帧两次结算烧房更快（约 8/s），主 agent 集成时可择一去重。
    sim.burnBuildings(dt);
    if (q.t > q.dur + 4) sim.quake = null;
  }

  // v0.18 岩浆灼烧树木：站在岩浆上的树直接烧死，按既有 regen 节奏（25s）慢慢长回。
  burnTrees(sim: Sim): void {
    for (const t of sim.trees) {
      if (!t.alive) continue;
      if (sim.world.lava[sim.world.sampleAt(t.x, t.z)]! > 0) {
        t.alive = false;
        t.regen = TREE_REGEN;
      }
    }
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
