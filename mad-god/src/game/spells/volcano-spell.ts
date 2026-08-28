import { BLUE, inMap, Team, TREE_REGEN } from "../types";
import type { Sim } from "../sim";
import { Spell, SpellResult } from "./spell";

/**
 * v0.18 火山法术（Agent V）重做：
 * - 地形：不再 sculpt 尖峰，改用 raisePlateau 在 dur 内逐帧渐进隆起 6.5 格宽的平顶缓坡高原
 *   （顶部平坦、外圈 smoothstep 缓坡，目标高 = cast 时原高 + 2.6）；
 * - 岩浆：growRivers reach 扩到 16 长河臂 + 每次 tick 连续旋转角度的支流 seed + 火山口加厚
 *   （life 8~10，窗口结束后最后一批约 10s 才干）。注意 growRivers 自带 lava.fill(0)，
 *   所以支流/火山口必须在 growRivers 之后 seed，否则被清掉；
 * - 伤害：树木直接烧没（alive=false + regen 拉长，灰烬很久才复生）；岩浆上单位 26/s 极高灼烧
 *   （叠加 hazardSystem 的 10/s 共 36/s，触发起火特效 fireT）；建筑烧毁继续走 sim.burnBuildings
 *   （完好 → 骨架 → 烧毁）；
 * - 焦土：lava 活跃区 scorch 刷到 2.2，干涸后灰褐焦土还能残留 ~15s。
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
      if (v.t > 1.1 && v.t <= v.dur + 2.0) this.eruptRivers(sim, v);
      if (v.t <= v.dur + 6) this.deepenScorch(sim);
      if (v.t > v.dur + 8) sim.volcano = null;
      this.holdPadsNearVolcano(sim);
      this.burnTreesOnLava(sim);
      this.burnUnitsOnLava(sim, dt);
      // v0.18 仅火山活动期间结算烧房（quake spell 也会调 burnBuildings，无条件调用会双倍烧速）。
      sim.burnBuildings(dt);
    }
  }

  /** v0.18 喷发期（t 1.1~4.6s）：4 条主河臂（reach 16）+ 连续旋转角度支流 + 火山口加厚。 */
  private eruptRivers(sim: Sim, v: { x: number; z: number; t: number }): void {
    // growRivers 自带 lava.fill(0)：必须先调用清旧，再 seed 支流/火山口（否则被清）。
    sim.world.growRivers(v.x, v.z, 16);
    // v0.18 支流：角度随时间连续旋转 + 正弦摆动（确定性伪随机，避免每 tick 闪跳），
    // 从火山口向外 3~13 格撒两条轨迹——随时间在 lava 区外围扫出扇形支流。
    for (let i = 0; i < 2; i++) {
      const ang = v.t * 0.55 + i * 2.1 + Math.sin(v.t * 0.7 + i * 2.0) * 0.55;
      for (let s = 3; s <= 13; s += 1.6) {
        sim.world.seedLava(v.x + Math.cos(ang) * s, v.z + Math.sin(ang) * s, 0.5, 8 + (s % 3));
      }
    }
    // 火山口岩浆加厚（比河臂 3.6 更亮更久）；窗口在 t≈4.55 结束，最后一批 life 10 → 约 14.5s 才干。
    sim.world.seedLava(v.x, v.z, 1.1, 10);
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
