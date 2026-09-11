import {
  BLUE,
  BOAT_BUILD_T,
  BOAT_FLOAT_Y,
  BOATHOUSE_DECK_Y,
  BOATHOUSE_DWELL,
  BOATHOUSE_FLEET_CAP,
  clamp,
  houseBaseRate,
  BUILD_RATE_BASE,
  DRAGON_GARRISON_MAX,
  HOUSE_ROOF_Y,
  POP_CAP,
  LAUNCH_RANGE,
  sitePad,
  TOWER_CLIMB_T,
  TOWER_DECK_Y,
  houseHp,
  houseMaxPop,
  HOUSE_DWELL_BONUS,
  isCampKind,
  isTribe,
  padSize,
  SKILL_CHARGE,
  chargePopMult,
  Team,
  Tool,
  Unit,
  Building,
  WATER,
  woodNeedFor,
} from "../types";
import type { Sim } from "../sim";
import type { ISystem } from "./system";
import type { Boathouse } from "../entities/buildings/boathouse";
import { waterAt } from "../path";
import { LogLevel, logger } from "../logger";

/** v0.38 工地看门狗节拍（秒）与名额：节拍越短越灵敏，但每拍要扫一遍工地与村民。 */
const SITE_WATCHDOG_SEC = 2;
const SITE_WATCHDOG_CREW = 2;
const SITE_WATCHDOG_MIN_IDLE = 2;

export class ProductionSystem implements ISystem {
  /** v0.38 工地看门狗上次执行时刻（游戏内秒） */
  private lastSiteWatchdog = -1e9;

  update(sim: Sim, dt: number): void {
    this.tickTrees(sim, dt);
    this.refreshHouses(sim);
    sim.markHouseBlocks();
    this.regenCharges(sim, dt);
    this.produce(sim, dt);
    this.arrangeDwellers(sim);
  }

  /** 供 sim.tick 调用的渐进式建造入口。 */
  constructionTick(sim: Sim, dt: number): void {
    this.tickConstruction(sim, dt);
  }

  /**
   * v0.27h 住户"上房"：每座茅屋的住户在屋顶排一圈小站位（r=0.55、按序错角），
   * 屋顶高度 HOUSE_ROOF_Y[level]。目的有二：① 屋里住了几个人一眼可见；
   * ② 玩家能直接点选屋顶上的具体村民、右键拉他出来（进出对等的驻扎机制）。
   * 仍在进屋动画（enterT>0）的不动；单位坐标在屋内地基上，不影响寻路/生产。
   */
  arrangeDwellers(sim: Sim): void {
    for (const b of sim.buildings) {
      if (b.hp <= 0 || b.level < 1) continue;
      if (b.kind === "hut") {
        const lv = b.level >= 3 ? 3 : b.level;
        let i = 0;
        for (const u of sim.units) {
          if (u.homeId !== b.id || u.enterT > 0) continue;
          const ang = i * 2.4; // 黄金角错开，人数增减不整体重排
          const p = sim.padLocalToWorld(b, Math.cos(ang) * 0.38, Math.sin(ang) * 0.38); // v0.28c 屋顶缩半→站位环 0.55→0.38
          u.x = p.x;
          u.z = p.z;
          u.y = b.y + HOUSE_ROOF_Y[lv]!;
          i++;
        }
      } else if (b.kind === "boathouse") {
        // v0.32 船屋住户站工作甲板（仿哨塔瞭望台站位，住满 10 人一眼可见）。
        let i = 0;
        for (const u of sim.units) {
          if (u.homeId !== b.id || u.enterT > 0) continue;
          const ang = i * 2.4;
          const p = sim.padLocalToWorld(b, Math.cos(ang) * 0.8, Math.sin(ang) * 0.8);
          u.x = p.x;
          u.z = p.z;
          u.y = b.y + BOATHOUSE_DECK_Y;
          i++;
        }
      } else if (b.kind === "tower") {
        // v0.28e 塔顶驻军站位（爬塔动画 enterT 期间由 tickEnter 接管，不在此覆盖）。
        const garrison = sim.towerGarrison(b);
        for (let i = 0; i < garrison.length; i++) {
          const g = garrison[i]!;
          if (g.enterT > 0) continue;
          const slot = sim.towerSlotPos(b, i);
          g.x = slot.x;
          g.z = slot.z;
          g.y = b.y + TOWER_DECK_Y;
        }
      }
    }
  }

