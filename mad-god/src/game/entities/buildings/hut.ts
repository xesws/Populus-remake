import { Building } from "../building";
import { BuildingKind, houseMaxPop, Team } from "../../types";

export class Hut extends Building {
  readonly kind: BuildingKind = "hut";

  constructor(
    id: number,
    team: Team,
    x: number,
    z: number,
    y: number,
    hp: number,
    maxHp = hp,
    level = 0,
    yaw = 0,
    padW = 0,
    padD = 0,
    need = 0,
  ) {
    super(id, team, x, z, y, hp, maxHp, level, yaw, padW, padD, need);
  }

  override maxPopulation(): number {
    return this.level >= 1 ? houseMaxPop(this.level) : 0;
  }
}
