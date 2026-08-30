import {
  acquireRole,
  agroLeash,
  attackInterval,
  TOWER_RANGE_MULT,
  TOWER_SIGHT_MULT,
  TOWER_TOP,
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
      if (u.job === "train") continue;
      // v0.28 锁敌刷新（只对"跟随"角色）：自动锁的目标超出攻击距离就重新追击——
      // "锁了就追，直到目标逃出牵引范围"。站桩角色（牛头人）永不刷新路径。
      // 旧实现只靠一次性 chaseAttack——路径走完/目标移开后单位拿着过期 atkId 原地发呆，
      // 也不重新索敌（acquireTarget 对已有 atkId 直接 return），这正是"感觉没有自动攻击"的根源。
      if (u.atkId && u.agroX >= 0 && acquireRole(u.kind) === "follow" && UNIT_SIGHT[u.kind] > 0) {
        this.refreshChase(sim, u);
        continue;
      }
      if (u.job === "move") continue; // 玩家移动令优先，不被索敌抢走（v0.8 语义）
      this.acquireTarget(sim, u); // 内部自带 atkId/在屋/倒地/腾空守卫
    }
  }

  /**
   * v0.27-2 自动锁追击刷新：目标活着且未进攻击距离 → 重新 chaseAttack。
   * think/path 节流（chaseAttack 自置 think=0.55s）避免每个索敌轮全量重算 A*。
   */
  private refreshChase(sim: Sim, u: Unit): void {
    if (u.path.length && u.think > 0) return;
    const tu = sim.unitById(u.atkId);
    if (tu) {
      const reach = unitRange(u.kind);
      if (dist2(u.x, u.z, tu.x, tu.z) <= reach * reach) return; // 已进刀距，交给 combat 出刀
      sim.chaseAttack(u);
      return;
    }
    const b = sim.buildingById(u.atkId);
    if (!b) return; // 目标没了：combat 主循环负责清 atkId
    const edge = padSupportRadius({ x: b.x, z: b.z, w: b.padW, d: b.padD, yaw: b.yaw }, u.x, u.z);
    const d = Math.hypot(b.x - u.x, b.z - u.z) - edge;
    if (d > PAD_STAND_INFLATE + unitRange(u.kind) - 0.2) sim.chaseAttack(u);
  }

  /** v0.27-2 清自动锁：目标死亡/放弃时连带停步，不再走向陈旧目的地（手动指令不走此出口）。 */
  private clearAutoLock(u: Unit): void {
    u.atkId = 0;
    if (u.agroX >= 0) {
      u.job = "idle";
      u.path = [];
      u.pathI = 0;
      u.agroX = -1;
      u.agroZ = -1;
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

      const tu = sim.unitById(u.atkId);
      if (tu) {
        // v0.28 跟随索敌的牵引：目标（而非锚点）逃出追击者锁敌圈 +2 才放手——
        // "必须一直跟着他"；只要贴得住就无限追，绝不被出发点距离掐断。
        // 手动指令（agroX=-1）不受牵引限制；站桩角色不移动，同样按此清理射程外死锁。
        const leash = agroLeash(u.kind);
        if (u.agroX >= 0 && leash > 0 && dist2(u.x, u.z, tu.x, tu.z) > leash * leash) {
          this.clearAutoLock(u);
          continue;
        }
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
            this.clearAutoLock(u);
          } else {
            this.retaliate(sim, tu, u);
          }
        }
        continue;
      }

      const b = sim.buildingById(u.atkId);
      if (!b) {
        this.clearAutoLock(u);
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
      if (b.hp <= 0) this.clearAutoLock(u);
    }
    this.towerCombat(sim, dt); // v0.27-3 哨塔驻军射击（主循环跳过 homeId>0，塔走独立通道）
  }

  /**
   * v0.27-3 哨塔驻军射击：塔上牛战士是固定炮台——
   * - 索敌：2× 视野（12→24）内最近敌方单位；无敌方单位时锁最近敌方建筑（沿 v0.19 语义）；
   * - 开火：目标进 2× 射程（4.5→9）从塔顶 (b.x, b.z, b.y+TOWER_TOP) 发射；
   *   塔上不做 losBlocked 预判——弹体自带撞地熄灭，从高处平飞天然被山体遮挡，物理自洽；
   * - 不参与 leash/追击/refreshChase（塔不会动）；目标扫描 0.2s 节流，冷却逐帧递减。
   */
  private towerAcc = 0;
  private towerCombat(sim: Sim, dt: number): void {
    this.towerAcc += dt;
    const scan = this.towerAcc >= 0.2;
    if (scan) this.towerAcc = 0;
    for (const b of sim.buildings) {
      if (b.kind !== "tower" || b.hp <= 0 || b.level < 1) continue;
      const g = sim.units.find((u) => u.homeId === b.id && u.kind === "firewarrior" && u.hp > 0);
      if (!g) continue;
      if (g.atkCd > 0) g.atkCd = Math.max(0, g.atkCd - dt);
      if (scan) {
        const enemy: Team = g.team === BLUE ? RED : BLUE;
        const sight = UNIT_SIGHT.firewarrior * TOWER_SIGHT_MULT;
        const range = unitRange("firewarrior") * TOWER_RANGE_MULT;
        let best: Unit | null = null;
        let bestD = sight * sight;
        for (const o of sim.units) {
          if (o.team !== enemy || o.hp <= 0 || o.homeId > 0) continue;
          const d = dist2(b.x, b.z, o.x, o.z);
          if (d < bestD) {
            bestD = d;
            best = o;
          }
        }
        if (best) {
          g.atkId = best.id;
        } else {
          // 圈内无敌方单位 → 锁最近敌方建筑（firewarrior 天然拆家，沿 v0.19 语义）。
          let bb: Building | null = null;
          let bd = sight * sight;
          for (const t of sim.buildings) {
            if (t.team !== enemy || t.hp <= 0 || t.kind === "rebirth") continue;
            const d = dist2(b.x, b.z, t.x, t.z);
            if (d < bd) {
              bd = d;
              bb = t;
            }
          }
          g.atkId = bb ? bb.id : 0;
        }
      }
      // 开火判定（逐帧，用当前 atkId）。
      const tu = sim.unitById(g.atkId);
      if (tu) {
        const range = unitRange("firewarrior") * TOWER_RANGE_MULT;
        const d2 = dist2(b.x, b.z, tu.x, tu.z);
        if (g.atkCd <= 0 && d2 <= range * range) {
          this.launchFireball(sim, g, tu.x, tu.z, { x: b.x, z: b.z, y: b.y + TOWER_TOP });
          g.atkCd = attackInterval(g.kind);
        }
        continue;
      }
      const tb = sim.buildingById(g.atkId);
      if (tb) {
        const edge = padSupportRadius({ x: tb.x, z: tb.z, w: tb.padW, d: tb.padD, yaw: tb.yaw }, b.x, b.z);
        const d = Math.hypot(tb.x - b.x, tb.z - b.z) - edge;
        if (g.atkCd <= 0 && d <= unitRange("firewarrior") * TOWER_RANGE_MULT) {
          this.launchFireball(sim, g, tb.x, tb.z, { x: b.x, z: b.z, y: b.y + TOWER_TOP });
          g.atkCd = attackInterval(g.kind);
        }
      } else {
        g.atkId = 0;
      }
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
    // v0.26 换队逻辑统一走 sim.convertTo（感化与转化法术共用一个出口）。
    sim.convertTo(tgt, u.team as Team, "preach");
    sim.toast(u.team === BLUE ? "一名敌人皈依" : "一名子民被感化");
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

  /** v0.27g 火战士专用：射程内且视线通畅的最近敌人（打得着的才优先锁）。 */
  closestShootableEnemy(sim: Sim, u: Unit, enemy: Team): Unit | null {
    const range = unitRange(u.kind);
    let best: Unit | null = null;
    let bestD = range * range;
    for (const o of sim.units) {
      if (o.team !== enemy || o.hp <= 0 || o.homeId > 0) continue;
      const d = dist2(u.x, u.z, o.x, o.z);
      if (d >= bestD) continue;
      if (sim.world.losBlocked(u.x, u.z, o.x, o.z)) continue;
      bestD = d;
      best = o;
    }
    return best;
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
    if (u.atkId) {
      // v0.28 站桩角色（牛头人/未来法师）的锁不"粘"：自动锁每轮重选最近目标——
      // 它不追击，换锁无副作用，还能避免"锁着一个射程外的远目标，放着进射程的近目标不管"。
      // 手动锁（agroX=-1）与跟随角色照旧（近战追击由 refreshChase 维持）。
      if (acquireRole(u.kind) !== "hold" || u.agroX < 0) return;
      u.atkId = 0;
      u.agroX = -1;
      u.agroZ = -1;
    }
    if (u.hp <= 0 || u.homeId > 0) return;
    if (!isTribe(u.team)) return;
    if (u.job === "train") return;
    if (u.downT > 0 || u.flyVy !== 0) return; // v0.12 倒地/腾空不索敌
    // v0.28 索敌资格 = 有锁敌视野（大祭司/间谍不再被 isSoldier 挡在门外；村民视野 0 依旧只还手）。
    const sight = UNIT_SIGHT[u.kind];
    if (sight <= 0) return;
    const enemy: Team = u.team === BLUE ? RED : BLUE;
    let foe = this.closestEnemyUnit(sim, u, enemy, sight);
    // v0.27g 火战士优先锁"射程内且视线通畅"的目标：起伏地形上最近的敌人可能被山体
    // 遮挡（站桩不追击就永远打不到），优先挑真正打得着的，没有再退回视野内最近者。
    if (u.kind === "firewarrior" && foe) {
      const shootable = this.closestShootableEnemy(sim, u, enemy);
      if (shootable) foe = shootable;
    }
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
    // v0.28 站桩角色自动锁敌后不移动、不追击，原地开火等目标进射程；
    // 手动攻击令仍走 sim.chaseAttack 的"拉近到射程沿 → rangedHold 站定开火"。
    if (acquireRole(u.kind) === "follow") sim.chaseAttack(u);
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
      if (p.vy) p.y += p.vy * dt; // v0.27-3 塔顶俯冲弹道（地面平射 vy 恒 0）
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

  /**
   * v0.9 火球发射：平飞高度取两端地形较高者 +0.6（与 world.losBlocked 同一条基准线），弹速恒定。
   * v0.27-3 origin：哨塔驻军从塔顶发射（起点/高度/弹道寿命都按塔顶算），地面单位不传。
   */
  launchFireball(
    sim: Sim,
    u: Unit,
    tx: number,
    tz: number,
    origin?: { x: number; z: number; y: number },
  ): void {
    const ox = origin?.x ?? u.x;
    const oz = origin?.z ?? u.z;
    const oy = origin?.y ?? Math.max(sim.world.heightAt(ox, oz), sim.world.heightAt(tx, tz)) + 0.6;
    const dx = tx - ox;
    const dz = tz - oz;
    const dist = Math.hypot(dx, dz) || 1;
    // v0.27-3 塔顶发射：弹道从塔顶匀速俯冲到目标脚下 +0.6（与地面弹同一命中高度），
    // 否则平飞 2.75 高度永远够不到命中判据的 |Δy|<1.2。地面发射 vy 不填（平飞）。
    const flight = dist / FIREBALL_SPEED + 0.4;
    let vy: number | undefined;
    if (origin) {
      const ty = sim.world.heightAt(tx, tz) + 0.6;
      vy = (ty - oy) / (dist / FIREBALL_SPEED);
    }
    sim.shots.push({
      x: ox,
      z: oz,
      y: oy,
      vy,
      vx: (dx / dist) * FIREBALL_SPEED,
      vz: (dz / dist) * FIREBALL_SPEED,
      team: u.team as Team,
      dmg: unitAttack(u.kind),
      life: flight,
      knock: 0,
      ox,
      oz,
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
      // v0.28a 每发必击退：沿弹道方向（= 来弹去向，远离射手）推一步（pushUnit 分段探测，
      // 撞墙截断），短暂倒地 + 伤害延付。不再是"随机方向半格"，暴击的大击飞照旧。
      const len = Math.hypot(p.vx, p.vz) || 1;
      this.pushUnit(sim, u, u.x - p.vx / len, u.z - p.vz / len, FIRE_KNOCK_DIST);
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
