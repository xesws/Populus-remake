import {
  BLUE,
  BOAT_BOARD_RANGE,
  BOAT_CAPACITY,
  BOAT_DOCK_RANGE,
  BOAT_FLOAT_Y,
  Cell,
  isTribe,
  SINK_T,
  Team,
  Unit,
} from "../types";
import { nearestLand, nearestWater, waterAstar, waterAt } from "../path";
import type { Sim } from "../sim";
import type { ISystem } from "./system";
import type { World } from "../world";
import { logger } from "../logger";

/**
 * v0.32 船指令最小视图（本地真 Sim 与 worker 镜像客户端的结构交集）：
 * BoatSystem 的公开方法只依赖这四个成员，因此 game.ts 可以用同一套调用
 * 同时驱动本地模式（真 Sim）与 worker 模式（WorkerBoatSystem 发命令＋读镜像）。
 * 唯 tryBoard 例外：它只跑在 sim 内部 thinkUnits，需要真 Sim，签名保留 Sim。
 */
export interface BoatClient {
  readonly units: Unit[];
  readonly world: World;
  toast(msg: string): void;
  sendMove(u: Unit, x: number, z: number): void;
}

/**
 * v0.32 战船系统（两栖载具唯一归属，DragonSystem 同款独占制）：
 * - 上船：选中陆地单位右键自家船（game.secondary 分流到 orderBoard），走到船边
 *   可走岸点后 thinkUnits 经 tryBoard 自动上船（tryOccupy/tryGarrison 同款
 *   "targetId＋到站"模式，不新增单位字段）；
 * - 船员 homeId 挂船 id：不可点选/不可索敌/不吃陆地指派（既有 homeId 口径全覆盖），
 *   坐标每帧钉甲板槽位，开火走 CombatSystem.boatCombat 独立通道；
 * - 航行：sendSail 经 waterAstar 写 u.path，跟随走 PathSystem.moveBoat；
 * - 沉没：hp 归零置 sinkT（cull 让路），2s 动画后处决船员，cull 同批带走。
 */
export class BoatSystem implements ISystem {
  update(sim: BoatClient, dt: number): void {
    this.tick(sim, dt);
  }

  tick(sim: BoatClient, dt: number): void {
    this.tickSink(sim, dt);
    this.syncRiders(sim);
    this.separateBoats(sim);
  }

  /** 船上活人（homeId 挂该船 id）。 */
  riders(sim: BoatClient, boatId: number): Unit[] {
    return sim.units.filter((u) => u.hp > 0 && u.homeId === boatId);
  }

  /** 船边最近可走岸（DOCK_RANGE 内，否则 null＝离岸太远）。 */
  shoreNear(sim: BoatClient, x: number, z: number, range = BOAT_DOCK_RANGE): Cell | null {
    const shore = nearestLand(sim.world, x, z);
    if (!shore) return null;
    if ((shore.x - x) ** 2 + (shore.z - z) ** 2 > range * range) return null;
    return shore;
  }

  /** 上船合法性（光标态与到站判定同源，见 game.ts boatCursorFor）。 */
  canBoard(sim: BoatClient, boat: Unit, u: Unit): boolean {
    if (boat.hp <= 0 || boat.sinkT > 0) return false;
    if (!isTribe(u.team) || u.team !== boat.team) return false;
    if (u.kind === "boat" || u.kind === "dragon") return false;
    if (u.isFlying()) return false;
    if (u.homeId > 0) return false;
    if (this.riders(sim, boat.id).length >= BOAT_CAPACITY) return false;
    if ((u.x - boat.x) ** 2 + (u.z - boat.z) ** 2 > BOAT_BOARD_RANGE * BOAT_BOARD_RANGE) return false;
    if (!this.shoreNear(sim, boat.x, boat.z)) return false;
    return true;
  }

  /**
   * 玩家下令上船：单位走到船边可走岸点（陆地 astar，sendMove），targetId 挂船，
   * 到站由 thinkUnits 经 tryBoard 收尾。
   */
  orderBoard(sim: BoatClient, boat: Unit, u: Unit): void {
    const shore = this.shoreNear(sim, boat.x, boat.z);
    if (!shore || this.riders(sim, boat.id).length >= BOAT_CAPACITY) return;
    // 朝船方向最近的岸点：人从陆地上船，不游泳。
    sim.sendMove(u, shore.x, shore.z);
    u.targetId = boat.id;
    u.atkId = 0;
  }

