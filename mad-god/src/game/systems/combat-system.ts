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
  PREACH_REACH,
  PREACH_TIME,
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
import { astar } from "../path";
import { PAD_STAND_INFLATE, padSupportRadius } from "../world";
import { applyBuildingDamage, applyUnitDamage } from "../damage";
import type { Sim } from "../sim";
import type { ISystem } from "./system";
import { logger } from "../logger";

export class CombatSystem implements ISystem {
  /** v0.23 高频索敌节流计时：每 0.25s 一轮全量扫描。 */
  private acquireAcc = 0;

  update(sim: Sim, dt: number): void {
    this.combat(sim, dt);
    this.projectiles(sim, dt);
  }

  /**
   * v0.23 索敌独立高频化（修"感觉没有自动攻击"的根源）：
   * acquireTarget 原来只挂在 repath 里，而单位走路时（path 非空 / job=move）不进 repath——
   * 索敌完全停摆。现在每 0.25s 对全部单位扫一轮：**任何状态、边走边锁**。
   * 豁免：玩家/系统移动令（job=move）与训练态仍优先（v0.8 语义——否则单位永远到不了目的地）。
   * 注意挂在 combat() 开头：sim.tick 走 sim.combat → 本方法，不走 update()。
   */
  private acquirePass(sim: Sim, dt: number): void {
    this.acquireAcc += dt;
    if (this.acquireAcc < 0.25) return;
    this.acquireAcc = 0;
    for (const u of sim.units) {
      if (u.job === "move" || u.job === "train") continue;
      this.acquireTarget(sim, u); // 内部自带 atkId/在屋/倒地/腾空/非士兵守卫
    }
  }

  hurtBuilding(sim: Sim, b: Building, dmg: number): void {
    applyBuildingDamage(sim, b, dmg);
  }

  combat(sim: Sim, dt: number): void {
    this.acquirePass(sim, dt); // v0.23 任何状态的高频索敌
    for (const u of sim.units) {
      if (!isTribe(u.team) || u.hp <= 0 || u.homeId > 0) continue;
      if (u.atkCd > 0) u.atkCd = Math.max(0, u.atkCd - dt);
      // v0.9 腾空中的单位不能出刀（冷却照常走）；v0.12 倒地单位同样不能行动。
      if (u.flyVy !== 0 || u.y > sim.world.heightAt(u.x, u.z) + 0.08 || u.downT > 0) continue;
      // v0.16 感化接线：传教士优先传教（站桩，不打断玩家指令），传教中跳过攻击逻辑。
      if (this.autoPreach(sim, u, dt)) continue;
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
      // v0.24 拆屋射程的几何修正：地基是**旋转矩形**，中心到边缘的距离随接近方向在
      // half(1.30) ~ half·√2(1.84) 之间变，旧写法一律按 max(padW,padD)*0.5 当圆半径，
      // 于是"武士能不能拆这座屋"取决于它从哪个方向走过来：padEdge 让它站在
      // 边界外 0.62 处（斜角折合 2.2~2.7 格），而 reach 恒等于 1.3+0.95=2.25，
      // 实测斜角站位 2.28 就永远差 0.03 格砍不到。现在按当前方向取真实支撑半径，
      // 并把 padEdge 的站位外扩一并计入，指令与射程判定同一套几何、恒自洽。
      const pad = { x: b.x, z: b.z, w: b.padW, d: b.padD, yaw: b.yaw };
      const edge = padSupportRadius(pad, u.x, u.z);
      // v0.9 火战士对建筑同样远程喷火（以 pad 边缘起算射程）。
      if (u.kind === "firewarrior") {
        const d = Math.hypot(b.x - u.x, b.z - u.z) - edge;
        if (u.atkCd <= 0 && d <= unitRange(u.kind) && !sim.world.losBlocked(u.x, u.z, b.x, b.z)) {
          this.launchFireball(sim, u, b.x, b.z);
          u.atkCd = attackInterval(u.kind);
        }
        continue;
      }
      const reach = edge + PAD_STAND_INFLATE + unitRange(u.kind);
      if (u.atkCd > 0 || dist2(u.x, u.z, b.x, b.z) > reach * reach) continue;
      applyBuildingDamage(sim, b, unitDamageToBuilding(u.kind));
      u.atkCd = attackInterval(u.kind);
      if (b.hp <= 0) u.atkId = 0;
    }
  }

