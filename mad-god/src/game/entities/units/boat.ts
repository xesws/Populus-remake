import { Unit } from "../unit";
import { Owner, UnitKind } from "../../types";

/**
 * v0.32 战船（两栖载具）：
 * - 本体无武器（ATTACK/RANGE/SIGHT 全 0），只当载具与靶子；伤害全靠船上船员
 *   （CombatSystem.boatCombat 独立通道，towerCombat 同款）；
 * - 船员 `homeId` 挂船 id：不可点选/不可索敌/不吃陆地指派（既有 homeId 口径全覆盖）；
 * - 移动不走陆地 A*：`PathSystem.moveUnits` 船分支按 `u.path`（waterAstar 产物）
 *   以 BOAT_SPEED 推进，y 钉吃水线（仿 isFlying 先例跳过地面吸附）；
 * - `sinkT > 0` = 正在沉没：锁控、不可选中（选中集进入时已清），归零由 BoatSystem
 *   处决船员，cull 为沉没让路（见 Sim.cull 守卫）。
 */
export class Boat extends Unit {
  override kind: UnitKind = "boat";

  constructor(id: number, team: Owner, x: number, z: number, y: number, hp: number, maxHp = hp, str = 1) {
    super(id, team, x, z, y, hp, maxHp, str);
    this.kind = "boat";
  }

  /** 船上的人不算"上岸人口"：countPop 跳过船（boat-check 锁定）。 */
  override isSoldier(): boolean {
    return false;
  }
}
