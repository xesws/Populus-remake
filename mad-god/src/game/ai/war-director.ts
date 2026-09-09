// v0.17 敌方 AI：军事子脑（WarDirector）——进攻波次编成、受袭防御响应、哨塔防御工事。
// 波次节奏（waveSize/waveGapSec/reactSec）与塔防节奏（towerCap/towerGapSec）全部取自 AIProfile；
// 只通过 Sim 既有接口（setOrder/setMagnet/sendMove/atkId/assignCampFounder/targetId）下发意图，
// 不侵入寻路/战斗/生产系统内部。

import { logger } from "../logger";
import type { Sim } from "../sim";
import { astar, nearestLand } from "../path";
import { BLUE, Cell, dist2, RED, Team, TOWER_GARRISON_MAX, UnitKind } from "../types";
import { AIProfile } from "./ai-profile";
import type { IWarDirector } from "./types";

/** 受袭事件：某时刻 (x,z) 处本队单位/建筑被攻击。 */
interface HurtEvent {
  x: number;
  z: number;
  /** 事件发生的游戏时刻（秒） */
  t: number;
}

export class WarDirector implements IWarDirector {
  readonly team: Team;
  readonly profile: AIProfile;
  /** 决策节流累计（秒）：达到 profile.tickSec 才处理一次 */
  private acc = 0;
  /** 上一波进攻发起的游戏时刻（秒）；-1e9 表示从未发波 */
  lastWaveTime = -1e9;
  /** 已发波次计数（自 1 起） */
  waves = 0;
  /** 受袭事件队列：按 profile.reactSec 延迟后就近派兵，处理完出队 */
  private hurtQueue: HurtEvent[] = [];
  /** v0.31 受袭上报节流：DoT 类伤害（龙焰/火山等逐帧结算）1s 至多入队一条 */
  private lastHurtT = -1e9;
  /** v0.31 上一次落塔（派建塔营者）的游戏时刻；-1e9 表示从未建塔 */
  private lastTowerTime = -1e9;
  /**
   * v0.33 隔海探路缓存（分岛图红方专用）：key＝量化后的{目标,集结点}，TTL 15s。
   * launchWave/dispatchDefenders 发兵前先探——海对岸的目标直接整波取消，
   * 否则大军走到岸边罚站＋think 节流 60Hz 刷 A*（旧单块图恒可达，探路恒真零开销感知）。
   */
  private probeCache = { key: "", t: -1e9, ok: false };

  constructor(team: Team, profile: AIProfile) {
    this.team = team;
    this.profile = profile;
  }

  /** 当前士兵总数（warrior/preacher/firewarrior/spy）。
   *  v0.31.1 口径改为野战军（homeId===0）：驻塔牛战士被塔永久吸收、不参与波次与驰援，
   *  计入门槛会让 waveReady 虚高（塔满即恒真）、波次缩成 1~2 人迷你队。 */
  armySize(sim: Sim): number {
    let n = 0;
    for (const u of sim.units) {
      if (u.team !== this.team || u.hp <= 0 || u.homeId > 0) continue;
      if (this.isFighter(u.kind) || u.kind === "spy") n++;
    }
    return n;
  }

  /** 波次就绪：兵力 ≥ waveSize 且距上一波 ≥ waveGapSec（纯 sim.time 计算，无内部计时器）。 */
  waveReady(sim: Sim): boolean {
    return (
      this.armySize(sim) >= this.profile.waveSize &&
      sim.time - this.lastWaveTime >= this.profile.waveGapSec
    );
  }