  tickTrees(sim: Sim, dt: number): void {
    for (const t of sim.trees) {
      if (t.alive) continue;
      t.regen -= dt;
      if (t.regen > 0) continue;
      if (sim.world.heightAt(t.x, t.z) <= WATER) {
        t.regen = 4;
        continue;
      }
      t.alive = true;
      t.regen = 0;
      t.y = sim.world.heightAt(t.x, t.z);
    }
  }

  refreshHouses(sim: Sim): void {
    for (const b of sim.buildings) {
      if (sim.world.heightAt(b.x, b.z) <= WATER) {
        b.hp = 0;
        continue;
      }
      if (b.shell || sim.lavaOnPad(b)) continue;
      if (b.kind === "hut") {
        if (sim.world.houseLevelAt(b.x, b.z, b.yaw) === 0) b.hp = 0;
      } else if (isCampKind(b.kind) || b.kind === "tower" || b.kind === "dragonFactory" || b.kind === "boathouse") {
        // v0.27-3 哨塔与营地同款地基校验（塔更小，同样不能悬空/泡水）；v0.30 大龙训练营同规。
        const s = sim.world.padStats(b.x, b.z, b.padW, b.padD, b.yaw);
        if (s.n === 0 || s.land < 0.55 || s.mean <= WATER) b.hp = 0;
      }
    }
  }

  /**
   * v0.26 充能恢复（替代旧 regenMana）：
   * - `manaCap` 仍由房子+人口增长，但只当"神迹解锁进度"（canUnlock 用），不再是资源。
   * - 每个技能槽独立充能：离散槽攒颗（fill 满 recharge 秒 +1 颗，封顶 max）；
   *   连续槽（雕刻）cur 向 max 匀速回满。
   */
  regenCharges(sim: Sim, dt: number): void {
    for (const team of [BLUE, 1] as Team[]) {
      const t = sim.teams[team];
      let cap = 80;
      for (const b of sim.buildings) {
        if (b.team !== team || b.kind !== "hut" || b.level < 1) continue;
        cap += b.level * 18;
      }
      const pop = sim.countPop(team);
      cap += Math.min(80, pop * 2);
      t.manaCap = cap;
      // v0.26d 人口越多充能越快（<50 ×1.0，≥50 ×1.3，≥100 ×1.6，≥150 ×1.9，≥200 ×2.3…）。
      // v0.27-1 队伍系数（敌方削弱 Wrapper）：红方充能整体 ×0.75。
      const mult = chargePopMult(pop) * sim.rates.of(team).charge;
      for (const tool of Object.keys(SKILL_CHARGE) as Tool[]) {
        const c = sim.chargeState(team, tool);
        if (c.continuous) {
          if (c.cur < c.max) c.cur = Math.min(c.max, c.cur + (c.max / c.recharge) * dt * mult);
        } else if (c.cur < c.max) {
          c.fill += dt * mult;
          while (c.fill >= c.recharge) {
            c.fill -= c.recharge;
            c.cur = Math.min(c.max, c.cur + 1);
          }
        }
      }
    }
  }

