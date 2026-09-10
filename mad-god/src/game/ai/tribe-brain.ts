// v0.17 敌方 AI：战略大脑——按 tickSec 周期驱动经济/训兵/军事/神力四个子脑，并迁移 发展→攒兵→进攻→重整 状态机。
// v0.37 追加第五个子脑（大龙计划）与"集结"状态：
//   发展 → 攒兵 → **集结** → 进攻 → 重整 → 循环
// 集结一节是"只派一两个、三个武士来骚扰"的正面回应：兵力攒到当前门槛后先把队伍在自家前沿
// 收紧（逐兵下发集结点 + 空闲士兵归入 gather 姿态），成型后才整队压上；没有门槛就绝不出门。
//
// 子脑调用顺序（v0.37 定序，勿随意调换）：
//   经济 → 训兵 → **大龙计划** → 军事 → 神力
// 大龙计划排在军事之前：同一条决策周期内，空闲牛战士先被工厂征召（targetId 指向厂），
// 军事子脑的驻塔/受袭池都要求 targetId===0，自然抢不到人——"工厂优先于哨塔"由顺序保证，
// 不靠两个子脑互相引用。

import type { Sim } from "../sim";
import type { Team } from "../types";
import { logger } from "../logger";
import type { AIProfile } from "./ai-profile";
import type { StrategicState } from "./types";
import { EconomyDirector } from "./economy-director";
import { TrainingDirector } from "./training-director";
import { WarDirector } from "./war-director";
import { SpellDirector } from "./spell-director";
import { DragonDirector } from "./dragon-director";
import { ArmyPolicy } from "./army-policy";

/** 重整状态持续时间（秒）：收兵回防、休整完毕后回到发展期 */
const REGROUP_SEC = 3;

export class TribeBrain {
  readonly team: Team;
  readonly profile: AIProfile;
  readonly economy: EconomyDirector;
  readonly training: TrainingDirector;
  readonly war: WarDirector;
  readonly spell: SpellDirector;
  /** v0.37 大龙计划子脑（建厂走训兵子脑的营地链路，本脑负责征召与出动） */
  readonly dragon: DragonDirector;

  /** 战略状态机当前态（公开，便于测试断言与调试观察） */
  state: StrategicState = "develop";

  /** 决策节流计时：累计到 profile.tickSec 才思考一次 */
  private acc = 0;
  /** 本波进攻发起时刻（游戏内时间），用于超时收兵判定 */
  private waveStartedAt = 0;
  /** 进入重整状态的时刻（游戏内时间），持续 REGROUP_SEC 后回发展 */
  private regroupAt = 0;

  constructor(team: Team, profile: AIProfile) {
    this.team = team;
    this.profile = profile;
    // v0.38 共享一份编制策略：编制目标/兵种配比/龙账本只有一个来源，
    // 否则训兵/军事/大龙三个子脑各自 new 一份 → 龙账本与征召名额互不相通。
    const army = new ArmyPolicy(profile);
    this.economy = new EconomyDirector(team, profile);
    this.training = new TrainingDirector(team, profile, army);
    this.war = new WarDirector(team, profile, army);
    this.spell = new SpellDirector(team, profile);
    this.dragon = new DragonDirector(team, profile, army);
  }

  /** 每帧驱动：到决策周期才让子脑思考一次，并推进战略状态机。 */
  update(sim: Sim, dt: number): void {
    this.acc += dt;
    if (this.acc < this.profile.tickSec) return;
    this.acc = 0;

    // 子脑并行推进：经济（入住/平地）、训兵（建营/编制）、大龙（征召/出动）、
    // 军事（集结/波次与防御）、神力（施法）。顺序见文件头（大龙先于军事抢牛战士）。
    // 注意传完整决策周期而非单帧 dt：子脑内部还有自己的 acc 节流，传单帧会让决策周期被拉长 20 倍。
    this.economy.update(sim, this.profile.tickSec);
    this.training.update(sim, this.profile.tickSec);
    this.dragon.update(sim, this.profile.tickSec);
    this.war.update(sim, this.profile.tickSec);
    this.spell.update(sim, this.profile.tickSec);

    const prev = this.state;
    switch (this.state) {
      case "develop":
        // 守家姿态：士兵在自家聚落待命，新训成的兵不再各自冲向敌区送命。
        this.war.hold(sim);
        // 经济健康（入住率与人口达标）后才允许攒兵，避免只出兵饿死经济。
        if (this.economy.economyScore(sim) >= 0.6) this.state = "growArmy";
        break;
      case "growArmy":
        this.war.hold(sim);
        // 兵力攒到当前门槛（waveForce，惨败后加码）才进入集结。
        if (this.war.waveReady(sim)) this.state = "marshal";
        break;
      case "marshal":
        // 集结：锚点前移到前沿，整队在集结点收紧。
        this.war.marshal(sim);
        if (this.war.gathered(sim)) {
          if (this.war.launchWave(sim)) {
            this.state = "attack";
            this.waveStartedAt = sim.time;
          } else if (this.war.marshalStalled(sim)) {
            // 集结超时仍发不出去（隔海无路 / 敌方已无目标）：回重整重新滚经济。
            this.state = "regroup";
            this.regroupAt = sim.time;
          }
        }
        break;
      case "attack":
        // 波次进行中：焦点被拆就往下一个敌方密集点续压；战损过半/超时/老家告急则收兵。
        this.war.commandWave(sim);
        if (this.war.shouldRecall(sim)) {
          this.war.recall(sim);
          this.state = "regroup";
          this.regroupAt = sim.time;
        }
        break;
      case "regroup":
        // 重整固定休整 3 秒，回到发展期重新滚经济攒兵。
        this.war.hold(sim);
        if (sim.time - this.regroupAt >= REGROUP_SEC) this.state = "develop";
        break;
    }
    if (this.state !== prev) {
      logger.info("ai-brain", `部落${this.team} 状态 ${prev}→${this.state}`, {
        army: this.war.armySize(sim),
        ready: this.war.readyForce(sim),
        threshold: this.war.waveThreshold,
        eco: this.economy.economyScore(sim).toFixed(2),
        // v0.37 便于从日志复盘大龙计划进度（0 表示本档不追龙/未启动）
        dragon: this.dragon.dragonCount(sim),
        conscripts: this.dragon.conscriptNeed(sim),
      });
    }
  }

  /** 被袭防御响应：不进状态机，直接转发给军事子脑按 reactSec 延迟就近反击。 */
  onHurt(sim: Sim, x: number, z: number): void {
    this.war.onHurt(sim, x, z);
  }
}
