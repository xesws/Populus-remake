import { BaseEntity } from "./entity";
import { BuildingKind, Team } from "../types";

export abstract class Building extends BaseEntity {
  abstract readonly kind: BuildingKind;
  declare team: Team;

  yaw = 0;
  padW = 0;
  padD = 0;
  level = 0;
  prod = 0;
  wood = 0;
  need = 0;
  shell = false;
  dwell = 0;
  born = 0;
  wantLevel = 0;

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
    super(id, team, x, z, y, hp, maxHp);
    this.level = level;
    this.yaw = yaw;
    this.padW = padW;
    this.padD = padD;
    this.need = need;
  }

  isCamp(): boolean {
    return false;
  }

  maxPopulation(): number {
    return 0;
  }
}
