// v0.17 敌方 AI：战略大脑——按 tickSec 周期驱动经济/军事/神力三个子脑，并迁移 发展→攒兵→进攻→重整 状态机。
import type { Sim } from "../sim";
import type { Team } from "../types";
import { logger } from "../logger";
import type { AIProfile } from "./ai-profile";
import type { StrategicState } from "./types";
import { EconomyDirector } from "./economy-director";
import { WarDirector } from "./war-director";
import { SpellDirector } from "./spell-director";

/** 重整状态持续时间（秒）：收兵回防、休整完毕后回到发展期 */
const REGROUP_SEC = 3;

export class TribeBrain {
  readonly team: Team;
  readonly profile: AIProfile;
  readonly economy: EconomyDirector;
  readonly war: WarDirector;
  readonly spell: SpellDirector;

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
    this.economy = new EconomyDirector(team, profile);
    this.war = new WarDirector(team, profile);
    this.spell = new SpellDirector(team, profile);
  }

  /** 每帧驱动：到决策周期才让三个子脑思考一次，并推进战略状态机。 */
  update(sim: Sim, dt: number): void {
    this.acc += dt;
    if (this.acc < this.profile.tickSec) return;
    this.acc = 0;

    // 三个子脑并行推进：经济（入住/训兵/平地）、军事（波次与防御）、神力（施法）。
    // 注意传完整决策周期而非单帧 dt：子脑内部还有自己的 acc 节流，传单帧会让决策周期被拉长 20 倍。
    this.economy.update(sim, this.profile.tickSec);
    this.war.update(sim, this.profile.tickSec);
    this.spell.update(sim, this.profile.tickSec);

    const prev = this.state;
    switch (this.state) {
      case "develop":
        // 经济健康（入住率与人口达标）后才允许攒兵，避免只出兵饿死经济。
        if (this.economy.economyScore(sim) >= 0.6) this.state = "growArmy";
        break;
      case "growArmy":
        // 波次就绪（兵力够 + 距上波冷却到）就发波；launchWave 成功才算真正进入进攻态。
        if (this.war.waveReady(sim) && this.war.launchWave(sim)) {
          this.state = "attack";
          this.waveStartedAt = sim.time;
        }
        break;
      case "attack":
        // 兵力被打残到不足半波，或打了 45 秒还拿不下，就收兵回防重整。
        if (
          this.war.armySize(sim) < Math.ceil(this.profile.waveSize / 2) ||
          sim.time - this.waveStartedAt > 45
        ) {
          this.war.recall(sim);
          this.state = "regroup";
          this.regroupAt = sim.time;
        }
        break;
      case "regroup":
        // 重整固定休整 3 秒，回到发展期重新滚经济攒兵。
        if (sim.time - this.regroupAt >= REGROUP_SEC) this.state = "develop";
        break;
    }
    if (this.state !== prev) {
      logger.info("ai-brain", `部落${this.team} 状态 ${prev}→${this.state}`, {
        army: this.war.armySize(sim),
        eco: this.economy.economyScore(sim).toFixed(2),
      });
    }
  }

  /** 被袭防御响应：不进状态机，直接转发给军事子脑按 reactSec 延迟就近反击。 */
  onHurt(sim: Sim, x: number, z: number): void {
    this.war.onHurt(sim, x, z);
  }
}
