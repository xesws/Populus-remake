import { Team } from "../types";
import type { Sim } from "../sim";
import { Spell, SpellResult } from "./spell";

export class ArmageddonSpell extends Spell {
  readonly id = "armageddon" as const;

  cast(_sim: Sim, _team: Team, _x: number, _z: number, _dt?: number): SpellResult {
    return { ok: false, bolts: [], shake: 0, msg: "地面重构中" };
  }
}