  /**
   * v0.38 工地看门狗（仅玩家方）：工地还在等木料、却一个建工都没有时，从空闲村民里自动召 2 人。
   *
   * 为何需要它（"房子死活建造不起来"的系统性原因）：工地的建造动力完全挂在村民的 `buildId` 上——
   * 一旦全部建工战死 / 被玩家右键调走 / 建房时选中里根本不是村民，就**没有任何机制**再把工地接上，
   * 工地变成永久僵尸（玩家只看到一个停在半路的房子）。红方 AI 没这问题（村民本来就会自己认领工地），
   * 所以本看门狗只服务玩家：这不是替玩家做主，而是继续执行玩家自己下的建造令。
   *
   * 三条自限：① 只在建工数为 0 时行动（不抢玩家正在用的建工）；
   * ② 至少留 SITE_WATCHDOG_MIN_IDLE 名空闲村民才召（只剩一名劳力时不抽干）；
   * ③ 只召同岛、无任务、且没有战斗诏令的村民。
   */
  private watchdogSites(sim: Sim): void {
    if (sim.time - this.lastSiteWatchdog < SITE_WATCHDOG_SEC) return;
    this.lastSiteWatchdog = sim.time;
    for (const b of sim.buildings) {
      if (b.team !== BLUE || b.level !== 0 || !this.needsWood(b)) continue;
      const crew = sim.units.filter((u) => u.buildId === b.id && u.hp > 0 && u.homeId === 0);
      if (crew.length) continue; // 已有建工（含在途）→ 不动
      const isle = sim.world.islandAt(b.x, b.z);
      const idle = sim.units.filter(
        (u) =>
          u.team === BLUE &&
          u.kind === "walker" &&
          u.hp > 0 &&
          u.homeId === 0 &&
          u.carry === 0 &&
          u.targetId === 0 &&
          u.foundKind === null &&
          u.order === "settle" &&
          u.job !== "train" &&
          u.job !== "haul" &&
          u.job !== "chop" &&
          !sim.inSwamp(u) &&
          (isle < 0 || sim.world.islandAt(u.x, u.z) === isle),
      );
      if (idle.length < SITE_WATCHDOG_MIN_IDLE) continue;
      idle.sort((a, c) => (a.x - b.x) ** 2 + (a.z - b.z) ** 2 - ((c.x - b.x) ** 2 + (c.z - b.z) ** 2));
      const picked = idle.slice(0, SITE_WATCHDOG_CREW);
      for (const u of picked) {
        const edge = sim.padEdge(b.x, b.z, b.padW, b.padD, b.yaw, u.x, u.z);
        sim.sendMove(u, edge.x, edge.z);
        u.targetId = b.id;
        u.buildId = b.id;
        u.atkId = 0;
      }
      logger.info("produce", `工地#${b.id} 无建工，自动召集 ${picked.length} 名村民前来搭建`, {
        team: BLUE,
        x: +b.x.toFixed(1),
        z: +b.z.toFixed(1),
        idle: idle.length,
        crew: picked.map((u) => u.id),
      });
      sim.toast(`工地自动召集 ${picked.length} 名村民前来搭建`);
    }
  }

