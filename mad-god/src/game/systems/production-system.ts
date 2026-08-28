import {
  BLUE,
  clamp,
  houseBaseRate,
  houseHp,
  houseMaxPop,
  HOUSE_DWELL_BONUS,
  isCampKind,
  isTribe,
  padSize,
  Team,
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
    this.regenMana(sim, dt);
    this.produce(sim, dt);
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
      } else if (isCampKind(b.kind)) {
        const s = sim.world.padStats(b.x, b.z, b.padW, b.padD, b.yaw);
        if (s.n === 0 || s.land < 0.55 || s.mean <= WATER) b.hp = 0;
      }
    }
  }

  regenMana(sim: Sim, dt: number): void {
    for (const team of [BLUE, 1] as Team[]) {
      const t = sim.teams[team];
      let cap = 80;
      let regen = 1.2;
      for (const b of sim.buildings) {
        if (b.team !== team || b.kind !== "hut" || b.level < 1) continue;
        cap += b.level * 18;
        regen += b.level * 0.85;
      }
      const pop = sim.countPop(team);
      cap += Math.min(80, pop * 2);
      regen += pop * 0.1;
      t.manaCap = cap;
      t.mana = clamp(t.mana + regen * dt, 0, t.manaCap);
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
      const rate = houseBaseRate(b.level) * (1 + HOUSE_DWELL_BONUS * (b.dwell - 1));
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
        const out = sim.padLocalToWorld(b, 0, b.padD / 2 + 2.0);
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
    if (isCampKind(b.kind) && b.level === 0) this.upgradeBuilding(sim, b, 1);
  }

  upgradeBuilding(sim: Sim, b: Building, level: number): void {
    b.level = level;
    const pad = padSize(b.kind === "hut" ? level : 1);
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
