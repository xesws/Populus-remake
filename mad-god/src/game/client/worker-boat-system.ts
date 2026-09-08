import { BoatSystem, type BoatClient } from "../systems/boat-system";
import type { Unit } from "../types";
import type { WorkerSimClient } from "./worker-sim-client";

/**
 * v0.32 worker 模式船指令扇出（BoatSystem 同形子类，主线程侧）：
 * - 动作（orderBoard/sendSail/disembarkAll）：发 MainCmd，worker 侧真 Sim 落
 *   sim.boatSystem 同名真方法（权威态只在 worker 内变，主线程不等回执）；
 * - 查询（riders/shoreNear/canBoard/canDisembark/syncRiders/separateBoats/tickSink）：
 *   继承基类实现，只读本机镜像（units/world 只读，BoatClient 签名天然满足）；
 * - tryBoard 永不跑在主线程（只在 thinkUnits 内），不重写。
 */
export class WorkerBoatSystem extends BoatSystem {
  constructor(private readonly client: WorkerSimClient) {
    super();
  }

  override orderBoard(_sim: BoatClient, boat: Unit, u: Unit): void {
    this.client.sendBoard(boat.id, [u.id]);
  }

  override sendSail(_sim: BoatClient, boat: Unit, x: number, z: number): boolean {
    this.client.sendSail([boat.id], x, z);
    return true;
  }

  override disembarkAll(_sim: BoatClient, boat: Unit): boolean {
    this.client.sendDisembark([boat.id]);
    return true;
  }
}
