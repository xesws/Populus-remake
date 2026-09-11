// v0.34 敌方 AI：训兵子脑（营地维护 / 编制补缺 / 建营者看门狗）。
// 只通过 Sim 既有接口（assignCampFounder / train / leaveBuilding）下发意图，
// 不侵入移动/寻路/生产/雷电伤害。建营不要求村民盈余；训兵仍走 Sim.train。
// v0.35 训兵保底：入住需求 + founderSlack，fillingFloor 也不把村民训光。
//
// v0.37 军事升级（"造兵特别不积极、只出武士、不出牛战士"的根因修复）：
// ① **每营独立产线**：旧实现只有一条全局 trainCd + 单次 nextTrainKind()，同一时刻只有一座
//    训练营能出人（另一座空转），且整条阶梯被"武士满员"一票否决。现改为四营（武士/牛战士/
//    神庙/间谍）各自排队、各自节流：营地建成就持续出人，queueDepth 保证营地不停机。
// ② **配额驱动**：缺口来自 ArmyPolicy（常备军 = 人口 × armyRatio，牛战士占比 fireRatio），
//    不再是固定 armyCap=8；大龙计划需要的进厂牛战士直接加进牛战士缺口。
// ③ **劳动力保底**：留 laborFloor 名户外村民给伐木/搬木/建营/入住——征召再凶也不许把
//    工地上的人抽空（大龙训练营 6 捆木头还是要有人搬）。
// ④ **大龙训练营纳入营地愿望单**：人口达标即由既有建营链路（落基/看门狗/重建）自动建厂。
// v0.38 群众路线：常备军上限 100（normal）+ 单营节流 5s（营地不停机）——两座营约 22 人/分钟，
// 才能把 100 人的编制真切填满。

import { LogLevel, logger } from "../logger";
import type { Sim } from "../sim";
import { BuildingKind, CAMP_FOR, houseMaxPop, POP_CAP, RED, REPAIR_CREW_MAX, Team, TrainKind, Unit } from "../types";
import { ArmyPolicy } from "./army-policy";
import type { AIProfile } from "./ai-profile";
import type { ITrainingDirector } from "./types";

/** 纯编制快照：RosterPolicy 不碰 Sim，便于单测配额表。 */
export type RosterSnapshot = {
  warrior: number;
  firewarrior: number;
  preacher: number;
  spy: number;
  foeWalk: number;
  warriorHutL1: boolean;
  fireHutL1: boolean;
  fireHutAny: boolean;
  templeL1: boolean;
  templeAny: boolean;
  spyHutL1: boolean;
  spyHutAny: boolean;
  /** v0.37 人口（大龙计划启动门槛） */
  pop: number;
  /** v0.37 大龙训练营：任意存活 / 已完工 L1 */
  dragonFactoryAny: boolean;
  dragonFactoryL1: boolean;
  /** v0.37 大龙计划是否推进中（人口达标且名额未满） */
  dragonProgram: boolean;
};

/**
 * 并行常备配额：武士营开局就要；武士营 L1 后立刻要火战士营（不等 2 名活武士）。
 * 常备下限独立补缺，战死不重跑兵种阶梯。神庙/间谍营按小配额 Trickle（不占常备军编制）。
 * v0.37 追加：人口达标后要大龙训练营（大龙计划的落地由其保证）。
 */
export class RosterPolicy {
  constructor(readonly profile: AIProfile) {}

  floorsMet(s: RosterSnapshot): boolean {
    return s.warrior >= this.profile.warriorMin && s.firewarrior >= this.profile.fireMin;
  }

  /** 补下限时放宽硬顶（战死到 0 也能立刻续上常备兵力）。 */
  fillingFloor(s: RosterSnapshot, kind: TrainKind): boolean {
    if (kind === "warrior") return s.warrior < this.profile.warriorMin;
    if (kind === "firewarrior") return s.firewarrior < this.profile.fireMin;
    return false;
  }

  wantedCamps(s: RosterSnapshot): BuildingKind[] {
    const wanted: BuildingKind[] = ["warriorHut"];
    // 武士营一旦 L1，火战士营并行开工；已有火战士营（含骨架/L0）则继续维护。
    if (s.warriorHutL1 || s.fireHutAny) wanted.push("fireHut");
    if (this.floorsMet(s) || s.templeAny) wanted.push("temple");
    if ((this.floorsMet(s) && s.templeL1) || s.spyHutAny) wanted.push("spyHut");
    // v0.37 大龙计划：人口达标即要厂（已在建/已建成由 maintainCamps 的覆盖判定兜住）。
    if (s.dragonProgram || s.dragonFactoryAny) wanted.push("dragonFactory");
    return wanted;
  }