  /** 发动进攻：setOrder("fight") + magnet 锁定敌方建筑/单位密集点，并给每个士兵显式行军目标与攻击目标。 */
  launchWave(sim: Sim): boolean {
    if (!this.waveReady(sim)) return false;
    const foe: Team = this.team === RED ? BLUE : RED;
    const foeHouses = sim.buildings.filter((b) => b.team === foe && b.hp > 0);
    const foeUnits = sim.units.filter((u) => u.team === foe && u.hp > 0 && u.homeId === 0);
    const focus = this.cluster(foeHouses, foeUnits);
    if (!focus) return false; // 敌方已无建筑/单位，无目标可打
    // 先收集可参战士兵：无人可发（全员训练/战损/驻塔）则整波取消，避免空放波次。
    const marchers = sim.units.filter(
      (u) =>
        u.team === this.team &&
        u.hp > 0 &&
        u.homeId === 0 &&
        this.isFighter(u.kind) &&
        u.job !== "train",
    );
    if (!marchers.length) return false;
    // v0.33 隔海无路整波取消（分岛图红方无船）：不断重试由 15s 探路缓存吸收，不刷 A*。
    if (!this.seaProbe(sim, focus.x, focus.z, marchers[0]!.x, marchers[0]!.z)) {
      logger.info("ai-war", "隔海无路，本波取消（分岛图等蓝方登陆再打）", {
        team: this.team,
        x: +focus.x.toFixed(1),
        z: +focus.z.toFixed(1),
      });
      return false;
    }
    sim.setMagnet(this.team, focus.x, focus.z);
    sim.setOrder(this.team, "fight");
    // v0.17 repath 对 fight 没有 magnet 寻路分支，setOrder 也不会改士兵个体 order：
    // 必须逐个 sendMove 显式下发行军目标，否则发波只是原地罚站。
    for (const u of marchers) {
      sim.sendMove(u, focus.x, focus.z);
      // sendMove 会清空 atkId：先行军、后挂最近敌方目标，到达密集点即转入 chaseAttack 进攻。
      const tid = this.nearestEnemyId(sim, u.x, u.z, foe);
      if (tid) u.atkId = tid;
    }
    this.lastWaveTime = sim.time;
    this.waves++;
    logger.info("ai-war", `第 ${this.waves} 波进攻`, {
      team: this.team,
      army: marchers.length,
      x: +focus.x.toFixed(1),
      z: +focus.z.toFixed(1),
    });
    return true;
  }

  /** 收兵回防：全队转 settle，magnet 拉回最近的自家茅屋（无茅屋则保持原地）。 */
  recall(sim: Sim): void {
    sim.setOrder(this.team, "settle");
    let hx = -1;
    let hz = -1;
    let bestD = 1e9;
    const mx = sim.teams[this.team].magnetX;
    const mz = sim.teams[this.team].magnetZ;
    for (const b of sim.buildings) {
      if (b.team !== this.team || b.hp <= 0 || b.kind !== "hut") continue;
      const d = dist2(b.x, b.z, mx, mz);
      if (d < bestD) {
        bestD = d;
        hx = b.x;
        hz = b.z;
      }
    }
    if (hx >= 0) sim.setMagnet(this.team, hx, hz);
  }

  /** 防御响应入口：sim.onTeamHurt 按 team 分发调用；事件入队，由 update 按 reactSec 延迟派兵。
   *  v0.31 加 1s 节流：受袭上报已覆盖全部伤害源（近战/火球/法术/龙焰），DoT 类逐帧结算
   *  会以 60Hz 刷队列——每秒至多入队一条足够驱动防御响应。 */
  onHurt(sim: Sim, x: number, z: number): void {
    if (sim.time - this.lastHurtT < 1.0) return;
    this.lastHurtT = sim.time;
    this.hurtQueue.push({ x, z, t: sim.time });
    // 队列上限：极端高频受袭时丢弃最旧事件，避免无限膨胀。
    if (this.hurtQueue.length > 8) this.hurtQueue.shift();
  }

  /** 每帧驱动：按 tickSec 节流，处理受袭队列（事件过 reactSec 触发防御波次）+ 塔防维护。
   *  波次冷却无需在此维护——waveReady 由 sim.time 纯计算；
   *  attack 状态的兵耗尽检测归 TribeBrain，本类只提供 armySize/waveReady。 */
  update(sim: Sim, dt: number): void {
    this.acc += dt;
    if (this.acc < this.profile.tickSec) return;
    this.acc = 0;
    if (sim.winner !== null) return;
    this.processHurt(sim);
    this.tryBuildTower(sim);
    this.tryGarrisonTowers(sim);
  }

  /** 受袭事件到期处理：v0.31.1 每个决策周期只派**一个**最早到期事件——旧实现对同批
   *  到期事件逐个派兵，后一发会把前一发的驰援者原地改道，两点游击时防御者永远在路上
   *  折返。未到期事件保留，其余到期事件顺延到后续周期依次处理（决策周期 1s，足够密集）。 */
  private processHurt(sim: Sim): void {
    if (!this.hurtQueue.length) return;
    const due = sim.time - this.profile.reactSec;
    let idx = -1;
    for (let i = 0; i < this.hurtQueue.length; i++) {
      if (this.hurtQueue[i]!.t <= due) {
        idx = i;
        break;
      }
    }
    if (idx < 0) return;
    const e = this.hurtQueue.splice(idx, 1)[0]!;
    this.dispatchDefenders(sim, e.x, e.z);
  }

