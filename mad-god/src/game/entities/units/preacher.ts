import { Unit } from "../unit";
import { Owner, UnitKind } from "../../types";

export class Preacher extends Unit {
  override kind: UnitKind = "preacher";

  constructor(id: number, team: Owner, x: number, z: number, y: number, hp: number, maxHp = hp, str = 1) {
    super(id, team, x, z, y, hp, maxHp, str);
    this.kind = "preacher";
  }

  override isSoldier(): boolean {
    return true;
  }

  override canConvert(): boolean {
    return false;
  }
}