  /** 传教士 Trickle：神庙 L1 且敌方有村民可感化（没村民可传教就不花这份人力）。 */
  wantsPreacher(s: RosterSnapshot): boolean {
    return s.templeL1 && s.preacher < this.profile.preacherMax && s.foeWalk >= 1;
  }

  /** 间谍 Trickle：间谍营 L1 后补到 spyMax。 */
  wantsSpy(s: RosterSnapshot): boolean {
    return s.spyHutL1 && s.spy < this.profile.spyMax;
  }

  /** 训兵后至少留下 occupyNeed 名入住村民 + founderSlack 名建营机动。 */
  walkerReserve(occupyNeed: number): number {
    return Math.max(0, occupyNeed) + this.profile.founderSlack;
  }

  /** fillingFloor 也不破保底：训完后村民数必须仍 >= reserve。 */
  canAffordTrain(walkers: number, occupyNeed: number, batch = 1): boolean {
    return walkers - batch >= this.walkerReserve(occupyNeed);
  }

  /** 每次只训 1 人，避免一次把户外村民全送进营。 */
  trainBatch(walkers: number, occupyNeed: number): number {
    const reserve = this.walkerReserve(occupyNeed);
    return walkers - reserve >= 1 ? 1 : 0;
  }
}

export class TrainingDirector implements ITrainingDirector {
  readonly team: Team;
  readonly profile: AIProfile;
  readonly policy: RosterPolicy;
  /** v0.37 编制口径（常备军目标/兵种配比/大龙征召名额）；v0.38 起由 TribeBrain 建好**共享注入**，
   *  四个子脑读同一份（否则龙账本/名额在各自实例里不互通）。 */
  readonly army: ArmyPolicy;

  private acc = 0;
  /** v0.37 每营独立训兵冷却（秒）：一座营出人不再把另一座营一起卡住。 */
  private campCd: Partial<Record<BuildingKind, number>> = {};
  /** 上一拍还缺 L1 的营地：从缺到齐的边沿把该营冷却清零，避免雷电后空转。 */
  private missingL1 = new Set<BuildingKind>();
  /** v0.31.1 建营者看门狗：foundKind 超 90s 未落基则卸任。 */
  private founderSeen = new Map<number, number>();

  constructor(team: Team, profile: AIProfile, army: ArmyPolicy = new ArmyPolicy(profile)) {
    this.team = team;
    this.profile = profile;
    this.policy = new RosterPolicy(profile);
    this.army = army;
  }

  update(sim: Sim, dt: number): void {
    for (const k of Object.keys(this.campCd) as BuildingKind[]) {
      this.campCd[k] = Math.max(0, this.campCd[k]! - dt);
    }
    if (sim.winner !== null) return;
    this.acc += dt;
    if (this.acc < this.profile.tickSec) return;
    this.acc = 0;
    this.watchdogFounders(sim);
    this.maintainCamps(sim);
    this.maintainRepairs(sim);
    this.tryTrain(sim);
  }

  snapshot(sim: Sim): RosterSnapshot {
    const me = this.team;
    const foe: Team = me === RED ? 0 : 1;
    return {
      warrior: sim.countKind(me, "warrior"),
      firewarrior: sim.countKind(me, "firewarrior"),
      preacher: sim.countKind(me, "preacher"),
      spy: sim.countKind(me, "spy"),
      foeWalk: sim.countKind(foe, "walker"),
      warriorHutL1: this.hasCamp(sim, "warriorHut", true),
      fireHutL1: this.hasCamp(sim, "fireHut", true),
      fireHutAny: this.hasCamp(sim, "fireHut", false),
      templeL1: this.hasCamp(sim, "temple", true),
      templeAny: this.hasCamp(sim, "temple", false),
      spyHutL1: this.hasCamp(sim, "spyHut", true),
      spyHutAny: this.hasCamp(sim, "spyHut", false),
      pop: sim.countPop(me),
      dragonFactoryAny: this.hasCamp(sim, "dragonFactory", false),
      dragonFactoryL1: this.hasCamp(sim, "dragonFactory", true),
      dragonProgram: this.army.dragonProgramActive(sim, me),
    };
  }

