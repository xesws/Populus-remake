import { BLUE, inMap, Team, TREE_REGEN } from "../types";
import type { Sim } from "../sim";
import { Spell, SpellResult } from "./spell";

/**
 * v0.18b 火山法术（物理溢流版，替代 v0.18 的"旋转支流扫描"——用户反馈像麦田怪圈）：
 * - 地形：raisePlateau 在 dur 内逐帧渐进隆起 6.5 格宽平顶缓坡高原（目标高 = cast 时原高 + 2.6）。
 * - 岩浆：**源头注入 + 流体模拟**——喷发窗口内每帧从火山口 pourLava 涌出（节奏先猛后衰，
 *   越喷越多），同时 flowLava 按坡度随机加权向下坡流动、平顶攒厚漫溢、入海熄灭，
 *   形成不规则舌状前沿（纯物理，无任何几何扫描）。
 * - 伤害：树木直接烧没（alive=false + regen 拉长）；岩浆上单位 26/s 极高灼烧
 *   （叠加 hazardSystem 的 10/s，触发起火特效 fireT）；建筑走 sim.burnBuildings。
 * - 焦土：lava 活跃区 scorch 刷到 2.2，干涸后灰褐焦土残留 ~15s。
 */
export class VolcanoSpell extends Spell {
  readonly id = "volcano" as const;

  /** v0.18 抬升基准高度（beginVolcano 时采样）。volcano 全局唯一，spell 又是单例，实例字段即可，无需改 Sim 类型。 */
  private liftBase = 0;

  cast(sim: Sim, team: Team, x: number, z: number, _dt?: number): SpellResult {
    const empty: SpellResult = { ok: false, bolts: [], shake: 0, msg: "" };
    if (!inMap(x, z)) return empty;
    if (!sim.spend(team, this.cost)) return { ...empty, msg: "法力不足" };
    if (!this.beginVolcano(sim, x, z)) {
      sim.teams[team].mana += this.cost;
      return { ...empty, msg: "火山还在喷" };
    }
    return { ok: true, bolts: [], shake: 0.25, msg: "火山抬起" };
  }

  beginVolcano(sim: Sim, x: number, z: number): boolean {
    if (sim.volcano && sim.volcano.t < sim.volcano.dur + 1.2) return false;
    // v0.18 记下 cast 时的地形高度：高原目标 = 原高 + 2.6（dur 内逐帧渐进逼近）。
    this.liftBase = Math.max(sim.world.heightAt(x, z), 0.8);
    sim.volcano = { x, z, t: 0, dur: 2.6 };
    sim.fxShake = Math.max(sim.fxShake, 0.28);
    return true;
  }

  holdPadsNearVolcano(sim: Sim): void {
    const v = sim.volcano;
    if (!v) return;
    for (const b of sim.buildings) {
      if (b.hp <= 0 || b.kind === "rebirth") continue;
      if (Math.hypot(b.x - v.x, b.z - v.z) < 2.8) continue;
      const h = Math.max(sim.world.heightAt(b.x, b.z), 0.8);
      sim.world.flattenPad(b.x, b.z, b.padW, b.padD, b.yaw, h);
      b.y = sim.world.heightAt(b.x, b.z);
    }
  }

  tick(sim: Sim, dt: number): void {
    const v = sim.volcano;
    if (v) {
      v.t += dt;
      if (v.t <= v.dur) {
        // v0.18 渐进抬升：目标高度逐帧逼近「原高+2.6」，形成隆起动画；6.5 格宽平顶缓坡高原。
        const prog = Math.min(1, v.t / v.dur);
        sim.world.raisePlateau(v.x, v.z, 6.5, this.liftBase + 2.6 * prog);
      }
      if (v.t > 0.8 && v.t <= v.dur + 2.4) this.erupt(sim, v, dt);
      // v0.18b 流体模拟：活动期全程驱动岩浆按坡度流动/漫溢（喷停后残余继续淌）。
      if (v.t > 0.8 && v.t <= v.dur + 8) sim.world.flowLava(dt);
      if (v.t <= v.dur + 6) this.deepenScorch(sim);
      if (v.t > v.dur + 8) sim.volcano = null;
      this.holdPadsNearVolcano(sim);
      this.burnTreesOnLava(sim);
      this.burnUnitsOnLava(sim, dt);
      // v0.18 仅火山活动期间结算烧房（quake spell 也会调 burnBuildings，无条件调用会双倍烧速）。
      sim.burnBuildings(dt);
    }
  }

  /**
   * v0.18b 源头注入：喷发窗口（t 0.8 ~ dur+2.4 ≈ 5s）内从火山口持续涌浆，
   * 节奏为"起喷渐起 → 主喷期最猛 → 尾期衰减"——越喷越多全靠注入累积，不是一次成型。
   */
  private erupt(sim: Sim, v: { x: number; z: number; t: number; dur: number }, dt: number): void {
    const win = v.dur + 2.4 - 0.8;
    const et = Math.min(1, (v.t - 0.8) / win); // 0..1
    const rampUp = Math.min(1, et / 0.12); // 起喷渐起（前 12% 窗口）
    const rate = 20 * rampUp * (1 - et * 0.55); // 主喷 ~20/s，尾期衰减到 ~9/s（总量控制在洼地积池可承受范围）
    sim.world.pourLava(v.x, v.z, 0.9, rate * dt);
  }

  /** v0.18 焦土加深：lava 活跃期间把 scorch 刷到 2.2，干涸后灰褐焦土还能残留 ~15s（而非几秒）。 */
  private deepenScorch(sim: Sim): void {
    const lava = sim.world.lava;
    const scorch = sim.world.scorch;
    for (let i = 0; i < lava.length; i++) {
      if (lava[i]! > 0 && scorch[i]! < 2.2) scorch[i] = 2.2;
    }
  }

  /** v0.18 岩浆过境：树木直接烧没。regen 必须拉长，否则 tickTrees 会在下一 tick 把它原地复活。 */
  private burnTreesOnLava(sim: Sim): void {
    for (const t of sim.trees) {
      if (!t.alive) continue;
      if (sim.world.lava[sim.world.sampleAt(t.x, t.z)]! > 0) {
        t.alive = false;
        t.regen = TREE_REGEN * 3;
      }
    }
  }

  /** v0.18 岩浆灼烧：26/s 极高伤害（叠加 hazard 的 10/s 共 36/s），并触发既有起火特效（fireT 驱动渲染端火焰）。 */
  private burnUnitsOnLava(sim: Sim, dt: number): void {
    for (const u of sim.units) {
      if (u.hp <= 0) continue;
      if (sim.world.lava[sim.world.sampleAt(u.x, u.z)]! <= 0) continue;
      u.hp -= 26 * dt;
      u.fireT = Math.max(u.fireT, 2.2);
      if (u.hp <= 0 && u.team === BLUE) {
        sim.toast(u.kind === "shaman" ? "祭司被岩浆吞没" : "一名子民被岩浆吞没");
      }
    }
  }
}
