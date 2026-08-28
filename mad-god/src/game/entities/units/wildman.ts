import { Unit } from "../unit";
import { Owner, UnitKind } from "../../types";

export class Wildman extends Unit {
  override kind: UnitKind = "wildman";

  constructor(id: number, team: Owner, x: number, z: number, y: number, hp: number, maxHp = hp, str = 1) {
    super(id, team, x, z, y, hp, maxHp, str);
    this.kind = "wildman";
  }
}