  /** hp>0 即活营（含 L0 地基与雷电骨架）；needL1 时还要求 level>=1。 */
  private hasCamp(sim: Sim, kind: BuildingKind, needL1: boolean): boolean {
    return sim.buildings.some(
      (b) => b.team === this.team && b.kind === kind && b.hp > 0 && (!needL1 || b.level >= 1),
    );
  }

  /** 覆盖：活建筑（含骨架/L0）或在途 foundKind 营者。 */
  private covered(sim: Sim, kind: BuildingKind): boolean {
    if (this.hasCamp(sim, kind, false)) return true;
    return sim.units.some((u) => u.team === this.team && u.kind === "walker" && u.foundKind === kind);
  }

  private maintainCamps(sim: Sim): void {
    const wanted = this.policy.wantedCamps(this.snapshot(sim));
    const t = sim.teams[this.team];
    let assigned = false;
    for (const kind of wanted) {
      if (!t.wanted.includes(kind)) t.wanted.push(kind);
      const l1 = this.hasCamp(sim, kind, true);
      if (!l1) {
        if (!this.missingL1.has(kind)) this.campCd[kind] = 0;
        this.missingL1.add(kind);
        if (!this.covered(sim, kind) && !assigned) {
          this.requestCamp(sim, kind);
          assigned = true;
        }
      } else {
        if (this.missingL1.has(kind)) this.campCd[kind] = 0;
        this.missingL1.delete(kind);
      }
    }
  }

  /**
   * v0.40 红方自修：自家破损 L1 建筑无人修时派自由村民（户外空闲优先，不动住户/建营者/在训/在修），
   * 走 sim.assignRepairers 同款身份（砍柴→扛木→开修全自动，木料规则与玩家完全一致）。
   * 玩家不管、AI 不管就永远瘸着——破损停机后这是必备补偿，否则红方被拆一座营就少一座营。
   */
  private maintainRepairs(sim: Sim): void {
    for (const b of sim.buildings) {
      if (b.team !== this.team || b.level < 1 || b.hp <= 0 || !b.shell) continue;
      const crew = sim.units.filter((u) => u.job === "repair" && u.repairId === b.id && u.hp > 0).length;
      if (crew >= REPAIR_CREW_MAX) continue;
      const hands = sim.units
        .filter(
          (u) =>
            u.team === this.team &&
            u.kind === "walker" &&
            u.hp > 0 &&
            u.homeId === 0 &&
            u.carry === 0 &&
            u.foundKind === null &&
            u.targetId === 0 &&
            u.job !== "train" &&
            u.job !== "repair" &&
            !sim.inSwamp(u),
        )
        .sort((a, c) => (a.x - b.x) ** 2 + (a.z - b.z) ** 2 - ((c.x - b.x) ** 2 + (c.z - b.z) ** 2))
        .slice(0, REPAIR_CREW_MAX - crew);
      if (!hands.length) continue;
      const n = sim.assignRepairers(this.team, b, hands);
      if (n > 0) logger.info("ai-train", `派 ${n} 名村民修理${b.kind}#${b.id}`, { team: this.team });
    }
  }

  private requestCamp(sim: Sim, kind: BuildingKind): void {    const founder = this.pickFounder(sim);
    if (!founder) {
      logger.throttled("ai-train:no-founder", 2000, LogLevel.Warn, "ai-train", `缺 ${kind} 但无可用建营者`, {
        team: this.team,
      });
      return;
    }
    sim.assignCampFounder(founder, kind);
    logger.info("ai-train", `派建营者#${founder.id} 落 ${kind}`, {
      foundKind: founder.foundKind,
      settleX: founder.settleX,
      settleZ: founder.settleZ,
    });
  }

