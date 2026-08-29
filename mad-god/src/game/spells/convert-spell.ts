import { canConvert, CONVERT_CAST_RANGE, CONVERT_RADIUS, inMap, Team } from "../types";
import type { Sim } from "../sim";
import { Spell, SpellResult } from "./spell";

/**
 * v0.26 转化法术：
 * - 施法点必须距己方**存活大祭司** ≤ CONVERT_CAST_RANGE（4 格），否则拒绝并提示。
 * - 以施法点 CONVERT_RADIUS（2.5 格）内敌方单位（canConvert：祭司/传教士免疫，
 *   与感化同规则）全部转成己方 walker（走 sim.convertTo 公共换队逻辑）。
 * - 选中技能后鼠标处显示范围圈（render-parts/convert-range-fx.ts），超距变红灰。
 */
export class ConvertSpell extends Spell {
  readonly id = "convert" as const;

  cast(sim: Sim, team: Team, x: number, z: number, _dt?: number): SpellResult {
    const empty: SpellResult = { ok: false, bolts: [], shake: 0, msg: "" };
    if (!inMap(x, z)) return empty;
    const shaman = sim.units.find((u) => u.team === team && u.kind === "shaman" && u.hp > 0);
    if (!shaman) return { ...empty, msg: "大祭司已陨落" };
    if (Math.hypot(shaman.x - x, shaman.z - z) > CONVERT_CAST_RANGE) {
      return { ...empty, msg: "需在大祭司身边施放" };
    }
    if (!sim.spendCharge(team, this.id)) return { ...empty, msg: "法力不足" };
    const foe: Team = team === 0 ? 1 : 0;
    let n = 0;
    for (const u of sim.units) {
      if (u.hp <= 0) continue;
      if (u.team !== foe && u.team !== 2) continue; // 敌方与野人
      if (!canConvert(u.kind)) continue;
      // 注意：hypot 返回距离（非平方），直接与半径比。
      if (Math.hypot(u.x - x, u.z - z) > CONVERT_RADIUS) continue;
      sim.convertTo(u, team, "spell");
      n++;
    }
    if (n > 0) sim.toast(team === 0 ? `神恩普照，${n} 名敌人皈依` : `${n} 名子民倒戈`);
    return { ok: true, bolts: [], shake: 0, msg: n > 0 ? "神恩普照" : "圈内并无敌影" };
  }
}
