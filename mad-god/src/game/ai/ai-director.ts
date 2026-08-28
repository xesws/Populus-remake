// v0.17 敌方 AI：全局指挥层——按 (team, profile) 建部落大脑，接线 sim.onTeamHurt 防御钩子并逐帧驱动。
import type { Sim } from "../sim";
import type { Team } from "../types";
import type { AIProfile } from "./ai-profile";
import type { TeamHurtHook } from "./types";
import { TribeBrain } from "./tribe-brain";

export class AIDirector {
  /** 所有参战部落的大脑（目前只挂敌方 RED，按数组设计便于将来扩展多 AI 队） */
  readonly brains: TribeBrain[] = [];

  constructor(entries: Array<[team: Team, profile: AIProfile]>) {
    for (const [team, profile] of entries) {
      this.brains.push(new TribeBrain(team, profile));
    }
  }

  /** 接线：把 sim.onTeamHurt 钩子按 team 分发到对应部落的防御响应（无大脑的队自动忽略）。 */
  attach(sim: Sim): void {
    const hook: TeamHurtHook = (team, x, z) => {
      this.brains.find((b) => b.team === team)?.onHurt(sim, x, z);
    };
    sim.onTeamHurt = hook;
  }

  /** 每帧驱动：胜负未分时逐部落思考。 */
  update(sim: Sim, dt: number): void {
    if (sim.winner !== null) return;
    for (const b of this.brains) b.update(sim, dt);
  }
}
