import { BLUE, Building, damageAfterArmor, isCampKind, Unit, UnitKind } from "./types";
import type { Sim } from "./sim";

/**
 * 统一伤害结算入口（v0.7）。
 * 护甲与克制只在 applyUnitDamage 里结算；近战 / 火球 / 落地伤害都必须走这里。
 * applyBuildingDamage 沿用骨架（完好 → 柱梁骨架 → 拆没）三段规则。
 */

export function applyUnitDamage(target: Unit, atkKind: UnitKind): number {
  if (target.hp <= 0) return 0;
  const dmg = damageAfterArmor(atkKind, target.kind);
  target.hp -= dmg;
  return dmg;
}

export function applyBuildingDamage(sim: Sim, b: Building, dmg: number): void {
  if (!b.shell && b.level >= 1 && b.hp - dmg <= 0) {
    b.shell = true;
    b.hp = Math.max(1, b.maxHp * 0.4);
    if (b.team === BLUE && (b.kind === "hut" || isCampKind(b.kind))) sim.toast("一座屋宇被拆成骨架");
    return;
  }
  b.hp -= dmg;
}
