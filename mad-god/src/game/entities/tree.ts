export class Tree {
  id: number;
  x: number;
  z: number;
  y: number;
  alive: boolean;
  regen: number;

  constructor(id: number, x: number, z: number, y: number, alive = true, regen = 0) {
    this.id = id;
    this.x = x;
    this.z = z;
    this.y = y;
    this.alive = alive;
    this.regen = regen;
  }
}
