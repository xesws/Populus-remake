import { FIREBALL_BURN_DPS, FIREBALL_BURN_T, FIREBALL_DMG, inMap, Team } from "../types";
import type { Sim } from "../sim";
import { Spell, SpellResult } from "./spell";

/**
 * v0.26 火球法术（立即命中，用户拍板无弹道）：
 * - 扣 1 颗充能 → 目标点半径 1.7 格（与 blast 同口径）内**非己方**单位：
 *   立即伤害 FIREBALL_DMG + 击飞（复用 blast 的 flyVx/flyVy 参数）+ 着火
 *   （burnT 期间持续 burnDps 轻微伤害；burnT/burnDps 独立于 fireT 视觉，与岩浆/闪电不叠加）。
 * - 命中特效复用 sim.blast 爆炸环（blastHit 驱动渲染端冲击波）。
 */
export class FireballSpell extends Spell {
  readonly id = "fireball" as const;

  cast(sim: Sim, team: Team, x: number, z: number, _dt?: number): SpellResult {
    const empty: SpellResult = { ok: false, bolts: [], shake: 0, msg: "" };
    if (!inMap(x, z)) return empty;
    if (!sim.spendCharge(team, this.id)) return { ...empty, msg: "法力不足" };
    let hit = false;
    for (const u of sim.units) {
      if (u.hp <= 0) continue;
      if (u.team === team) continue; // 只打非己方（敌方与野人）
      if (Math.hypot(u.x - x, u.z - z) > 1.7) continue;
      hit = true;
      u.hp -= FIREBALL_DMG;
      u.burnT = FIREBALL_BURN_T;
      u.burnDps = FIREBALL_BURN_DPS;
      // 击飞：与 blast 同参数（flyVx 4.6 / flyVy 5.8），清移动意图避免被寻路拽回。
      let dx = u.x - x;
      let dz = u.z - z;
      const len = Math.hypot(dx, dz) || 1;
      dx /= len;
      dz /= len;
      u.flyVx = dx * 4.6;
      u.flyVz = dz * 4.6;
      u.flyVy = 5.8;
      u.y = sim.world.heightAt(u.x, u.z) + 0.35;
      u.path = [];
      u.pathI = 0;
      u.think = 1.2;
      if (u.team === 0) sim.toast(u.kind === "shaman" ? "祭司被火球轰飞" : "一名子民被火球轰飞");
    }
    if (hit) {
      sim.blast = { x, z, t: 0, life: 0.5 };
      sim.blastHit = true;
      sim.fxShake = Math.max(sim.fxShake, 0.25);
      return { ok: true, bolts: [], shake: 0.25, msg: "火球爆裂" };
    }
    return { ok: true, bolts: [], shake: 0.1, msg: "火球落空" };
  }
}