  produce(sim: Sim, dt: number): void {
    if (sim.freezeProd) {
      logger.throttled("produce:frozen", 2000, LogLevel.Warn, "produce", "freezeProd=true，生产被冻结（shot 导演占用）");
      return;
    }
    this.watchdogSites(sim);
    for (const b of sim.buildings) {
      if (b.hp <= 0 || b.kind !== "hut" || b.level < 1) continue;
      if (b.wantLevel > b.level) {
        if (b.level === 1) this.upgradeBuilding(sim, b, 2);
        else if (b.level === 2) this.upgradeBuilding(sim, b, 3);
        b.wantLevel = 0;
      }
      // v0.14 每座茅屋每秒一条快照：等级/入住/进度，生产卡死一眼可见。
      // v0.15 卡住原因只剩 no-dwell（全局人口上限已移除）。
      logger.periodic(`hut:${b.id}`, 1000, LogLevel.Debug, "produce", `茅屋#${b.id} L${b.level}`, () => ({
        team: b.team,
        dwell: `${b.dwell}/${houseMaxPop(b.level)}`,
        prod: +b.prod.toFixed(3),
        born: b.born,
        blocked: b.dwell <= 0 ? "no-dwell" : undefined,
      }));
      if (b.dwell <= 0) continue;
      // v0.11 速率 = 基础(等级) × (1 + 0.12 × (dwell − 1))：进驻村民越多生产越快。
      // v0.11c 新生儿走出屋子成为自由村民；v0.15 出生不再受全局人口上限约束（无限生产）。
      // v0.27-1 队伍系数（敌方削弱 Wrapper）：同配置红方 = 蓝方 ×0.75。
      const rate = houseBaseRate(b.level) * (1 + HOUSE_DWELL_BONUS * (b.dwell - 1)) * sim.rates.of(b.team).prod;
      b.prod += rate * dt;
      if (b.prod >= 1) {
        // v0.28h 分队人口上限：满员只是**暂停**（进度保留），人口一降立即恢复出生。
        if (sim.countPop(b.team) >= POP_CAP[b.team]) {
          logger.throttled(
            `cap:${b.id}`,
            2000,
            LogLevel.Warn,
            "produce",
            `茅屋#${b.id} 满员待产（进度保留）`,
            { team: b.team, pop: sim.countPop(b.team), cap: POP_CAP[b.team] },
          );
          continue;
        }
        const spot = sim.hutDoor(b);
        if (!sim.world.walkableAt(spot.x, spot.z)) {
          logger.throttled(`door:${b.id}`, 2000, LogLevel.Warn, "produce", `茅屋#${b.id} 门口不可走`, {
            x: +spot.x.toFixed(1),
            z: +spot.z.toFixed(1),
          });
          const fallback = sim.spawnNear(b);
          if (!fallback) {
            logger.throttled(`spawn:${b.id}`, 2000, LogLevel.Warn, "produce", `茅屋#${b.id} 找不到出生点，进度卡住`, {
              prod: +b.prod.toFixed(2),
            });
            continue;
          }
          spot.x = fallback.x;
          spot.z = fallback.z;
        }
        b.prod = 0;
        b.born += 1;
        // v0.11c 新生儿走出屋子成为自由村民（v0.11b 的"出生即占位"会锁死经济，已回退）。
        const baby = sim.addUnit(b.team, "walker", spot.x, spot.z);
        baby.homeId = 0;
        // v0.17 出生散开：出屋目标加随机偏移，避免新生儿在同一点扎堆（互相挤撞/出生点堵塞）。v0.27e 合并系统已移除。
        let out = sim.padLocalToWorld(b, (Math.random() - 0.5) * 3.0, b.padD / 2 + 2.0 + Math.random() * 1.2);
        if (!sim.world.walkableAt(out.x, out.z)) out = sim.padLocalToWorld(b, 0, b.padD / 2 + 2.0);
        sim.sendMove(baby, out.x, out.z);
        logger.info("produce", `茅屋#${b.id} 出生村民#${baby.id}`, {
          team: b.team,
          dwell: b.dwell,
          born: b.born,
          pop: sim.countPop(b.team),
        });
      }
    }
    // v0.32 船屋产船：住满 BOATHOUSE_DWELL 才涨进度（住不满一动不动），BOAT_BUILD_T 秒一条；
    // 同屋存活达 BOATHOUSE_FLEET_CAP 只暂停（进度保留，沉一补一）；下水点找不到同样等待。
    for (const b of sim.buildings) {
      if (b.hp <= 0 || b.kind !== "boathouse" || b.level < 1) continue;
      const bh = b as Boathouse;
      // 懒清理：沉没/被拆的船腾出名额（unitById 只认活船）。
      bh.producedBoatIds = bh.producedBoatIds.filter((id) => {
        const u = sim.unitById(id);
        return !!u && u.kind === "boat";
      });
      const fleet = bh.producedBoatIds.length;
      logger.periodic(`boathouse:${b.id}`, 1000, LogLevel.Debug, "produce", `船屋#${b.id}`, () => ({
        team: b.team,
        dwell: `${b.dwell}/${BOATHOUSE_DWELL}`,
        prod: +b.prod.toFixed(3),
        fleet: `${fleet}/${BOATHOUSE_FLEET_CAP}`,
        blocked: b.dwell < BOATHOUSE_DWELL ? "no-crew" : fleet >= BOATHOUSE_FLEET_CAP ? "fleet-full" : undefined,
      }));
      if (b.dwell < BOATHOUSE_DWELL) continue;
      const rate = (1 / BOAT_BUILD_T) * sim.rates.of(b.team).prod;
      b.prod += rate * dt;
      if (b.prod < 1) continue;
      if (fleet >= BOATHOUSE_FLEET_CAP) {
        logger.throttled(`fleet:${b.id}`, 2000, LogLevel.Warn, "produce", `船屋#${b.id} 满编待产（进度保留）`, {
          team: b.team,
          fleet,
        });
        continue;
      }
      const launch = this.findLaunchWater(sim, b);
      if (!launch) {
        logger.throttled(`launch:${b.id}`, 2000, LogLevel.Warn, "produce", `船屋#${b.id} 找不到下水点，进度卡住`, {
          prod: +b.prod.toFixed(2),
        });
        continue;
      }
      b.prod = 0;
      b.born += 1;
      const boat = sim.addUnit(b.team, "boat", launch.x, launch.z);
      boat.y = BOAT_FLOAT_Y;
      boat.yaw = Math.atan2(launch.x - b.x, launch.z - b.z);
      bh.producedBoatIds.push(boat.id);
      logger.info("produce", `船屋#${b.id} 战船#${boat.id}下水`, {
        team: b.team,
        dwell: b.dwell,
        fleet: bh.producedBoatIds.length,
      });
      if (b.team === BLUE) sim.toast("战船下水");
    }
  }

