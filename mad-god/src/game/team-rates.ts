// v0.27-1 敌方数值削弱 Wrapper：队伍级仿真速率集中于此。
// 用户要求"敌人生产/魔法充能整体比玩家低 25%，且不逐个手改参数、可复用"——
// 所有"红蓝本应同价"的速率都从这里取系数：以后调难度/加 AI 队伍只改 profiles，
// 仿真代码里统一 `sim.rates.of(team).xxx` 一处乘法，不再散落魔法数字。
// 注意与 AIProfile 的分工：AIProfile 管 AI 决策节奏（多久想一次、多久训一波），
// TeamRates 管仿真速率（同样想训，红方就是走得慢）。两层正交，调难度各改各的。

import { BLUE, RED, Team } from "./types";

export class TeamRates {
  /** 茅屋村民生产速率系数。 */
  constructor(
    readonly prod = 1,
    /** 技能充能速率系数。 */
    readonly charge = 1,
    /** 训兵速度系数（channel 增速）。 */
    readonly train = 1,
  ) {}
}

export class RateBook {
  profiles: Record<Team, TeamRates>;

  constructor(profiles?: Record<Team, TeamRates>) {
    this.profiles = profiles ?? {
      [BLUE]: new TeamRates(), // 玩家：基准 1.0
      [RED]: new TeamRates(0.75, 0.75, 0.75), // 敌方：整体削弱 25%
    };
  }

  of(team: Team): TeamRates {
    return this.profiles[team];
  }
}
