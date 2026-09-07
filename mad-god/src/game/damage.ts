import {
  BLUE,
  Building,
  counterMult,
  isCampKind,
  isTribe,
  UNIT_ARMOR,
  unitAttack,
  Unit,
  UnitKind,
} from "./types";
import type { Sim } from "./sim";

/**
 * 统一伤害结算入口（v0.7）。
 * 护甲与克制只在 applyUnitDamage 里结算；近战 / 火球 / 落地伤害都必须走这里。
 * applyBuildingDamage 沿用骨架（完好 → 柱梁骨架 → 拆没）三段规则。
 */

export function applyUnitDamage(target: Unit, atkKind: UnitKind, rawDmg?: number, sim?: Sim): number {
  if (target.hp <= 0) return 0;
  const raw = rawDmg ?? unitAttack(atkKind);
  const dmg = Math.max(1, Math.round(raw * counterMult(atkKind, target.kind) - UNIT_ARMOR[target.kind]));
  target.hp -= dmg;
  // v0.31 受袭感知：部落单位被攻击即上报 AI 防御响应（近战/火球/塔弹等全部经此结算）。
  // 击飞落地自伤等非攻击伤害（path-system）不传 sim，不上报。
  if (sim && isTribe(target.team)) sim.onTeamHurt?.(target.team, target.x, target.z);
  return dmg;
}

export function applyBuildingDamage(sim: Sim, b: Building, dmg: number): void {
  // v0.31 受袭感知：部落建筑被打即上报（一处覆盖近战拆家/火球/龙焰等全部建筑伤害；
  // DoT 刷频由 WarDirector.onHurt 的 1s 节流压平）。
  if (dmg > 0 && isTribe(b.team)) sim.onTeamHurt?.(b.team, b.x, b.z);
  if (!b.shell && b.level >= 1 && b.hp - dmg <= 0) {
    b.shell = true;
    b.hp = Math.max(1, b.maxHp * 0.4);
    if (b.team === BLUE && (b.kind === "hut" || isCampKind(b.kind))) sim.toast("一座屋宇被拆成骨架");
    return;
  }
  b.hp -= dmg;
}