  /**
   * v0.32 下水点：屋旁 LAUNCH_RANGE 内螺旋找水格（朝 yaw 方向优先），找不到返回 null
   * （岸被雕刻填了之类，produce 进度保留等待，不崩）。
   */
  private findLaunchWater(sim: Sim, b: Building): { x: number; z: number } | null {
    for (let r = 0.5; r <= LAUNCH_RANGE; r += 0.5) {
      const steps = Math.max(8, Math.ceil(r * 8));
      for (let k = 0; k < steps; k++) {
        const a = (k / steps) * Math.PI * 2 + b.yaw;
        const x = b.x + Math.cos(a) * r;
        const z = b.z + Math.sin(a) * r;
        if (waterAt(sim.world, x, z)) return { x, z };
      }
    }
    return null;
  }

  tickEnter(sim: Sim, dt: number): void {
    for (const u of sim.units) {
      if (u.enterT <= 0) continue;
      const home = sim.buildingById(u.homeId);
      // v0.28e 爬塔动画：enterT 期间从塔脚起点直线+爬升插值到瞭望台站位——
      // 物理上 y 逐帧上升（真的"走到楼顶"），渲染随 u.x/y/z 自然呈现攀爬过程。
      if (home && home.kind === "tower") {
        const idx = sim.towerGarrison(home).findIndex((g) => g.id === u.id);
        const slot = sim.towerSlotPos(home, Math.max(0, idx));
        const p = 1 - u.enterT / TOWER_CLIMB_T; // 0→1 爬塔进度
        u.x = u.climbX + (slot.x - u.climbX) * p;
        u.z = u.climbZ + (slot.z - u.climbZ) * p;
        u.y = u.climbY + (home.y + TOWER_DECK_Y - u.climbY) * p;
        u.yaw = Math.atan2(slot.x - u.climbX, slot.z - u.climbZ);
        u.enterT = Math.max(0, u.enterT - dt);
        continue;
      }
      // v0.30 走入大龙训练营：从门口直线走到厂房中心，随后被渲染层隐藏（厂内驻员不画）。
      if (home && home.kind === "dragonFactory") {
        const dest = { x: home.x, z: home.z };
        const dx = dest.x - u.x;
        const dz = dest.z - u.z;
        const len = Math.hypot(dx, dz);
        if (len > 0.02) {
          const step = Math.min(len, 2.6 * dt);
          u.x += (dx / len) * step;
          u.z += (dz / len) * step;
          u.yaw = Math.atan2(dx, dz);
        }
        u.y = sim.world.heightAt(u.x, u.z);
        u.enterT -= dt;
        if (u.enterT <= 0 && u.team === BLUE) {
          sim.toast(`牛战士走进大龙训练营（${home.dwell}/${DRAGON_GARRISON_MAX}）`);
        }
        continue;
      }
      const hut = home;
      const dest = hut ? sim.padLocalToWorld(hut, 0, hut.padD * 0.12) : { x: u.x, z: u.z };
      const dx = dest.x - u.x;
      const dz = dest.z - u.z;
      const len = Math.hypot(dx, dz);
      if (len > 0.02) {
        const step = Math.min(len, 2.6 * dt);
        u.x += (dx / len) * step;
        u.z += (dz / len) * step;
        u.yaw = Math.atan2(dx, dz);
      }
      u.y = sim.world.heightAt(u.x, u.z);
      u.enterT -= dt;
      if (u.enterT <= 0) {
        u.enterT = 0;
        if (u.team === BLUE && hut) {
          // v0.32 船屋住户 toast 独立口径（住满 10 开工）。
          if (hut.kind === "boathouse") sim.toast(`村民住进船屋（${hut.dwell}/${BOATHOUSE_DWELL}）`);
          else sim.toast(`勇士住进茅屋（${hut.dwell}/${houseMaxPop(hut.level)}）`);
        }
      }
    }
  }

