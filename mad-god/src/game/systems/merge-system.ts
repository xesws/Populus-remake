import { BLUE, dist2, unitHp } from "../types";
import type { Sim } from "../sim";
import type { ISystem } from "./system";

export class MergeSystem implements ISystem {
  update(sim: Sim, _dt: number): void {
    this.mergeWalkers(sim);
  }

  mergeWalkers(sim: Sim): void {
    if (sim.freezeMerge) return;
    const walkers = sim.units.filter((u) => u.kind === "walker" && u.homeId === 0 && u.str < 3 && u.job !== "train" && u.carry === 0);
    for (let i = 0; i < walkers.length; i++) {
      const a = walkers[i]!;
      if (a.hp <= 0) continue;
      for (let j = i + 1; j < walkers.length; j++) {
        const b = walkers[j]!;
        if (b.hp <= 0 || a.team !== b.team) continue;
        if (dist2(a.x, a.z, b.x, b.z) > 0.36) continue;
        a.str = Math.min(3, a.str + b.str);
        a.hp = a.maxHp = unitHp("walker", a.str);
        b.hp = 0;
        if (a.team === BLUE) sim.toast("两名子民合为更强的行者");
        break;
      }
    }
  }
}