  /** thinkUnits 到站收尾（tryGarrison 同款）：合法即上船，否则放行走后续逻辑。 */
  tryBoard(sim: Sim, u: Unit): boolean {
    if (!u.targetId || u.homeId > 0) return false;
    const boat = sim.unitById(u.targetId);
    if (!boat || boat.kind !== "boat" || boat.hp <= 0 || boat.team !== u.team) return false;
    if (!this.canBoard(sim, boat, u)) return false;
    u.homeId = boat.id;
    u.selected = false;
    u.path = [];
    u.pathI = 0;
    u.job = "idle";
    u.think = 99; // 冻住陆地 AI（住户同规）；开火走 boatCombat 通道，不受 think 影响
    u.targetId = 0;
    u.atkId = 0;
    u.carry = 0; // 上船卸木（入住茅屋同规：occupy 清 carry）
    u.enterT = 0;
    u.swampT = 0; // 上船清沼泽计时（水面跳过沼泽分支，上岸重计，防陈旧计时误杀）
    const n = this.riders(sim, boat.id).length;
    if (u.team === BLUE) sim.toast(`登船（${n}/${BOAT_CAPACITY}）`);
    logger.info("boat", `单位#${u.id}(${u.kind}) 登船#${boat.id}`, { team: u.team, aboard: n });
    return true;
  }

  /**
   * 玩家开船：右键水面直航；右键陆地/岸＝先开到最近水格贴岸（第二下右键再下船，
   * 无需 pending 状态，两下右键天然就是"开过去＋下船"）。
   */
  sendSail(sim: BoatClient, boat: Unit, x: number, z: number): boolean {
    if (boat.hp <= 0 || boat.sinkT > 0) return false;
    let dest = waterAt(sim.world, x, z) ? { x, z } : nearestWater(sim.world, x, z);
    if (!dest) {
      if (boat.team === BLUE) sim.toast("四面环陆，无处可去");
      return false;
    }
    const path = waterAstar(sim.world, boat.x, boat.z, dest.x, dest.z, 20736, 0);
    if (!path.length) {
      if (boat.team === BLUE) sim.toast("去不了");
      return false;
    }
    // v0.32 断水拒航：waterAstar 到不了目标格会回退部分路径（与陆地 astar 同构）——
    // 陆地单位走一段算一段（think 节流自动续），船过不去就是过不去（海被陆桥切断），
    // 开出去再停半道不如原地待命。成功时 rebuild 末点精确等于目标，gap>0 即部分路径。
    const end = path[path.length - 1]!;
    if ((end.x - dest.x) ** 2 + (end.z - dest.z) ** 2 > 0.01) {
      if (boat.team === BLUE) sim.toast("去不了（水路不通）");
      return false;
    }
    boat.path = path;
    boat.pathI = 0;
    boat.yaw = Math.atan2(path[0]!.x - boat.x, path[0]!.z - boat.z);
    // 玩家航行令：thinkUnits 免打扰（sendMove 同规 think=40＋job=move），
    // 否则船会被当成闲置村民劫进定居管线、路径被陆地 astar 覆盖。到站后 job 回 idle。
    boat.job = "move";
    boat.think = 40;
    return true;
  }

  /** 下船合法性（光标态同源）。 */
  canDisembark(sim: BoatClient, boat: Unit): boolean {
    if (boat.hp <= 0 || boat.sinkT > 0) return false;
    if (!this.riders(sim, boat.id).length) return false;
    return this.shoreNear(sim, boat.x, boat.z) !== null;
  }

