import { BLUE, Building, inMap, isCampKind, WATER } from "../types";
import type { Sim } from "../sim";
import type { ISystem } from "./system";

export class HazardSystem implements ISystem {
  update(sim: Sim, dt: number): void {
    this.hazards(sim, dt);
  }

  hazards(sim: Sim, dt: number): void {
    if (sim.review) return;
    for (const u of sim.units) {
      if (!inMap(u.x, u.z) || sim.world.heightAt(u.x, u.z) <= WATER) {
        u.hp -= 4 * dt;
        continue;
      }
      const i = sim.world.sampleAt(u.x, u.z);
      if (sim.world.lava[i]! > 0) {
        u.hp -= 10 * dt;
        if (!sim.lavaHurt && u.team === BLUE) {
          sim.lavaHurt = true;
          sim.toast(u.kind === "shaman" ? "祭司被岩浆烫伤" : "一名子民被岩浆烫伤");
        }
      }
      if (sim.world.swamp[i]! > 0) {
        u.swampT += dt;
        if (u.swampT >= 5) {
          u.hp = 0;
          sim.swampKill = true;
          sim.swampKillX = u.x;
          sim.swampKillZ = u.z;
          if (u.team === BLUE) sim.toast(u.kind === "shaman" ? "祭司死于毒气" : "一名子民死于毒气");
        }
      } else {
        u.swampT = 0;
      }
    }
  }

  burnBuildings(sim: Sim, dt: number): void {
    for (const b of sim.buildings) {
      if (b.hp <= 0 || b.kind === "rebirth") continue;
      if (!this.lavaOnPad(sim, b)) continue;
      if (!b.shell) {
        b.shell = true;
        b.hp = Math.max(1, b.maxHp * 0.4);
        if (b.team === BLUE && (b.kind === "hut" || isCampKind(b.kind))) sim.toast("一座屋宇烧成骨架");
      } else {
        b.hp -= 4 * dt;
      }
    }
  }

  lavaOnPad(sim: Sim, b: Building): boolean {
    const pts: [number, number][] = [
      [b.x, b.z],
      [b.x + b.padW * 0.35, b.z],
      [b.x - b.padW * 0.35, b.z],
      [b.x, b.z + b.padD * 0.35],
      [b.x, b.z - b.padD * 0.35],
    ];
    for (const [x, z] of pts) {
      if (sim.world.lava[sim.world.sampleAt(x, z)]! > 0) return true;
    }
    return false;
  }
}
