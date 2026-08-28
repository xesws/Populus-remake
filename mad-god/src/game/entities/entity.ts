import { Owner } from "../types";

export abstract class BaseEntity {
  id: number;
  x: number;
  z: number;
  y: number;
  team: Owner;
  hp: number;
  maxHp: number;

  constructor(id: number, team: Owner, x: number, z: number, y: number, hp: number, maxHp = hp) {
    this.id = id;
    this.team = team;
    this.x = x;
    this.z = z;
    this.y = y;
    this.hp = hp;
    this.maxHp = maxHp;
  }

  get alive(): boolean {
    return this.hp > 0;
  }
}
