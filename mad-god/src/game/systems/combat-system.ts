import {
  AGRO_LEASH,
  attackInterval,
  BLUE,
  Building,
  canConvert,
  clamp,
  dist2,
  FIRE_CRIT_CHANCE,
  FIRE_DOWN_TIME,
  FIRE_KNOCK_DIST,
  FIREBALL_SPEED,
  isTribe,
  NEUTRAL,
  Projectile,
  RED,
  Team,
  Unit,
  unitAttack,
  unitDamageToBuilding,
  unitHp,
  unitRange,
  UNIT_SIGHT,
  WARRIOR_CRIT_CHANCE,
  WARRIOR_CRIT_KNOCK_MAX,
  WARRIOR_CRIT_KNOCK_MIN,
  WORLD,
} from "../types";
import { applyBuildingDamage, applyUnitDamage } from "../damage";
import type { Sim } from "../sim";
import type { ISystem } from "./system";
import { logger } from "../logger";

export class CombatSystem implements ISystem {
  update(sim: Sim, dt: number): void {
    this.combat(sim, dt);
    this.projectiles(sim, dt);
  }

  hurtBuilding(sim: Sim, b: Building, dmg: number): void {
    applyBuildingDamage(sim, b, dmg);
  }

  combat(sim: Sim, dt: number): void {
    for (const u of sim.units) {
      if (!isTribe(u.team) || u.hp <= 0 || u.homeId > 0) continue;
      if (u.atkCd > 0) u.atkCd = Math.max(0, u.atkCd - dt);
      // v0.9 腾空中的单位不能出刀（冷却照常走）；v0.12 倒地单位同样不能行动。
      if (u.flyVy !== 0 || u.y > sim.world.heightAt(u.x, u.z) + 0.08 || u.downT > 0) continue;
      if (!u.atkId) continue;
      // v0.8 自动索敌拴绳：agroX = -1 表示玩家手动指令，不受拴绳限制。
      if (u.agroX >= 0 && dist2(u.x, u.z, u.agroX, u.agroZ) > AGRO_LEASH * AGRO_LEASH) {
        u.atkId = 0;
        u.agroX = -1;
        u.agroZ = -1;
        u.job = "idle";
        continue;
      }

      const tu = sim.unitById(u.atkId);
      if (tu) {
        // v0.9 被击飞腾空的目标近战/火球都打不到，攻击者原地等它落地。
        if (tu.flyVy !== 0 || tu.y > sim.world.heightAt(tu.x, tu.z) + 0.08) continue;
        const range = unitRange(u.kind);
        const d2 = dist2(u.x, u.z, tu.x, tu.z);
        // v0.9 火战士远程分派：射程内且视线通畅才发射火球；被地形遮挡视为未进射程，继续贴近。
        if (u.kind === "firewarrior") {
          if (u.atkCd <= 0 && d2 <= range * range && !sim.world.losBlocked(u.x, u.z, tu.x, tu.z)) {
            this.launchFireball(sim, u, tu.x, tu.z);
            u.atkCd = attackInterval(u.kind);
          }
          continue;
        }
        if (u.atkCd <= 0 && d2 <= range * range) {
          applyUnitDamage(tu, u.kind);
          // v0.12 武士暴击：50% 沿攻击方向击退 2~3 格，并追加伤害（合计 = 普通 ×2）；普攻无特效。
          if (u.kind === "warrior" && tu.hp > 0 && Math.random() < WARRIOR_CRIT_CHANCE) {
            applyUnitDamage(tu, u.kind);
            if (tu.hp > 0) {
              const knock =
                WARRIOR_CRIT_KNOCK_MIN + Math.random() * (WARRIOR_CRIT_KNOCK_MAX - WARRIOR_CRIT_KNOCK_MIN);
              this.pushUnit(sim, tu, u.x, u.z, knock);
            }
          }
          u.atkCd = attackInterval(u.kind);
          if (tu.hp <= 0) {
            u.atkId = 0;
          } else {
            this.retaliate(sim, tu, u);
          }
        }
        continue;
      }

      const b = sim.buildingById(u.atkId);
      if (!b) {
        u.atkId = 0;
        continue;
      }
      const edge = Math.max(b.padW, b.padD) * 0.5;
      // v0.9 火战士对建筑同样远程喷火（以 pad 边缘起算射程）。
      if (u.kind === "firewarrior") {
        const d = Math.hypot(b.x - u.x, b.z - u.z) - edge;
        if (u.atkCd <= 0 && d <= unitRange(u.kind) && !sim.world.losBlocked(u.x, u.z, b.x, b.z)) {
          this.launchFireball(sim, u, b.x, b.z);
          u.atkCd = attackInterval(u.kind);
        }
        continue;
      }
      const reach = edge + 0.95;
      if (u.atkCd > 0 || dist2(u.x, u.z, b.x, b.z) > reach * reach) continue;
      applyBuildingDamage(sim, b, unitDamageToBuilding(u.kind));
      u.atkCd = attackInterval(u.kind);
      if (b.hp <= 0) u.atkId = 0;
    }
  }