  /** 就近派兵：取事发点最近的 min(waveSize, armySize) 名空闲士兵，sendMove 冲向事发点。
   *  v0.31.1 池子排除 job==="move"：在途驰援者（sendMove 已清 atkId）不再被后续事件改道。 */
  private dispatchDefenders(sim: Sim, x: number, z: number): void {
    const pool = sim.units.filter(
      (u) =>
        u.team === this.team &&
        u.hp > 0 &&
        u.homeId === 0 &&
        this.isFighter(u.kind) &&
        u.atkId === 0 &&
        u.job !== "train" &&
        u.job !== "move",
    );
    pool.sort((a, b) => dist2(a.x, a.z, x, z) - dist2(b.x, b.z, x, z));
    const n = Math.min(this.profile.waveSize, this.armySize(sim), pool.length);
    // v0.33 隔海不驰援（与波次同理：红龙在敌岛挨打，地面部队过不去就不派）。
    if (n > 0 && !this.seaProbe(sim, x, z, pool[0]!.x, pool[0]!.z)) {
      logger.info("ai-war", "隔海无路，驰援取消", { team: this.team, x: +x.toFixed(1), z: +z.toFixed(1) });
      return;
    }
    for (let i = 0; i < n; i++) {
      const u = pool[i]!;
      sim.sendMove(u, x, z);
    }
    if (n > 0) {
      logger.info("ai-war", `受袭响应：${n} 兵驰援`, {
        team: this.team,
        x: +x.toFixed(1),
        z: +z.toFixed(1),
      });
    }
  }

  /**
   * v0.31 防御工事：存量未满（含 L0 地基）、冷却已过、且本队有活火战士（塔要有弹药才有意义）
   * 时，派一名空闲村民朝敌方向落哨塔地基。复用 assignCampFounder 的泛型落基链路
   * （foundSite 落 L0、1 捆木起升、completeStep 完工），零新系统。
   */
  private tryBuildTower(sim: Sim): void {
    if (this.profile.towerCap <= 0) return;
    const towers = sim.buildings.filter((b) => b.team === this.team && b.kind === "tower" && b.hp > 0);
    if (towers.length >= this.profile.towerCap) return;
    if (sim.time - this.lastTowerTime < this.profile.towerGapSec) return;
    if (sim.countKind(this.team, "firewarrior") < 1) return;
    if (sim.units.some((u) => u.team === this.team && u.kind === "walker" && u.foundKind === "tower")) return;
    const founder = sim.units.find(
      (u) =>
        u.team === this.team &&
        u.kind === "walker" &&
        u.homeId === 0 &&
        u.targetId === 0 &&
        u.atkId === 0 &&
        u.carry === 0 &&
        u.job === "idle" &&
        u.foundKind === null,
    );
    if (!founder) return;
    sim.assignCampFounder(founder, "tower");
    // 落基成功（新增地基）或营者已领命才起冷却；选址失败（foundKind 被清、塔数未变）
    // 不消耗冷却，下个决策周期重试。v0.31.1 修"误把既有塔当新落基"的假冷却/假日志。
    const towersNow = sim.buildings.filter((b) => b.team === this.team && b.kind === "tower" && b.hp > 0).length;
    const placed = founder.foundKind === "tower" || towersNow > towers.length;
    if (placed) {
      this.lastTowerTime = sim.time;
      logger.info("ai-war", `派村民#${founder.id} 前往修建哨塔`, {
        team: this.team,
        towers: towers.length + 1,
        cap: this.profile.towerCap,
      });
    }
  }

