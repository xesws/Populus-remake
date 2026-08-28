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
  flyVx = 0;
  flyVz = 0;
  flyVy = 0;
  enterT = 0;
  // v0.8 自动索敌/还手：获得目标时记录的锚点；-1 表示当前 atkId 来自玩家手动指令（不受拴绳限制）。
  agroX = -1;
  agroZ = -1;

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
