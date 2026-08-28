import type { Sim } from "../sim";

export interface ISystem {
  update(sim: Sim, dt: number): void;
}