  /**
   * 全员下船：落点绕最近可走岸点螺旋找可走格，船员逐个落定并恢复自由
   * （homeId＝0、可选中可指派；spec 原话"恢复自由可选状态"）。
   */
  disembarkAll(sim: BoatClient, boat: Unit): boolean {
    const riders = this.riders(sim, boat.id);
    if (!riders.length) return false;
    const shore = this.shoreNear(sim, boat.x, boat.z);
    if (!shore) {
      if (boat.team === BLUE) sim.toast("离岸太远，下不了船");
      return false;
    }
    const spots: Cell[] = [];
    for (let r = 0.5; r <= 4 && spots.length < riders.length; r += 0.5) {
      const steps = Math.max(8, Math.ceil(r * 10));
      for (let k = 0; k < steps && spots.length < riders.length; k++) {
        const a = (k / steps) * Math.PI * 2;
        const x = shore.x + Math.cos(a) * r;
        const z = shore.z + Math.sin(a) * r;
        if (sim.world.walkableAt(x, z)) spots.push({ x, z });
      }
    }
    riders.forEach((u, i) => {
      const s = spots.length ? spots[i % spots.length]! : shore;
      u.homeId = 0;
      u.think = 0;
      u.job = "idle";
      u.path = [];
      u.pathI = 0;
      u.targetId = 0;
      u.atkId = 0;
      u.swampT = 0; // 下船清沼泽计时（与上船对称）
      u.x = s.x;
      u.z = s.z;
      u.y = sim.world.heightAt(s.x, s.z);
    });
    boat.path = [];
    boat.pathI = 0;
    if (boat.team === BLUE) sim.toast(`${riders.length} 人下船`);
    logger.info("boat", `船#${boat.id} 下船 ${riders.length} 人`, { team: boat.team });
    return true;
  }

  /** 船员钉甲板：6 槽位（2×3），随船 yaw 旋转，y＝甲板线。 */
  syncRiders(sim: BoatClient): void {
    for (const b of sim.units) {
      if (b.kind !== "boat" || b.hp <= 0) continue;
      const riders = this.riders(sim, b.id);
      for (let i = 0; i < riders.length; i++) {
        const u = riders[i]!;
        const col = i % 2;
        const row = (i / 2) | 0;
        const lx = (col - 0.5) * 0.55;
        const lz = (row - 1) * 0.5;
        const c = Math.cos(b.yaw);
        const s = Math.sin(b.yaw);
        u.x = b.x + lx * c + lz * s;
        u.z = b.z - lx * s + lz * c;
        u.y = b.y + 0.35;
        u.yaw = b.yaw;
      }
    }
  }

  /** 船船小圆分离（同队贴太近推开；船少，O(n²) 足够）。 */
  separateBoats(sim: BoatClient): void {
    const boats = sim.units.filter((u) => u.kind === "boat" && u.hp > 0);
    for (let i = 0; i < boats.length; i++) {
      for (let j = i + 1; j < boats.length; j++) {
        const a = boats[i]!;
        const b = boats[j]!;
        const dx = b.x - a.x;
        const dz = b.z - a.z;
        const d2 = dx * dx + dz * dz;
        if (d2 >= 1.6 * 1.6 || d2 < 1e-6) continue;
        const d = Math.sqrt(d2);
        const push = ((1.6 - d) / d) * 0.5;
        a.x -= dx * push * 0.5;
        a.z -= dz * push * 0.5;
        b.x += dx * push * 0.5;
        b.z += dz * push * 0.5;
      }
    }
  }

  /**
   * 沉没推进：hp 归零首帧开沉（锁控＋涟漪），SINK_T 走完处决船员，
   * cull 下帧同批带走（cull 为 sinkT>0 让路，见 Sim.cull 守卫）。
   */
  tickSink(sim: BoatClient, dt: number): void {
    for (const b of sim.units) {
      if (b.kind !== "boat" || b.hp > 0) continue;
      if (b.sinkT <= 0) {
        b.sinkT = SINK_T;
        b.path = [];
        b.pathI = 0;
        b.selected = false;
        // 白色涟漪由渲染端按hp归零且仍在场自行推导触发（主线程/镜像通用，不走fxSplash岩浆通道，见 View.syncSinkRipples）。
        if (b.team === BLUE) sim.toast("战船沉没");
        logger.info("boat", `船#${b.id} 开始沉没`, { team: b.team });
        continue;
      }
      b.sinkT = Math.max(0, b.sinkT - dt);
      if (b.sinkT > 0) continue;
      const riders = this.riders(sim, b.id);
      for (const u of riders) {
        u.hp = 0; // spec 原话：沉没后上面的单位全部阵亡
        u.homeId = 0; // 落水不等复活：cull 住户分支只认建筑 id，船员先摘防止 dwell 误扣
      }
      if (riders.length && b.team === BLUE) sim.toast(`${riders.length} 人随船殉难`);
      logger.info("boat", `船#${b.id} 沉没，${riders.length} 人阵亡`, { team: b.team });
    }
  }
}