  /**
   * 建营征召不看常备军硬顶、也不看劳动力保底。优先户外空闲村民；其次取消入住在途令；
   * 再无户外则 leaveBuilding 一名茅屋住户。
   */
  private pickFounder(sim: Sim): Unit | null {
    const busy = (u: Unit) => u.job === "train" || u.job === "haul" || u.job === "chop" || u.job === "repair";
    const outdoorIdle = sim.units.find(
      (u) =>
        u.team === this.team &&
        u.kind === "walker" &&
        u.hp > 0 &&
        u.homeId === 0 &&
        u.carry === 0 &&
        u.foundKind === null &&
        u.targetId === 0 &&
        !busy(u),
    );
    if (outdoorIdle) return outdoorIdle;
    const outdoorAssigned = sim.units.find(
      (u) =>
        u.team === this.team &&
        u.kind === "walker" &&
        u.hp > 0 &&
        u.homeId === 0 &&
        u.carry === 0 &&
        u.foundKind === null &&
        !busy(u),
    );
    if (outdoorAssigned) {
      outdoorAssigned.targetId = 0;
      return outdoorAssigned;
    }
    const dweller = sim.units.find(
      (u) => u.team === this.team && u.kind === "walker" && u.hp > 0 && u.homeId > 0 && u.foundKind === null,
    );
    if (dweller) {
      sim.leaveBuilding(dweller, "（建营征召）");
      return dweller;
    }
    return null;
  }

  /** 入住保底人数：每座活茅屋 min(occupyTarget, 容量)；无茅屋则按 occupyTarget 留人去盖新宅。 */
  private occupyNeed(sim: Sim): number {
    const huts = sim.buildings.filter(
      (b) => b.team === this.team && b.kind === "hut" && b.level >= 1 && b.hp > 0,
    );
    if (!huts.length) return this.profile.occupyTarget;
    let need = 0;
    for (const h of huts) need += Math.min(this.profile.occupyTarget, houseMaxPop(h.level));
    return need;
  }

  /** 某产线当前排队人数（含正在训的那名）。 */
  private queuedByKind(sim: Sim, kind: TrainKind): number {
    let n = 0;
    for (const u of sim.units) {
      if (u.team === this.team && u.kind === "walker" && u.hp > 0 && u.job === "train" && u.trainKind === kind) n++;
    }
    return n;
  }

  /**
   * v0.37 每营独立产线：武士营 / 牛战士营 / 神庙 / 间谍营各自排队出人。
   * 缺口来自 ArmyPolicy（随人口滚动的常备军配额 + 大龙计划的进厂牛战士名额）；
   * 三条闸门同时满足才开训：①该营冷却归零 ②排队未满 queueDepth ③征召后仍留 laborFloor
   * 名户外村民 + 入住/建营保底村民。任一条不满足就跳过，绝不用"训练成功"的假日志吃冷却。
   */
  private tryTrain(sim: Sim): void {
    const s = this.snapshot(sim);
    const occupyNeed = this.occupyNeed(sim);
    const fieldFull = this.army.atArmyCeiling(sim, this.team);
    const conscriptsWanted = this.army.dragonConscriptNeed(sim, this.team) > 0;
    const filling = !this.policy.floorsMet(s);
    const gaps: Array<[BuildingKind, TrainKind, number]> = [
      ["warriorHut", "warrior", this.army.warriorGap(sim, this.team)],
      ["fireHut", "firewarrior", this.army.firewarriorGap(sim, this.team)],
      ["temple", "preacher", this.policy.wantsPreacher(s) ? this.profile.preacherMax - s.preacher : 0],
      ["spyHut", "spy", this.policy.wantsSpy(s) ? this.profile.spyMax - s.spy : 0],
    ];
    for (const [campKind, kind, gap] of gaps) {
      if (gap <= 0) continue;
      if ((this.campCd[campKind] ?? 0) > 0) continue;
      if (!this.hasCamp(sim, campKind, true)) continue;
      // 特种线（神庙/间谍）按小配额 Trickle，不占常备军硬顶；武士/牛战士线受硬顶约束。
      // v0.37 例外：大龙计划还缺牛战士时，牛战士线不受硬顶阻挡——那些牛战士是喂工厂的
      // 消耗品（不进野战军编制），否则就会出现“工厂卡在 17/20、硬顶却已经满了”的死锁。
      const special = campKind === "temple" || campKind === "spyHut";
      const dragonFuel = kind === "firewarrior" && conscriptsWanted;
      if (!special && fieldFull && !dragonFuel && !filling) continue;
      const queued = this.queuedByKind(sim, kind);
      const room = Math.max(0, this.profile.queueDepth - queued);
      if (room <= 0) continue;
      const walkers = sim.countKind(this.team, "walker");
      const batch = Math.min(gap, room, this.policy.trainBatch(walkers, occupyNeed));
      if (batch <= 0) continue;
      // v0.37 兵源：优先户外空闲村民；人口到顶（茅屋停产）且户外没剩几人时，
      // 从茅屋拉一名住户入伍（leaveBuilding）——这就是“主动把大量村民转化为兵”的那一步。
      if (!this.ensureDraftable(sim, batch)) continue;
      const before = sim.units.filter((u) => u.team === this.team && u.hp > 0 && u.job === "train").length;
      const ok = sim.train(this.team, kind, batch);
      const sent = sim.units.filter((u) => u.team === this.team && u.hp > 0 && u.job === "train").length - before;
      if (!ok || sent <= 0) {
        logger.throttled("ai-train:fail", 2000, LogLevel.Warn, "ai-train", `训练 ${kind} 未送出人手`, {
          team: this.team,
          walkers,
          draftable: this.draftableOutside(sim),
          gap,
          queued,
        });
        continue;
      }
      this.campCd[campKind] = this.profile.trainGapSec;
      logger.info("ai-train", `训练 ${kind}×${sent}（${campKind}）`, {
        walkers,
        draftable: this.draftableOutside(sim),
        field: this.army.fieldForce(sim, this.team),
        committed: this.army.armyCommitted(sim, this.team),
        target: this.army.armyTarget(sim, this.team),
        gap,
        queued,
        dragonNeed: this.army.dragonConscriptNeed(sim, this.team),
      });
    }
  }

