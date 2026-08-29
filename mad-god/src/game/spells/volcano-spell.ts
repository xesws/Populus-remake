import { BLUE, inMap, Team, TREE_REGEN } from "../types";
import type { Sim } from "../sim";
import { Spell, SpellResult } from "./spell";

/**
 * v0.22 喷射方向分布采样：全向（width=2π）均匀取角；扇区模式下围绕主方向 φ
 * 做钟形取样（三均匀和近似高斯，越靠近主方向概率越高）——"南边多一点、北边少一点"。
 */
function sampleBiasAngle(phi: number, width: number): number {
  if (width >= Math.PI * 2 - 1e-3) return Math.random() * Math.PI * 2;
  const g = (Math.random() + Math.random() + Math.random() - 1.5) / 1.5; // [-1,1] 钟形
  return phi + g * width * 0.5;
}

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


  cast(sim: Sim, team: Team, x: number, z: number, _dt?: number): SpellResult {
    const empty: SpellResult = { ok: false, bolts: [], shake: 0, msg: "" };
    if (!inMap(x, z)) return empty;
    if (!sim.spendCharge(team, this.id)) return { ...empty, msg: "法力不足" };
    if (!this.beginVolcano(sim, x, z)) {
      sim.refundCharge(team, this.id, 1); // 火山还在喷，退还
      return { ...empty, msg: "火山还在喷" };
    }
    return { ok: true, bolts: [], shake: 0.5, msg: "火山喷发" };
  }

  beginVolcano(sim: Sim, x: number, z: number): boolean {
    if (sim.volcano && sim.volcano.t < sim.volcano.dur + 1.2) return false;
    // v0.22 快照抬升前的地面：隆起动画每帧按快照直接计算目标形状（精确穹顶，不漂移）。
    // v0.26b 快照存进 sim.volcano（VolcanoSpell 有 SPELLS 单例与 Sim 实例两份，
    // 存实例字段会让 cast（单例）写、tick（Sim 实例）读 null → 火山一放就崩）。
    sim.volcano = {
      x,
      z,
      t: 0,
      dur: 2.6,
      biasPhi: Math.random() * Math.PI * 2,
      biasWidth: Math.random() < 0.35 ? Math.PI * 2 : Math.PI * (0.6 + Math.random() * 1.1),
      shapePhase: Math.random() * Math.PI * 2,
      liftBase: Math.max(sim.world.heightAt(x, z), 0.8),
      origH: new Float32Array(sim.world.h),
    };
    // v0.21 爆发震撼：初爆震屏拉满（0.55），由渲染端衰减。
    sim.fxShake = Math.max(sim.fxShake, 0.55);
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
        // v0.22 渐进抬升为平滑穹顶（中间高四周矮，按原地面快照直接设形状）+ 低频方位不规则。
        const prog = Math.min(1, v.t / v.dur);
        sim.world.raisePlateau(v.x, v.z, 6.5, v.liftBase + 2.6 * prog, v.shapePhase, v.origH);
      }
      if (v.t > 0.8 && v.t <= v.dur + 2.4) {
        this.erupt(sim, v, dt);
        // v0.21 初喷 1.5s 持续轰鸣震动（渲染端逐帧衰减，这里持续补压）。
        if (v.t < 1.5) sim.fxShake = Math.max(sim.fxShake, 0.3);
      }
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
   * v0.22 源头注入 + 喷射方向分布：喷发窗口（t 0.8 ~ dur+2.4 ≈ 5s）内每帧从火山口
   * 沿**方向分布**采样的口缘裂隙涌出（biasPhi/biasWidth：全向 360° 或偏某扇区——
   * "南边多一点、北边少一点"），岩浆从山顶顺穹顶坡向四周（偏置侧更多）流下。
   * 节奏"起喷渐起 → 主喷最猛 → 尾期衰减"。
   */
  private erupt(
    sim: Sim,
    v: { x: number; z: number; t: number; dur: number; biasPhi: number; biasWidth: number; liftBase: number; origH: Float32Array },
    dt: number,
  ): void {
    const win = v.dur + 2.4 - 0.8;
    const et = Math.min(1, (v.t - 0.8) / win); // 0..1
    const rampUp = Math.min(1, et / 0.12); // 起喷渐起（前 12% 窗口）
    const rate = 32 * rampUp * (1 - et * 0.55); // v0.21 主喷 32/s：汹涌翻腾、直接溢出来的量级
    const ang = sampleBiasAngle(v.biasPhi, v.biasWidth);
    const rr = 0.6 + Math.random() * 1.1; // 口缘（山顶平台外沿），岩浆从山口溢出而非中心点泉眼
    sim.world.pourLava(
      v.x + Math.cos(ang) * rr,
      v.z + Math.sin(ang) * rr,
      0.8 + Math.random() * 0.5,
      rate * dt,
    );
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