  /**
   * v0.31 驻塔：把空闲牛战士分配到有空位的自家 L1 哨塔——sendMove 到塔边 + targetId 指塔，
   * 与玩家右键路径完全同构，thinkUnits 既有 tryGarrison 在 2.6 格内自动爬塔。
   * 名额计算含在途者（targetId 已指向该塔），避免超派后堵在塔脚。
   */
  private tryGarrisonTowers(sim: Sim): void {
    const towers = sim.buildings.filter(
      (b) => b.team === this.team && b.kind === "tower" && b.level >= 1 && b.hp > 0,
    );
    if (!towers.length) return;
    for (const t of towers) {
      const garrison = sim.towerGarrison(t).length;
      const inbound = sim.units.filter(
        (u) => u.team === this.team && u.kind === "firewarrior" && u.homeId === 0 && u.targetId === t.id,
      ).length;
      let free = TOWER_GARRISON_MAX - garrison - inbound;
      if (free <= 0) continue;
      const idle = sim.units
        .filter(
          (u) =>
            u.team === this.team &&
            u.kind === "firewarrior" &&
            u.hp > 0 &&
            u.homeId === 0 &&
            u.targetId === 0 &&
            u.atkId === 0 &&
            u.job === "idle",
        )
        .sort((a, b) => dist2(a.x, a.z, t.x, t.z) - dist2(b.x, b.z, t.x, t.z));
      for (const f of idle) {
        if (free <= 0) break;
        const edge = sim.padEdge(t.x, t.z, t.padW, t.padD, t.yaw, f.x, f.z);
        sim.sendMove(f, edge.x, edge.z);
        f.targetId = t.id;
        f.atkId = 0;
        free--;
      }
    }
  }

  /** 战斗兵种判定（不含间谍：间谍只计入 armySize，不参与波次与防御）。 */
  private isFighter(kind: UnitKind): boolean {
    return kind === "warrior" || kind === "preacher" || kind === "firewarrior";
  }

  /**
   * v0.33 隔海探路（陆地 astar 全图上限，prio=0 玩家级特权免预算）：
   * 同{目标,集结点} 15s 内复用结论——发波/驰援决策高频调用，跨海 astar 每次穷举
   * 全图（~60ms），无缓存会把主线程刷爆。单块图恒真，行为与旧版一致。
   */
  private seaProbe(sim: Sim, fx: number, fz: number, mx: number, mz: number): boolean {
    const key = `${Math.round(fx / 2)}:${Math.round(fz / 2)}:${Math.round(mx / 2)}:${Math.round(mz / 2)}`;
    if (key === this.probeCache.key && sim.time - this.probeCache.t < 15) return this.probeCache.ok;
    // astar 在访问上限/不可达时可能返回“朝目标走了一段”的部分路径，非空不代表到达。
    // 分岛后这会随机把隔海残路误判为可达并记一波进攻；必须与吸附后的真实终点逐点核对。
    const target = nearestLand(sim.world, fx, fz);
    const path = target ? astar(sim.world, mx, mz, target.x, target.z, 20736, 0) : [];
    const end = path[path.length - 1];
    const ok = !!target && !!end && Math.hypot(end.x - target.x, end.z - target.z) < 0.01;
    this.probeCache = { key, t: sim.time, ok };
    return ok;
  }

  /** 敌方密集点：在敌方建筑/单位点集中取邻域（半径 √20 格）内同伴最多的点。 */
  private cluster(houses: { x: number; z: number }[], units: { x: number; z: number }[]): Cell | null {
    const pts = [
      ...houses.map((h) => ({ x: h.x, z: h.z })),
      ...units.map((u) => ({ x: u.x, z: u.z })),
    ];
    if (!pts.length) return null;
    let best = pts[0]!;
    let bestN = -1;
    for (const p of pts) {
      let n = 0;
      for (const q of pts) if (dist2(p.x, p.z, q.x, q.z) < 20) n++;
      if (n > bestN) {
        bestN = n;
        best = p;
      }
    }
    return best;
  }

  /** 离 (x,z) 最近的敌方单位/建筑 id（单位与建筑取更近者）；无目标返回 0。 */
  private nearestEnemyId(sim: Sim, x: number, z: number, foe: Team): number {
    let best = 0;
    let bestD = 1e9;
    for (const u of sim.units) {
      if (u.team !== foe || u.hp <= 0 || u.homeId > 0) continue;
      const d = dist2(x, z, u.x, u.z);
      if (d < bestD) {
        bestD = d;
        best = u.id;
      }
    }
    for (const b of sim.buildings) {
      if (b.team !== foe || b.hp <= 0) continue;
      const d = dist2(x, z, b.x, b.z);
      if (d < bestD) {
        bestD = d;
        best = b.id;
      }
    }
    return best;
  }
}
