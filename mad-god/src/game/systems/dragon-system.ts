import { applyBuildingDamage } from "../damage";
import { FirePatch } from "../entities/fire-patch";
import {
  BLUE,
  Building,
  clamp,
  dist2,
  DRAGON_ACQUIRE_INTERVAL,
  DRAGON_BREATH_SPEED,
  DRAGON_CRUISE,
  DRAGON_DROP_SPEED,
  DRAGON_FACTORY_DOOR_REACH,
  DRAGON_FACTORY_ENTER_T,
  DRAGON_GARRISON_MAX,
  DRAGON_PROD_T,
  DRAGON_RANGE,
  DRAGON_SPAWN_DROP_Y,
  DRAGON_SPEED,
  FIRE_IMPACT_DMG,
  FIRE_PATCH_DPS0,
  FIRE_PATCH_LIFE,
  FIRE_PATCH_R,
  Team,
  UNIT_ATK_CD,
  Unit,
  WORLD,
} from "../types";
import type { Sim } from "../sim";
import type { ISystem } from "./system";
import { logger } from "../logger";

/**
 * v0.30 大龙（飞龙）系统：大龙与大龙训练营的唯一归属地。
 * - 飞行：直接积分位置（不走 A*、不受地面碰撞），y 贴"地表 + 巡航高度"；
 * - 索敌：10 格内随机敌方单位/建筑，目标跑出 10 格自动弃锁重选（手动目标同规）；
 * - 吐息：龙口发射追踪弹，落地生成 FirePatch（持续衰减燃烧）+ 点名目标直接伤害；
 * - 工厂：20 名牛战士进驻满 → 60s 生产 → 完成后进驻者移除、大龙空降工厂上空；
 *   生产途中工厂被拆 → cull() 的迁出逻辑把牛战士原样弹出（进度作废）。
 */
export interface BreathShot {
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  team: Team;
  /** 点名目标（二选一）：命中时吃 FIRE_IMPACT_DMG 直接伤害。 */
  targetUnitId: number;
  targetBuildingId: number;
  /** 追踪落点（目标死亡后就地落地）。 */
  tx: number;
  ty: number;
  tz: number;
  life: number;
}

/** 攻击悬停距离：不贴脸，绕着目标外圈烤。 */
const HOVER_DIST = DRAGON_RANGE - 2;

export class DragonSystem implements ISystem {
  update(sim: Sim, dt: number): void {
    this.tick(sim, dt);
  }

  tick(sim: Sim, dt: number): void {
    this.tickFactories(sim, dt);
    this.tickDragons(sim, dt);
    this.tickBreaths(sim, dt);
    this.tickFires(sim, dt);
  }

  // ---------------------------------------------------------------------------
  // 大龙训练营：进驻 → 生产 → 空降
  // ---------------------------------------------------------------------------

  private tickFactories(sim: Sim, dt: number): void {
    for (const b of sim.buildings) {
      if (b.kind !== "dragonFactory" || b.hp <= 0 || b.level < 1) continue;
      if (b.dwell < DRAGON_GARRISON_MAX) continue;
      b.prod += dt / DRAGON_PROD_T;
      if (b.prod >= 1) this.completeProduction(sim, b);
    }
  }

  /** 生产完成：20 名进驻者化为大龙，空降在工厂上空。 */
  private completeProduction(sim: Sim, f: Building): void {
    const crew = sim.units.filter((u) => u.homeId === f.id);
    if (crew.length) sim.units = sim.units.filter((u) => u.homeId !== f.id);
    f.dwell = 0;
    f.prod = 0;
    const dragon = sim.addUnit(f.team, "dragon", f.x, f.z);
    dragon.y = sim.world.heightAt(f.x, f.z) + DRAGON_SPAWN_DROP_Y;
    dragon.think = 0; // 落地即索敌
    sim.toast(f.team === BLUE ? "大龙自工厂上空空降！" : "敌方大龙空降！");
    logger.info("combat", `大龙#${dragon.id} 空降（工厂#${f.id}，耗牛战士 ${crew.length}）`, { team: f.team });
  }

