import { Unit } from "../unit";
import { Owner, UnitKind } from "../../types";

export class Spy extends Unit {
  override kind: UnitKind = "spy";

  constructor(id: number, team: Owner, x: number, z: number, y: number, hp: number, maxHp = hp, str = 1) {
    super(id, team, x, z, y, hp, maxHp, str);
    this.kind = "spy";
  }

  // v0.19 间谍具备索敌能力（UNIT_SIGHT.spy=4）：小范围内自动攻击敌人。
  override isSoldier(): boolean {
    return true;
  }
}
