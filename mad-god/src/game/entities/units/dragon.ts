import { Unit } from "../unit";
import { Owner, UnitKind } from "../../types";

/**
 * v0.30 大龙（飞龙）：飞在空中的巨型作战单位。
 * - 位置（x/z/y）与朝向由 DragonSystem 每帧直接积分（飞行不走 A*、不受地面碰撞）；
 * - 索敌/吐息/脱锁同样由 DragonSystem 接管（atkId 复用自 Unit 基类，零新增字段）；
 * - 所有地面系统经 `isFlying()` 门控跳过它。
 */
export class Dragon extends Unit {
  override kind: UnitKind = "dragon";

  constructor(id: number, team: Owner, x: number, z: number, y: number, hp: number, maxHp = hp, str = 1) {
    super(id, team, x, z, y, hp, maxHp, str);
    this.kind = "dragon";
  }

  override isFlying(): boolean {
    return true;
  }
}