  /**
   * v0.37 兵源保障（两道门）：
   * ① **劳动力保底**看"户外村民总数"，不看"此刻空闲的村民数"：红方村民平日里就在砍树/搬运/
   *    走位，真正闲站着的往往只有 1 人——若按空闲数卡保底，会变成"全队都在干活所以永远不能
   *    征兵"的假饿死（实测 probe：工厂卡在 12/20、可征召 1 人、户外还有 20 人在干活）。
   * ② 保底不够时，若人口已到上限（茅屋本就在停产边缘）就动员一名住户入伍（leaveBuilding）。
   * ③ 最后要求真的能带走至少 1 人（sim.train 只会从空闲池里挑人）。
   */
  private ensureDraftable(sim: Sim, batch: number): boolean {
    const ok = () => this.draftableOutside(sim) >= 1 && this.outdoorWalkers(sim) - batch >= this.profile.laborFloor;
    if (ok()) return true;
    // 人口到顶（茅屋本就在停产边缘）+ 每座茅屋能留住 1 名住户 → 动员一名住户入伍。
    // 未到上限时 surplusDwellers 返回 0：那时住户还在产出新生儿，拉走他们是自断经济。
    if (this.army.surplusDwellers(sim, this.team) <= 0) return false;
    const dweller = sim.units.find(
      (u) => u.team === this.team && u.kind === "walker" && u.hp > 0 && u.homeId > 0 && u.foundKind === null,
    );
    if (!dweller) return false;
    sim.leaveBuilding(dweller, "（征召入伍）");
    logger.info("ai-train", `动员茅屋住户#${dweller.id} 入伍（人口已达上限 ${POP_CAP[this.team]}，茅屋停产）`, {
      team: this.team,
      outdoor: this.outdoorWalkers(sim),
      surplus: this.army.surplusDwellers(sim, this.team),
    });
    return ok();
  }

  /** 户外村民数（在读的学员也算），劳动力保底口径。 */
  private outdoorWalkers(sim: Sim): number {
    let n = 0;
    for (const u of sim.units) {
      if (u.team === this.team && u.kind === "walker" && u.hp > 0 && u.homeId === 0) n++;
    }
    return n;
  }

  /** 可征召的户外村民数（不含已在训的排队者）。 */
  private draftableOutside(sim: Sim): number {
    let n = 0;
    for (const u of sim.draftableWalkers(this.team)) {
      if (u.job !== "train") n++;
    }
    return n;
  }

  private watchdogFounders(sim: Sim): void {
    for (const [id, since] of this.founderSeen) {
      const u = sim.unitById(id);
      if (!u || u.foundKind === null) {
        this.founderSeen.delete(id);
        continue;
      }
      if (sim.time - since > 90) {
        logger.info("ai-train", `建营者#${id} 长期未落基，看门狗卸任`, { foundKind: u.foundKind });
        u.foundKind = null;
        this.founderSeen.delete(id);
      }
    }
    for (const u of sim.units) {
      if (u.team === this.team && u.kind === "walker" && u.foundKind !== null && !this.founderSeen.has(u.id)) {
        this.founderSeen.set(u.id, sim.time);
      }
    }
  }
}