  /**
   * 牛战士进驻工厂（thinkUnits 在 tryGarrison 旁调用）：
   * targetId 指向本队 L1 工厂且走到门口即触发——homeId 挂厂、dwell 计数、走入动画。
   */
  tryEnterFactory(sim: Sim, u: Unit): boolean {
    if (u.kind !== "firewarrior" || u.homeId > 0 || !u.targetId) return false;
    const f = sim.buildingById(u.targetId);
    if (!f || f.kind !== "dragonFactory" || f.hp <= 0 || f.level < 1 || f.team !== u.team) return false;
    if (f.dwell >= DRAGON_GARRISON_MAX) return false;
    if (dist2(u.x, u.z, f.x, f.z) > DRAGON_FACTORY_DOOR_REACH * DRAGON_FACTORY_DOOR_REACH) return false;
    u.homeId = f.id;
    f.dwell += 1;
    u.selected = false;
    u.path = [];
    u.pathI = 0;
    u.job = "idle";
    u.think = 99;
    u.targetId = 0;
    u.atkId = 0;
    u.agroX = -1;
    u.agroZ = -1;
    u.channel = 0;
    u.carry = 0;
    u.enterT = DRAGON_FACTORY_ENTER_T;
    if (u.team === BLUE) sim.toast(`牛战士进驻大龙训练营（${f.dwell}/${DRAGON_GARRISON_MAX}）`);
    return true;
  }

  // ---------------------------------------------------------------------------
  // 大龙本体：索敌 / 飞行 / 吐息
  // ---------------------------------------------------------------------------

  private tickDragons(sim: Sim, dt: number): void {
    for (const u of sim.units) {
      if (!u.isFlying() || u.hp <= 0) continue;
      u.atkCd = Math.max(0, u.atkCd - dt);
      u.think = Math.max(0, u.think - dt);
      this.resolveTarget(sim, u);
      if (!u.atkId && u.think <= 0) {
        this.acquireRandom(sim, u);
        u.think = DRAGON_ACQUIRE_INTERVAL;
      }
      this.flyStep(sim, u, dt);
      this.tryBreath(sim, u);
    }
  }

  /** 目标有效性：死亡/拆除即清；跑出 10 格射程即弃锁（手动目标同规，下一轮自动重选）。 */
  private resolveTarget(sim: Sim, u: Unit): void {
    if (!u.atkId) return;
    const tu = sim.unitById(u.atkId);
    const tb = tu ? null : sim.buildingById(u.atkId);
    if (!tu && !tb) {
      u.atkId = 0;
      return;
    }
    const tx = tu ? tu.x : tb!.x;
    const tz = tu ? tu.z : tb!.z;
    if (Math.hypot(tx - u.x, tz - u.z) > DRAGON_RANGE) u.atkId = 0;
  }

  /** 全自动索敌：射程内随机挑一个敌方地面单位或建筑（需求 3b 的"随机攻击"）。 */
  private acquireRandom(sim: Sim, u: Unit): void {
    const enemy: Team = u.team === BLUE ? 1 : BLUE;
    const r2 = DRAGON_RANGE * DRAGON_RANGE;
    const pool: { id: number }[] = [];
    for (const o of sim.units) {
      if (o.team !== enemy || o.hp <= 0 || o.homeId > 0) continue;
      if (o.isFlying()) continue; // 喷火朝地面目标；对空交给别人
      if (dist2(u.x, u.z, o.x, o.z) > r2) continue;
      pool.push(o);
    }
    for (const b of sim.buildings) {
      if (b.team !== enemy || b.hp <= 0 || b.kind === "rebirth") continue;
      if (dist2(u.x, u.z, b.x, b.z) > r2) continue;
      pool.push(b);
    }
    if (!pool.length) return;
    u.atkId = pool[Math.floor(Math.random() * pool.length)]!.id;
  }

