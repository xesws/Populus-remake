import { BLUE, RED } from "../types";
import type { Sim } from "../sim";
import type { ISystem } from "./system";

export class WinSystem implements ISystem {
  update(sim: Sim, _dt: number): void {
    this.checkWin(sim);
  }

  checkWin(sim: Sim): void {
    if (sim.lockWin) return;
    if (sim.time < 20) return;
    const blueDead = sim.countPop(BLUE) === 0 && sim.countHouses(BLUE) === 0;
    const redDead = sim.countPop(RED) === 0 && sim.countHouses(RED) === 0;
    if (blueDead && redDead) sim.winner = -1;
    else if (blueDead) sim.winner = RED;
    else if (redDead) sim.winner = BLUE;
  }
}
