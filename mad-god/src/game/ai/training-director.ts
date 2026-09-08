// v0.34 敌方 AI：训兵子脑（营地维护 / 编制补缺 / 建营者看门狗）。
// 只通过 Sim 既有接口（assignCampFounder / train / leaveBuilding）下发意图，
// 不侵入移动/寻路/生产/雷电伤害。建营不要求村民盈余；训兵仍走 Sim.train。

import { LogLevel, logger } from "../logger";
import type { Sim } from "../sim";
import { BLUE, BuildingKind, CAMP_FOR, RED, Team, TrainKind, Unit } from "../types";
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
};

/**
 * 并行常备配额：武士营开局就要；武士营 L1 后立刻要火战士营（不等 2 名活武士）。
 * 常备下限独立补缺，战死不重跑兵种阶梯。神庙/间谍营只在下限达标后作为溢出。
 */
export class RosterPolicy {
  constructor(readonly profile: AIProfile) {}

  floorsMet(s: RosterSnapshot): boolean {
    return s.warrior >= this.profile.warriorMin && s.firewarrior >= this.profile.fireMin;
  }

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
    return wanted;
  }

  /**
   * 双缺口：较大缺口先补；平手优先牛战士（firewarrior）。
   * 无 L1 营地的兵种不进缺口（由 TrainingDirector 先派建营者）。
   */
  nextTrainKind(s: RosterSnapshot): TrainKind | null {
    const warGap = s.warriorHutL1 ? Math.max(0, this.profile.warriorMin - s.warrior) : 0;
    const fireGap = s.fireHutL1 ? Math.max(0, this.profile.fireMin - s.firewarrior) : 0;
    if (fireGap > 0 && fireGap >= warGap) return "firewarrior";
    if (warGap > 0) return "warrior";
    if (s.templeL1 && s.preacher < 1 && s.foeWalk >= 1) return "preacher";
    if (s.spyHutL1 && s.spy < 1) return "spy";
    if (s.templeL1 && s.preacher < 2 && s.foeWalk >= 2) return "preacher";
    if (s.fireHutL1 && s.firewarrior < s.warrior) return "firewarrior";
    if (s.warriorHutL1) return "warrior";
    if (s.fireHutL1) return "firewarrior";
    return null;
  }
}

export class TrainingDirector implements ITrainingDirector {
  readonly team: Team;
  readonly profile: AIProfile;
  readonly policy: RosterPolicy;

  private acc = 0;
  /** 训兵冷却：只在训成功后置 trainGapSec；缺营不拉长，重建到 L1 立刻清零。 */
  private trainCd = 0;
  /** 上一拍还缺 L1 的营地：从缺到齐的边沿把 trainCd 清零，避免雷电后空转。 */
  private missingL1 = new Set<BuildingKind>();
  /** v0.31.1 建营者看门狗：foundKind 超 90s 未落基则卸任。 */
  private founderSeen = new Map<number, number>();

  constructor(team: Team, profile: AIProfile) {
    this.team = team;
    this.profile = profile;
    this.policy = new RosterPolicy(profile);
  }

  update(sim: Sim, dt: number): void {
    this.trainCd = Math.max(0, this.trainCd - dt);
    if (sim.winner !== null) return;
    this.acc += dt;
    if (this.acc < this.profile.tickSec) return;
    this.acc = 0;
    this.watchdogFounders(sim);
    this.maintainCamps(sim);
    this.tryTrain(sim);
  }

  snapshot(sim: Sim): RosterSnapshot {
    const me = this.team;
    const foe: Team = me === RED ? BLUE : RED;
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
        if (!this.missingL1.has(kind)) this.trainCd = 0;
        this.missingL1.add(kind);
        if (!this.covered(sim, kind) && !assigned) {
          this.requestCamp(sim, kind);
          assigned = true;
        }
      } else {
        if (this.missingL1.has(kind)) this.trainCd = 0;
        this.missingL1.delete(kind);
      }
    }
  }

  private requestCamp(sim: Sim, kind: BuildingKind): void {
    const founder = this.pickFounder(sim);
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
   * 建营征召不看 armyCap+2。优先户外空闲村民；其次取消入住在途令；
   * 再无户外则 leaveBuilding 一名茅屋住户。
   */
  private pickFounder(sim: Sim): Unit | null {
    const busy = (u: Unit) => u.job === "train" || u.job === "haul" || u.job === "chop";
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

  private tryTrain(sim: Sim): void {
    if (this.trainCd > 0) return;
    const snap = this.snapshot(sim);
    const kind = this.policy.nextTrainKind(snap);
    if (!kind) return;
    const campKind = CAMP_FOR[kind];
    if (!this.hasCamp(sim, campKind, true)) return;
    const filling = this.policy.fillingFloor(snap, kind);
    const walkers = sim.countKind(this.team, "walker");
    if (!filling && walkers < this.profile.armyCap + 2) return;
    const soldiers = snap.warrior + snap.preacher + snap.firewarrior + snap.spy;
    if (!filling && soldiers >= this.profile.armyCap && kind === "warrior") return;
    const trainee = sim.units.find(
      (u) =>
        u.team === this.team &&
        u.kind === "walker" &&
        u.hp > 0 &&
        u.homeId === 0 &&
        u.carry === 0 &&
        u.job !== "train" &&
        u.foundKind === null,
    );
    if (!trainee) return;
    const maxWalkers = filling || kind !== "warrior" ? 2 : Math.max(0, this.profile.armyCap + 2 - soldiers);
    if (maxWalkers <= 0) return;
    const ok = sim.train(this.team, kind, maxWalkers);
    if (ok) {
      this.trainCd = this.profile.trainGapSec;
      logger.info("ai-train", `训练 ${kind}：村民#${trainee.id} 前往营地`, {
        walkers,
        army: soldiers,
        cap: this.profile.armyCap,
        filling,
      });
    } else {
      logger.throttled("ai-train:fail", 2000, LogLevel.Warn, "ai-train", `训练 ${kind} 失败：缺营或村民不可用`, {
        walkers,
        army: soldiers,
      });
    }
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