  /** 飞行积分：攻击时逼近/绕目标悬停；有飞行令直飞；无事绕团队锚点盘旋。 */
  private flyStep(sim: Sim, u: Unit, dt: number): void {
    let destX: number | null = null;
    let destZ: number | null = null;
    const tu = u.atkId ? sim.unitById(u.atkId) : null;
    const tb = !tu && u.atkId ? sim.buildingById(u.atkId) : null;
    if (tu || tb) {
      const tx = tu ? tu.x : tb!.x;
      const tz = tu ? tu.z : tb!.z;
      const d = Math.hypot(tx - u.x, tz - u.z) || 1;
      if (d > HOVER_DIST) {
        destX = tx;
        destZ = tz;
      } else {
        // 已进悬停圈：绕目标慢速环绕（半径 6.5，仍在 10 格射程内）
        const ang = sim.time * 0.4 + u.id * 1.3;
        destX = tx + Math.cos(ang) * (HOVER_DIST - 1.5);
        destZ = tz + Math.sin(ang) * (HOVER_DIST - 1.5);
      }
    } else if (u.moveX >= 0) {
      if (dist2(u.x, u.z, u.moveX, u.moveZ) < 0.6 * 0.6) {
        u.moveX = -1;
        u.moveZ = -1;
        u.job = "idle";
      } else {
        destX = u.moveX;
        destZ = u.moveZ;
      }
    } else {
      const t = sim.teams[u.team as Team];
      const ang = sim.time * 0.25 + u.id;
      destX = t.magnetX + Math.cos(ang) * 3;
      destZ = t.magnetZ + Math.sin(ang) * 3;
    }
    if (destX !== null && destZ !== null) {
      const dx = destX - u.x;
      const dz = destZ - u.z;
      const d = Math.hypot(dx, dz);
      if (d > 0.12) {
        const step = Math.min(d, DRAGON_SPEED * dt);
        u.x = clamp(u.x + (dx / d) * step, 0.6, WORLD - 0.6);
        u.z = clamp(u.z + (dz / d) * step, 0.6, WORLD - 0.6);
        u.yaw = Math.atan2(dx, dz);
      }
    }
    // 高度：空降/翻山先按下降速率落，再平滑贴"地表 + 巡航高度"。
    const cruise = sim.world.heightAt(u.x, u.z) + DRAGON_CRUISE;
    if (u.y > cruise + 0.3) {
      u.y = Math.max(cruise, u.y - DRAGON_DROP_SPEED * dt);
    } else {
      u.y += (cruise - u.y) * Math.min(1, 4 * dt);
    }
  }

  /** 吐息：射程内且冷却归零 → 从龙口发射追踪弹。 */
  private tryBreath(sim: Sim, u: Unit): void {
    if (u.atkCd > 0 || !u.atkId) return;
    const tu = sim.unitById(u.atkId);
    const tb = tu ? null : sim.buildingById(u.atkId);
    if (!tu && !tb) return;
    const tx = tu ? tu.x : tb!.x;
    const tz = tu ? tu.z : tb!.z;
    if (Math.hypot(tx - u.x, tz - u.z) > DRAGON_RANGE) return;
    const mx = Math.sin(u.yaw);
    const mz = Math.cos(u.yaw);
    const ox = u.x + mx * 0.8;
    const oz = u.z + mz * 0.8;
    const oy = u.y + 0.35;
    const ty = tu ? tu.y + 0.3 : tb!.y + 0.6;
    const dx = tx - ox;
    const dy = ty - oy;
    const dz = tz - oz;
    const d = Math.hypot(dx, dy, dz) || 1;
    sim.breaths.push({
      x: ox,
      y: oy,
      z: oz,
      vx: (dx / d) * DRAGON_BREATH_SPEED,
      vy: (dy / d) * DRAGON_BREATH_SPEED,
      vz: (dz / d) * DRAGON_BREATH_SPEED,
      team: u.team as Team,
      targetUnitId: tu ? tu.id : 0,
      targetBuildingId: tb ? tb.id : 0,
      tx,
      ty,
      tz,
      life: d / DRAGON_BREATH_SPEED + 0.5,
    });
    u.atkCd = UNIT_ATK_CD.dragon;
  }