  occupy(sim: Sim, u: Unit, hut: Building): boolean {
    if (u.kind !== "walker" || u.homeId > 0) return false;
    // v0.32 船屋同款入住（只收村民，住满 BOATHOUSE_DWELL 开工造船，无升级链）。
    if ((hut.kind !== "hut" && hut.kind !== "boathouse") || hut.level < 1 || hut.hp <= 0) return false;
    if (hut.team !== u.team) return false;
    const cap = hut.kind === "boathouse" ? BOATHOUSE_DWELL : houseMaxPop(hut.level);
    if (hut.dwell >= cap) return false;
    hut.dwell += 1;
    u.homeId = hut.id;
    u.selected = false;
    u.path = [];
    u.pathI = 0;
    u.job = "idle";
    u.think = 99;
    u.targetId = 0;
    u.atkId = 0;
    u.carry = 0;
    u.channel = 0;
    // v0.31 建营者保护：入住即卸任。不清 foundKind 会永久占死 train 重试的"已有建营者"
    // 名额，训练营请求悬空（敌方出不了火战士的根因之一）；settle 坐标一并作废，
    // 防止日后出屋时按残留坐标误落一座 hut。
    u.foundKind = null;
    u.settleX = -1;
    u.settleZ = -1;
    logger.info("produce", `村民#${u.id} 入住茅屋#${hut.id}`, {
      dwell: `${hut.dwell}/${houseMaxPop(hut.level)}`,
      pop: sim.countPop(u.team),
    });
    // v0.15 住满即升：L1 住满 2 人 / L2 住满 5 人当帧置位升级，下一次 produce tick（下一帧）生效，
    // 不再等第 2 个新生儿出生（旧 born>=2 门槛会让升级"顿"好几秒）。
    // v0.32 船屋单级：住满只开工（produce 船屋分支），不置 wantLevel。
    if (hut.kind === "hut" && hut.dwell >= cap && hut.level < 3) hut.wantLevel = hut.level + 1;
    return true;
  }

  tryOccupy(sim: Sim, u: Unit): boolean {
    if (u.kind !== "walker" || u.homeId > 0 || !u.targetId) return false;
    const hut = sim.buildingById(u.targetId);
    // v0.32 船屋同款到站入住（orderMove 船屋分支把 targetId 指向船屋）。
    if (!hut || (hut.kind !== "hut" && hut.kind !== "boathouse") || hut.level < 1 || hut.hp <= 0 || hut.team !== u.team)
      return false;
    const door = sim.hutDoor(hut);
    const d2 = (u.x - door.x) ** 2 + (u.z - door.z) ** 2;
    if (d2 > 1.2 * 1.2) return false;
    if (!this.occupy(sim, u, hut)) return false;
    u.enterT = 0.42;
    return true;
  }

  deliverWood(sim: Sim, b: Building): void {
    if (sim.review) return;
    if (b.hp <= 0 || b.need <= 0 || b.wood >= b.need) return;
    // v0.28i 渐进式建造：交付只堆木（地基上可见），完工由 tickConstruction 按存木速率起升达标触发。
    b.wood += 1;
    logger.info("produce", `工地#${b.id}(${b.kind}) 收到木料 ${b.wood}/${b.need}`, { team: b.team });
  }

  /**
   * v0.28i 渐进式建造 tick：每座有存木的 L0 工地 built += dt × BASE × (0.5 + 存木)，
   * 达到 need 即完工（completeStep 升 L1，清木料与进度）。
   * 存木越多建得越快——两个村民供木 = 更快到齐 + 更高存量 = 显著加速。
   */
  tickConstruction(sim: Sim, dt: number): void {
    if (sim.freezeProd) return;
    for (const b of sim.buildings) {
      if (b.hp <= 0 || b.level !== 0 || b.need <= 0 || b.wood <= 0) continue;
      if (b.wood > b.need) b.wood = b.need;
      // v0.28i-2 修复：进度封顶在存木数——旧实现只看时间，1/2 根木也能把 2 木的茅屋
      // "涨满完工"（实测红方只送 1 根木就建成，第二根永远送不进）。
      b.built = Math.min(b.need, Math.max(b.built, 0) + dt * BUILD_RATE_BASE * (0.5 + b.wood));
      if (b.built > b.wood) b.built = b.wood;
      if (b.built >= b.need) {
        logger.info("produce", `工地#${b.id}(${b.kind}) 建成`, {
          team: b.team,
          wood: b.wood,
          need: b.need,
          built: +b.built.toFixed(2),
        });
        b.wood = 0;
        b.built = 0;
        this.completeStep(sim, b);
      }
    }
  }

