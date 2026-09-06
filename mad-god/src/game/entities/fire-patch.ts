import { Team } from "../types";

/**
 * v0.30 大龙吐息落地的燃烧地块：持续燃烧一小会儿，伤害随剩余寿命线性衰减
 * （dps(t) = dps0 × life/maxLife）。不经过护甲（火烧），对非施放队伍的单位生效，
 * 压到的敌方建筑走 applyBuildingDamage。由 DragonSystem 生成与 tick。
 */
export class FirePatch {
  x: number;
  z: number;
  r: number;
  /** 剩余寿命（秒），归零移除。 */
  life: number;
  maxLife: number;
  dps0: number;
  team: Team;

  constructor(x: number, z: number, r: number, life: number, dps0: number, team: Team) {
    this.x = x;
    this.z = z;
    this.r = r;
    this.life = life;
    this.maxLife = life;
    this.dps0 = dps0;
    this.team = team;
  }

  /** 当前每秒伤害（随剩余寿命线性衰减）。 */
  dps(): number {
    return this.dps0 * Math.max(0, this.life / this.maxLife);
  }
}
