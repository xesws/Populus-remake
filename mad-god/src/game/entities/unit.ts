import { BaseEntity } from "./entity";
import { BuildingKind, Job, Order, Owner, Team, TrainKind, UnitKind, Waypoint } from "../types";

export abstract class Unit extends BaseEntity {
  kind!: UnitKind;

  yaw = 0;
  str = 1;
  order: Order = "settle";
  path: Waypoint[] = [];
  pathI = 0;
  think = 0;
  atkCd = 0;
  selected = false;
  phase: number = Math.random() * Math.PI * 2;
  settleT = 0;
  settleX = -1;
  settleZ = -1;
  settleYaw = 0;
  moveX = -1;
  moveZ = -1;
  ghostT = 0;
  channel = 0;
  channelId = 0;
  disguise: Team | null = null;
  carry: 0 | 1 = 0;
  job: Job = "idle";
  targetId = 0;
  atkId = 0;
  homeId = 0;
  trainKind: TrainKind | null = null;
  foundKind: BuildingKind | null = null;
  swampT = 0;
  fireT = 0;
  // v0.26 火球着火的持续伤害：burnT 剩余秒数，burnDps 每秒伤害。
  // 独立于 fireT（后者只是岩浆/闪电的视觉火焰），避免与岩浆 26/s 叠加。
  burnT = 0;
  burnDps = 0;
  flyVx = 0;
  flyVz = 0;
  flyVy = 0;
  enterT = 0;
  // v0.8 自动索敌/还手：获得目标时记录的锚点；-1 表示当前 atkId 来自玩家手动指令（不受拴绳限制）。
  agroX = -1;
  agroZ = -1;
  // v0.9 击飞落地伤害：击飞来源（火球）在击飞时写入，落地结算后清零；法术击飞保持 0 不受影响。
  flyDmg = 0;
  // v0.12 倒地与暴击：被火球默认击中后倒下（downT 倒计时），站起瞬间经伤害入口结算 downDmg；
  // flyKill = 暴击击飞标记，落地直接死亡（法术击飞恒为 false）。
  downT = 0;
  downDmg = 0;
  flyKill = false;
  // v0.10 建工指派：assignBuilders 写入的在建工地 id；工地完工/损毁自动失效。蓝方待机豁免依赖它。
  buildId = 0;
  // v0.28e 爬塔动画：tryGarrison 记录的塔脚起点（tickEnter 按 enterT 线性爬到瞭望台）。
  climbX = 0;
  climbY = 0;
  climbZ = 0;

  constructor(id: number, team: Owner, x: number, z: number, y: number, hp: number, maxHp = hp, str = 1) {
    super(id, team, x, z, y, hp, maxHp);
    this.str = str;
  }

  isSoldier(): boolean {
    return false;
  }

  canConvert(): boolean {
    return true;
  }
}