  preach(sim: Sim, u: Unit, dt: number): void {
    const reach2 = 1.25 * 1.25;
    let tgt: Unit | null = null;
    let bestD = reach2;
    const enemy: Team = u.team === BLUE ? RED : BLUE;
    for (const o of sim.units) {
      if (o.id === u.id) continue;
      const foe = o.team === enemy || o.team === NEUTRAL;
      if (!foe || !canConvert(o.kind)) continue;
      const d = dist2(u.x, u.z, o.x, o.z);
      if (d < bestD) {
        bestD = d;
        tgt = o;
      }
    }
    if (!tgt) {
      u.channel = 0;
      u.channelId = 0;
      return;
    }
    u.path = [];
    if (u.channelId !== tgt.id) {
      u.channel = 0;
      u.channelId = tgt.id;
    }
    u.channel += dt;
    if (u.channel < 1.35) return;
    u.channel = 0;
    u.channelId = 0;
    tgt.team = u.team;
    tgt.kind = "walker";
    tgt.str = Math.max(1, tgt.str);
    tgt.hp = tgt.maxHp = unitHp("walker", tgt.str);
    tgt.order = sim.teams[u.team as Team].order;
    tgt.path = [];
    tgt.pathI = 0;
    tgt.think = 0;
    tgt.channel = 0;
    tgt.channelId = 0;
    tgt.selected = false;
    tgt.disguise = null;
    tgt.carry = 0;
    tgt.job = "idle";
    tgt.targetId = 0;
    tgt.atkId = 0;
    tgt.trainKind = null;
    tgt.foundKind = null;
    sim.toast(u.team === BLUE ? "一名敌人皈依" : "一名子民被感化");
    // v0.15 感化直接换队、不经出生流程，是人口上涨的另一大来源——落日志可追溯。
    logger.info("combat", `皈依：单位#${tgt.id} → 队伍${u.team}`, {
      pop: sim.countPop(u.team as Team),
    });
  }

  nearestConvertible(sim: Sim, u: Unit): Unit | null {
    const enemy: Team = u.team === BLUE ? RED : BLUE;
    let best: Unit | null = null;
    let bestD = 1e9;
    for (const o of sim.units) {
      if (o.id === u.id) continue;
      if (!canConvert(o.kind)) continue;
      if (o.team !== enemy && o.team !== NEUTRAL) continue;
      let d = dist2(u.x, u.z, o.x, o.z);
      if (o.kind === "walker" || o.kind === "wildman") d *= 0.65;
      if (d < bestD) {
        bestD = d;
        best = o;
      }
    }
    return best;
  }

  pushUnit(sim: Sim, u: Unit, fromX: number, fromZ: number, dist: number): void {
    let dx = u.x - fromX;
    let dz = u.z - fromZ;
    const len = Math.hypot(dx, dz) || 1;
    dx /= len;
    dz /= len;
    const steps = 10;
    let x = u.x;
    let z = u.z;
    for (let i = 1; i <= steps; i++) {
      const tx = u.x + dx * dist * (i / steps);
      const tz = u.z + dz * dist * (i / steps);
      if (!sim.world.walkableAt(tx, tz)) break;
      x = tx;
      z = tz;
    }
    u.x = clamp(x, 0.3, WORLD - 0.3);
    u.z = clamp(z, 0.3, WORLD - 0.3);
    u.path = [];
    u.pathI = 0;
    u.think = 0.15;
  }

  closestEnemyUnit(sim: Sim, u: Unit, enemy: Team, range: number): Unit | null {
    let best: Unit | null = null;
    let bestD = range * range;
    for (const o of sim.units) {
      if (o.team !== enemy) continue;
      if (o.hp <= 0 || o.homeId > 0) continue;
      const d = dist2(u.x, u.z, o.x, o.z);
      if (d < bestD) {
        bestD = d;
        best = o;
      }
    }
    return best;
  }

  /**
   * v0.8 自动索敌：仅当单位无 atkId、自身存活且在屋内、未处于训练态、
   * 属于部落单位、是士兵（武士/传教士/火战士）、且索敌半径 > 0 时触发；
   找到最近敌人后写入 atkId 与 agroX/Z 锚点，再走既有 chaseAttack 追击。
   */
  acquireTarget(sim: Sim, u: Unit): void {
    if (u.atkId) return;
    if (u.hp <= 0 || u.homeId > 0) return;
    if (!isTribe(u.team)) return;
    if (u.job === "train") return;
    if (u.downT > 0 || u.flyVy !== 0) return; // v0.12 倒地/腾空不索敌
    if (!u.isSoldier()) return;
    const sight = UNIT_SIGHT[u.kind];
    if (sight <= 0) return;
    const enemy: Team = u.team === BLUE ? RED : BLUE;
    const foe = this.closestEnemyUnit(sim, u, enemy, sight);
    if (!foe) return;
    u.atkId = foe.id;
    u.agroX = u.x;
    u.agroZ = u.z;
    sim.chaseAttack(u);
  }

