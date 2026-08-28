import {
  AGRO_LEASH,
  attackInterval,
  BLUE,
  Building,
  canConvert,
  clamp,
  dist2,
  isTribe,
  NEUTRAL,
  RED,
  Team,
  Unit,
  unitDamageToBuilding,
  unitHp,
  unitRange,
  UNIT_SIGHT,
  WORLD,
} from "../types";
import { applyBuildingDamage, applyUnitDamage } from "../damage";
import type { Sim } from "../sim";
import type { ISystem } from "./system";

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
        const range = unitRange(u.kind);
        if (u.atkCd <= 0 && dist2(u.x, u.z, tu.x, tu.z) <= range * range) {
          applyUnitDamage(tu, u.kind);
          u.atkCd = attackInterval(u.kind);
          if (tu.hp > 0) {
            this.retaliate(sim, tu, u);
          } else {
            u.atkId = 0;
          }
        }
        continue;
      }

      const b = sim.buildingById(u.atkId);
      if (!b) {
        u.atkId = 0;
        continue;
      }
      const reach = Math.max(b.padW, b.padD) * 0.5 + 0.95;
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
      const enemy: Team = p.team === BLUE ? RED : BLUE;
      for (const u of sim.units) {
        if (u.team !== enemy) continue;
        if (dist2(p.x, p.z, u.x, u.z) < 0.28) {
          u.hp -= p.dmg;
          if (p.knock > 0) this.pushUnit(sim, u, p.ox, p.oz, p.knock);
          p.life = 0;
          break;
        }
      }
      if (p.life > 0) {
        const b = sim.buildingAt(p.x, p.z);
        if (b && b.team === enemy) {
          b.hp -= p.dmg;
          p.life = 0;
        }
      }
    }
    sim.shots = sim.shots.filter((p) => p.life > 0);
  }
}