  completeStep(sim: Sim, b: Building): void {
    if (b.kind === "hut") {
      if (b.level === 0) this.upgradeBuilding(sim, b, 1);
      return;
    }
    // v0.27-3 哨塔与营地同款完工：送满木头即落成（塔只需 1 捆，落成最快）。
    // v0.32 船屋同规（单级，落成即 L1 开放入住）。
    if ((isCampKind(b.kind) || b.kind === "tower" || b.kind === "dragonFactory" || b.kind === "boathouse") && b.level === 0) {
      this.upgradeBuilding(sim, b, 1);
    }
  }

  upgradeBuilding(sim: Sim, b: Building, level: number): void {
    b.level = level;
    // v0.27-3 哨塔占地独立（TOWER_PAD 1.8，比茅屋/营地的 2.6 小一圈）。
    const pad = b.kind === "hut" ? padSize(level) : sitePad(b.kind); // v0.28c 训练营 2.6 / 哨塔 0.6
    const h = sim.world.heightAt(b.x, b.z);
    sim.world.flattenPad(b.x, b.z, pad.w, pad.d, b.yaw, h);
    b.padW = pad.w;
    b.padD = pad.d;
    b.y = sim.world.heightAt(b.x, b.z);
    const hp = houseHp(Math.max(1, level));
    const ratio = b.maxHp > 0 ? b.hp / b.maxHp : 1;
    b.maxHp = hp;
    b.hp = Math.max(1, Math.round(hp * ratio));
    b.wood = 0;
    b.need = woodNeedFor(b.kind, level);
    sim.markHouseBlocks();
    logger.info("produce", `建筑#${b.id}(${b.kind}) 升至 ${level} 级`, {
      pad: `${pad.w}×${pad.d}`,
      team: b.team,
    });
    if (b.kind === "hut") {
      if (level === 1) sim.toast(b.team === BLUE ? "子民筑起一座屋宇" : "敌民筑屋");
      else sim.toast(b.team === BLUE ? `茅屋升至 ${level} 级` : "敌方茅屋升级");
    } else if (isCampKind(b.kind)) {
      sim.toast(b.team === BLUE ? "训练营落成" : "敌方训练营落成");
    } else if (b.kind === "tower") {
      sim.toast(b.team === BLUE ? "哨塔落成" : "敌方哨塔落成");
    } else if (b.kind === "boathouse") {
      // v0.32 船屋落成：接下来住满 10 名村民开工造船。
      sim.toast(b.team === BLUE ? "船屋落成——住满 10 名村民即可开工" : "敌方船屋落成");
    } else if (b.kind === "dragonFactory") {
      // v0.30 大龙训练营落成：接下来等 20 名牛战士进驻。
      sim.toast(b.team === BLUE ? "大龙训练营落成——凑齐 20 名牛战士即可开工" : "敌方大龙训练营落成");
    }
  }

  needsWood(b: Building): boolean {
    return b.hp > 0 && b.need > 0 && b.wood < b.need;
  }

  hasNeedSite(sim: Sim, team: Team): boolean {
    return sim.buildings.some((b) => b.team === team && this.needsWood(b));
  }

  nearestNeedSite(sim: Sim, team: Team, x: number, z: number): Building | null {
    let best: Building | null = null;
    let bestD = 1e9;
    // v0.33 按岛过滤（与 nearestTree 同理：海对岸的工地送不到，分岛图搬运工不再隔海认工地）。
    const home = sim.world.islandAt(x, z);
    for (const b of sim.buildings) {
      if (b.team !== team || !this.needsWood(b)) continue;
      if (home >= 0 && sim.world.islandAt(b.x, b.z) !== home) continue;
      const d = (x - b.x) ** 2 + (z - b.z) ** 2;
      if (d < bestD) {
        bestD = d;
        best = b;
      }
    }
    return best;
  }
}