  /**
   * v0.8 受击还手：被玩家/AI 攻击且当前无目标时，把攻击者设为目标并写锚点，
   玩家/系统移动令（job === "move"）或训练态不打断。
   */
  retaliate(sim: Sim, target: Unit, src: Unit): void {
    if (target.atkId) return;
    if (target.hp <= 0 || target.homeId > 0) return;
    if (!isTribe(target.team)) return;
    if (src.team === target.team) return;
    if (target.job === "move" || target.job === "train") return;
    target.atkId = src.id;
    target.agroX = target.x;
    target.agroZ = target.z;
    sim.chaseAttack(target);
  }

  projectiles(sim: Sim, dt: number): void {
    for (const p of sim.shots) {
      p.x += p.vx * dt;
      p.z += p.vz * dt;
      p.life -= dt;
      // v0.9 飞行撞地：发射端 LOS 之外的双保险——中途地形抬过弹道线即熄灭（遮挡无法通过）。
      if (p.y < sim.world.heightAt(p.x, p.z) + 0.12) {
        p.life = 0;
        continue;
      }
      const enemy: Team = p.team === BLUE ? RED : BLUE;
      let hit = false;
      for (const u of sim.units) {
        if (u.team !== enemy || u.hp <= 0 || u.homeId > 0) continue;
        if (u.flyVy !== 0) continue; // 腾空中的单位不被水平火球命中
        if (dist2(p.x, p.z, u.x, u.z) < 0.28 && Math.abs(p.y - u.y) < 1.2) {
          this.fireballHit(sim, u, p);
          hit = true;
          break;
        }
      }
      if (!hit && p.life > 0) {
        const b = sim.buildingAt(p.x, p.z);
        if (b && b.team === enemy) {
          applyBuildingDamage(sim, b, unitDamageToBuilding("firewarrior"));
          p.life = 0;
        }
      }
    }
    sim.shots = sim.shots.filter((p) => p.life > 0);
  }

  /** v0.9 火球发射：平飞高度取两端地形较高者 +0.6（与 world.losBlocked 同一条基准线），弹速恒定。 */
  launchFireball(sim: Sim, u: Unit, tx: number, tz: number): void {
    const dx = tx - u.x;
    const dz = tz - u.z;
    const dist = Math.hypot(dx, dz) || 1;
    sim.shots.push({
      x: u.x,
      z: u.z,
      y: Math.max(sim.world.heightAt(u.x, u.z), sim.world.heightAt(tx, tz)) + 0.6,
      vx: (dx / dist) * FIREBALL_SPEED,
      vz: (dz / dist) * FIREBALL_SPEED,
      team: u.team as Team,
      dmg: unitAttack(u.kind),
      life: dist / FIREBALL_SPEED + 0.4,
      knock: 0,
      ox: u.x,
      oz: u.z,
    });
  }

  /**
   * v0.12 火球命中结算：
   * - 暴击（FIRE_CRIT_CHANCE）：照抄闪电参数真正打飞（沿弹道方向），落地直接死亡（flyKill）。
   * - 默认：随机方向击退半格并倒地，伤害延到站起瞬间（path-system 结算 downDmg）。
   */
  fireballHit(sim: Sim, u: Unit, p: Projectile): void {
    p.life = 0;
    if (Math.random() < FIRE_CRIT_CHANCE) {
      const len = Math.hypot(p.vx, p.vz) || 1;
      u.flyVx = (p.vx / len) * (4.4 + Math.random() * 0.6);
      u.flyVz = (p.vz / len) * (4.4 + Math.random() * 0.6);
      u.flyVy = 5.6;
      u.y = sim.world.heightAt(u.x, u.z) + 1.55;
      u.flyKill = true;
      u.flyDmg = 0;
      u.path = [];
      u.pathI = 0;
      return;
    }
    // 默认击退：随机方向半格（pushUnit 分段探测，撞墙截断），倒地 + 伤害延付。
    const ang = Math.random() * Math.PI * 2;
    this.pushUnit(sim, u, u.x - Math.cos(ang), u.z - Math.sin(ang), FIRE_KNOCK_DIST);
    u.downT = FIRE_DOWN_TIME;
    u.downDmg += unitAttack("firewarrior");
    u.path = [];
    u.pathI = 0;
  }
}
