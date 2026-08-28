import type { Sim } from "../sim";
import { Team, Tool, TOOL_COST, UNLOCK_CAP } from "../types";

export interface SpellResult {
  ok: boolean;
  bolts: { x0: number; z0: number; x1: number; z1: number; life: number }[];
  shake: number;
  msg: string;
}

export abstract class Spell {
  abstract readonly id: Tool;

  get cost(): number {
    return TOOL_COST[this.id];
  }

  get unlockCap(): number {
    return UNLOCK_CAP[this.id];
  }

  canUnlock(manaCap: number): boolean {
    return manaCap >= this.unlockCap;
  }

  abstract cast(sim: Sim, team: Team, x: number, z: number, dt?: number): SpellResult;

  tick(_sim: Sim, _dt: number): void {}
}