  preach(sim: Sim, u: Unit, dt: number): boolean {
    const reach2 = PREACH_REACH * PREACH_REACH;
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
      return false;
    }
    u.path = [];
    if (u.channelId !== tgt.id) {
      u.channel = 0;
      u.channelId = tgt.id;
    }
    u.channel += dt;
    if (u.channel < PREACH_TIME) return true;
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
    return true;
  }

  /**
   * v0.16 感化接线：传教士身边出现可感化目标（PREACH_REACH 内的野人/敌方单位）时
   * 站桩引导转化——感化优先于攻击，但不打断玩家移动/训练指令，也不追击。
   * 返回 true 表示本帧在传教，调用方跳过攻击逻辑。
   */
  autoPreach(sim: Sim, u: Unit, dt: number): boolean {
    if (u.kind !== "preacher") return false;
    if (u.hp <= 0 || u.homeId > 0) return false;
    if (u.job === "move" || u.job === "train") return false;
    if (u.downT > 0 || u.flyVy !== 0) return false;
    if (!this.preach(sim, u, dt)) return false;
    if (u.atkId) u.atkId = 0; // 放下武器转而传教
    u.path = [];
    u.pathI = 0;
    return true;
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
   * 找到最近敌人后写入 atkId 与 agroX/Z 锚点，再走既有 chaseAttack 追击。
   * v0.19 扩展：牛头人（firewarrior）在索敌圈内无敌方单位时自动锁定最近敌方建筑（远程单位天然拆家）；
   * 索敌命中会打断守卫舞（order: guard → fight，被打断的单位战后不自动回篝火）。
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
    // v0.19 牛头人自动拆家：圈内无敌方单位 → 锁定最近的敌方建筑（走既有对建筑喷火分支）。
    let target: { id: number; x: number; z: number } | null = foe;
    if (!target && u.kind === "firewarrior") {
      let bestD = sight * sight;
      for (const b of sim.buildings) {
        if (b.team !== enemy || b.hp <= 0 || b.kind === "rebirth") continue;
        const d = dist2(u.x, u.z, b.x, b.z);
        if (d < bestD) {
          bestD = d;
          target = b;
        }
      }
    }
    if (!target) return;
    // v0.19 守卫打断：篝火舞者被索敌拉走后转为 fight，战后不自动回圈（需玩家重新下令）。
    if (u.order === "guard") u.order = "fight";
    u.atkId = target.id;
    u.agroX = u.x;
    u.agroZ = u.z;
    sim.chaseAttack(u);
  }

  /**
   * v0.8 受击还手：被玩家/AI 攻击且当前无目标时，把攻击者设为目标并写锚点，
   玩家/系统移动令（job === "move"）或训练态不打断。
   v0.17 还手补洞：src 放宽为 Pick<Unit, "team" | "id">——近战调用点传完整单位照旧；
   远程（火球/法术）传幽灵源头 {team, id: -1}，id 无效则 chaseAttack 立即清空 atkId，
   仇恨锚点（agroX/Z）由后续自动索敌/远程死角冲锋接管。
   */
  retaliate(sim: Sim, target: Unit, src: Pick<Unit, "team" | "id">): void {
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
   * v0.17 还手补洞：两种分支（被击飞/被击倒）都落到尾部结算——存活的部落受害者立即还手、
   * 超视距无目标则朝发射点冲锋，并上报 onTeamHurt 供 AI 防御响应。
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
    } else {
      // 默认击退：随机方向半格（pushUnit 分段探测，撞墙截断），倒地 + 伤害延付。
      const ang = Math.random() * Math.PI * 2;
      this.pushUnit(sim, u, u.x - Math.cos(ang), u.z - Math.sin(ang), FIRE_KNOCK_DIST);
      u.downT = FIRE_DOWN_TIME;
      u.downDmg += unitAttack("firewarrior");
      u.path = [];
      u.pathI = 0;
    }
    // v0.17 还手补洞：被击者只要还活着（含被击飞/被击倒分支）就——
    // ① 立即还手：源头为幽灵 {team, id: -1}（射手可能已阵亡/已移动，不锁具体单位，atkId 被
    //    chaseAttack 清空后由自动索敌接管）；② 超视距又无目标：沿 astar 朝发射点 (p.ox,p.oz)
    //    冲锋（写 path/pathI/think，thinkUnits 见 path 即放行，不打断玩家移动/训练令）；
    // ③ 上报 onTeamHurt 供 AI 防御响应。野人（NEUTRAL）不触发。
    if (u.hp > 0 && isTribe(u.team)) {
      this.retaliate(sim, u, { team: p.team as Team, id: -1 });
      if (
        dist2(u.x, u.z, p.ox, p.oz) > UNIT_SIGHT[u.kind] * UNIT_SIGHT[u.kind] &&
        u.atkId === 0 &&
        u.job !== "move" &&
        u.job !== "train"
      ) {
        u.path = astar(sim.world, u.x, u.z, p.ox, p.oz);
        u.pathI = 0;
        u.think = 1.5;
      }
      sim.onTeamHurt?.(u.team as Team, u.x, u.z);
    }
  }
}
