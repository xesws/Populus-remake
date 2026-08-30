import {
  BLUE,
  clamp,
  houseBaseRate,
  HOUSE_ROOF_Y,
  TOWER_PAD,
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
import { LogLevel, logger } from "../logger";

export class ProductionSystem implements ISystem {
  update(sim: Sim, dt: number): void {
    this.tickTrees(sim, dt);
    this.refreshHouses(sim);
    sim.markHouseBlocks();
    this.regenCharges(sim, dt);
    this.produce(sim, dt);
    this.arrangeDwellers(sim);
  }

  /**
   * v0.27h 住户"上房"：每座茅屋的住户在屋顶排一圈小站位（r=0.55、按序错角），
   * 屋顶高度 HOUSE_ROOF_Y[level]。目的有二：① 屋里住了几个人一眼可见；
   * ② 玩家能直接点选屋顶上的具体村民、右键拉他出来（进出对等的驻扎机制）。
   * 仍在进屋动画（enterT>0）的不动；单位坐标在屋内地基上，不影响寻路/生产。
   */
  arrangeDwellers(sim: Sim): void {
    for (const b of sim.buildings) {
      if (b.kind !== "hut" || b.hp <= 0 || b.level < 1) continue;
      const lv = b.level >= 3 ? 3 : b.level;
      let i = 0;
      for (const u of sim.units) {
        if (u.homeId !== b.id || u.enterT > 0) continue;
        const ang = i * 2.4; // 黄金角错开，人数增减不整体重排
        const p = sim.padLocalToWorld(b, Math.cos(ang) * 0.55, Math.sin(ang) * 0.55);
        u.x = p.x;
        u.z = p.z;
        u.y = b.y + HOUSE_ROOF_Y[lv]!;
        i++;
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
      } else if (isCampKind(b.kind) || b.kind === "tower") {
        // v0.27-3 哨塔与营地同款地基校验（塔更小，同样不能悬空/泡水）。
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

  produce(sim: Sim, dt: number): void {
    if (sim.freezeProd) {
      logger.throttled("produce:frozen", 2000, LogLevel.Warn, "produce", "freezeProd=true，生产被冻结（shot 导演占用）");
      return;
    }
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
  }

  tickEnter(sim: Sim, dt: number): void {
    for (const u of sim.units) {
      if (u.enterT <= 0) continue;
      const hut = sim.buildingById(u.homeId);
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
          sim.toast(`勇士住进茅屋（${hut.dwell}/${houseMaxPop(hut.level)}）`);
        }
      }
    }
  }

  occupy(sim: Sim, u: Unit, hut: Building): boolean {
    if (u.kind !== "walker" || u.homeId > 0) return false;
    if (hut.kind !== "hut" || hut.level < 1 || hut.hp <= 0) return false;
    if (hut.team !== u.team) return false;
    if (hut.dwell >= houseMaxPop(hut.level)) return false;
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
    logger.info("produce", `村民#${u.id} 入住茅屋#${hut.id}`, {
      dwell: `${hut.dwell}/${houseMaxPop(hut.level)}`,
      pop: sim.countPop(u.team),
    });
    // v0.15 住满即升：L1 住满 2 人 / L2 住满 5 人当帧置位升级，下一次 produce tick（下一帧）生效，
    // 不再等第 2 个新生儿出生（旧 born>=2 门槛会让升级"顿"好几秒）。
    if (hut.dwell >= houseMaxPop(hut.level) && hut.level < 3) hut.wantLevel = hut.level + 1;
    return true;
  }

  tryOccupy(sim: Sim, u: Unit): boolean {
    if (u.kind !== "walker" || u.homeId > 0 || !u.targetId) return false;
    const hut = sim.buildingById(u.targetId);
    if (!hut || hut.kind !== "hut" || hut.level < 1 || hut.hp <= 0 || hut.team !== u.team) return false;
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
    b.wood += 1;
    if (b.wood < b.need) return;
    this.completeStep(sim, b);
  }

  completeStep(sim: Sim, b: Building): void {
    if (b.kind === "hut") {
      if (b.level === 0) this.upgradeBuilding(sim, b, 1);
      return;
    }
    // v0.27-3 哨塔与营地同款完工：送满木头即落成（塔只需 1 捆，落成最快）。
    if ((isCampKind(b.kind) || b.kind === "tower") && b.level === 0) this.upgradeBuilding(sim, b, 1);
  }

  upgradeBuilding(sim: Sim, b: Building, level: number): void {
    b.level = level;
    // v0.27-3 哨塔占地独立（TOWER_PAD 1.8，比茅屋/营地的 2.6 小一圈）。
    const pad = b.kind === "hut" ? padSize(level) : b.kind === "tower" ? { w: TOWER_PAD, d: TOWER_PAD } : padSize(1);
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
    for (const b of sim.buildings) {
      if (b.team !== team || !this.needsWood(b)) continue;
      const d = (x - b.x) ** 2 + (z - b.z) ** 2;
      if (d < bestD) {
        bestD = d;
        best = b;
      }
    }
    return best;
  }
}