  private tickBreaths(sim: Sim, dt: number): void {
    if (!sim.breaths.length) return;
    const keep: BreathShot[] = [];
    for (const p of sim.breaths) {
      const tu = p.targetUnitId ? sim.unitById(p.targetUnitId) : null;
      const tb = !tu && p.targetBuildingId ? sim.buildingById(p.targetBuildingId) : null;
      if (tu) {
        p.tx = tu.x;
        p.ty = tu.y + 0.3;
        p.tz = tu.z;
      } else if (tb) {
        p.tx = tb.x;
        p.ty = tb.y + 0.6;
        p.tz = tb.z;
      }
      p.life -= dt;
      const dx = p.tx - p.x;
      const dy = p.ty - p.y;
      const dz = p.tz - p.z;
      const d = Math.hypot(dx, dy, dz);
      if (d <= DRAGON_BREATH_SPEED * dt || p.life <= 0) {
        this.impact(sim, p);
        continue;
      }
      const step = DRAGON_BREATH_SPEED * dt;
      p.x += (dx / d) * step;
      p.y += (dy / d) * step;
      p.z += (dz / d) * step;
      p.vx = (dx / d) * DRAGON_BREATH_SPEED;
      p.vy = (dy / d) * DRAGON_BREATH_SPEED;
      p.vz = (dz / d) * DRAGON_BREATH_SPEED;
      keep.push(p);
    }
    sim.breaths = keep;
  }

  private impact(sim: Sim, p: BreathShot): void {
    sim.fires.push(new FirePatch(p.tx, p.tz, FIRE_PATCH_R, FIRE_PATCH_LIFE, FIRE_PATCH_DPS0, p.team));
    const tu = p.targetUnitId ? sim.unitById(p.targetUnitId) : null;
    if (tu && tu.hp > 0) {
      tu.hp -= FIRE_IMPACT_DMG;
      tu.fireT = Math.max(tu.fireT, 2.5);
      if (tu.hp <= 0 && tu.team === BLUE) sim.toast("一名子民被大龙烧死");
    }
    const tb = p.targetBuildingId ? sim.buildingById(p.targetBuildingId) : null;
    if (tb) applyBuildingDamage(sim, tb, FIRE_IMPACT_DMG);
  }

  // ---------------------------------------------------------------------------
  // 燃烧地块：持续燃烧一小会儿，伤害随剩余寿命线性衰减（不经过护甲）。
  // ---------------------------------------------------------------------------

  private tickFires(sim: Sim, dt: number): void {
    if (!sim.fires.length) return;
    const keep: FirePatch[] = [];
    for (const f of sim.fires) {
      f.life -= dt;
      if (f.life <= 0) continue;
      const dps = f.dps();
      for (const u of sim.units) {
        // 飞行单位不受地面火海波及；在驻者（厂内/屋内）由建筑本体承伤。
        if (u.hp <= 0 || u.team === f.team || u.isFlying() || u.homeId > 0) continue;
        if (dist2(u.x, u.z, f.x, f.z) > f.r * f.r) continue;
        u.hp -= dps * dt;
        u.fireT = Math.max(u.fireT, 0.5);
        if (u.hp <= 0 && u.team === BLUE) sim.toast("一名子民被烈焰吞噬");
      }
      const r2 = (f.r + 0.3) * (f.r + 0.3); // 对建筑判定放宽半格（贴边也烧）
      for (const b of sim.buildings) {
        if (b.hp <= 0 || b.team === f.team || b.kind === "rebirth") continue;
        if (dist2(b.x, b.z, f.x, f.z) > r2) continue;
        applyBuildingDamage(sim, b, dps * dt);
      }
      keep.push(f);
    }
    sim.fires = keep;
  }
}
