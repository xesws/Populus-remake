import { inMap, METEOR_FALL_V, METEOR_START_Y, Team } from "../types";
import type { Sim } from "../sim";
import { Spell, SpellResult } from "./spell";

/**
 * v0.27f 火球法术重构为"天降陨石"（用户拍板）：
 * - 旧实现立即命中 8 伤 + 击飞——村民 6 血直接秒没、人被甩上天像"瞬间蒸发"。
 * - 现在施放只做两件事：扣 1 颗充能 + 在目标点上方高空（METEOR_START_Y）生成一颗
 *   坠落火球（sim.meteors，跨帧状态挂 sim，不走 Spell 实例字段）。
 * - 下落与撞击结算都在 Sim.tickMeteors：撞击小直接伤害 + 点燃（主伤害靠灼烧）。
 */
export class FireballSpell extends Spell {
  readonly id = "fireball" as const;

  cast(sim: Sim, team: Team, x: number, z: number, _dt?: number): SpellResult {
    const empty: SpellResult = { ok: false, bolts: [], shake: 0, msg: "" };
    if (!inMap(x, z)) return empty;
    if (!sim.spendCharge(team, this.id)) return { ...empty, msg: "法力不足" };
    sim.meteors.push({ x, z, y: METEOR_START_Y, vy: -METEOR_FALL_V, team });
    return { ok: true, bolts: [], shake: 0.08, msg: "火球自天而降" };
  }
}
