import { astar, nearestLand } from "../path";
import { Building, BuildingKind, CAMP_FOR, dist2, isCampKind, isTribe, padSize, Team, TRAIN_FOR_CAMP, TRAIN_TIME, TrainKind, Unit, unitHp } from "../types";
import { inPad, Pad } from "../world";
import type { Sim } from "../sim";
import type { ISystem } from "./system";

const TRAIN_DONE: Record<TrainKind, string> = {
  warrior: "一名勇士成为武士",
  preacher: "一名勇士成为传教士",
  firewarrior: "一名勇士成为火战士",
  spy: "一名勇士成为间谍",
};

export class TrainingSystem implements ISystem {
  update(_sim: Sim, _dt: number): void {
    // Training steps are invoked per unit during thinkUnits / advanceTrain
  }

  sendWalkerToCamp(sim: Sim, u: Unit, camp: Building, kind: TrainKind): void {
    u.job = "train";
    u.trainKind = kind;
    u.targetId = camp.id;
    u.repairId = 0; // v0.40 训兵即卸任修理工（训练营门口不留兼职）
    u.atkId = 0;
    u.carry = 0;
    u.channel = 0;
    u.channelId = sim.trainJoinN++;
    u.path = [];
    u.pathI = 0;
    u.think = 0;
    const q = this.trainQueue(sim, camp.id);
    const slot = Math.max(0, q.findIndex((o) => o.id === u.id));
    this.pathToSlot(sim, u, this.trainSlotPos(sim, camp, slot));
  }

  trainDoor(camp: Building): { x: number; z: number; fx: number; fz: number } {
    const fx = -Math.sin(camp.yaw);
    const fz = Math.cos(camp.yaw);
    const dist = camp.padD / 2 + 0.12;
    return { x: camp.x + fx * dist, z: camp.z + fz * dist, fx, fz };
  }

  snapTrainSlot(sim: Sim, camp: Building, raw: { x: number; z: number }): { x: number; z: number } {
    const pad = sim.buildingPad(camp);
    if (sim.trueRim(raw.x, raw.z, pad)) return raw;
    const edge = sim.padEdge(camp.x, camp.z, camp.padW, camp.padD, camp.yaw, raw.x, raw.z);
    if (sim.trueRim(edge.x, edge.z, pad)) return edge;
    const rim = sim.nearestRim(pad, 0.62, raw.x, raw.z);
    if (rim) return rim;
    const safe = nearestLand(sim.world, raw.x, raw.z);
    return safe ?? edge;
  }

  trainSlotPos(sim: Sim, camp: Building, slot: number): { x: number; z: number } {
    const inflate = 0.62;
    if (slot <= 0) {
      const doorRim = sim.padLocalToWorld(camp, 0, camp.padD / 2 + inflate);
      return this.snapTrainSlot(sim, camp, doorRim);
    }
    const hw = camp.padW / 2 + inflate;
    const hd = camp.padD / 2 + inflate;
    const segs: Array<[[number, number], [number, number]]> = [
      [[0, hd], [-hw, hd]],
      [[-hw, hd], [-hw, -hd]],
      [[-hw, -hd], [hw, -hd]],
      [[hw, -hd], [hw, hd]],
      [[hw, hd], [0, hd]],
    ];
    let remain = Math.max(0, slot) * 0.7;
    const loop = 4 * (hw + hd);
    if (loop > 0.01) remain = remain % loop;
    let lx = 0;
    let lz = hd;
    for (const [a, b] of segs) {
      const dx = b[0] - a[0];
      const dz = b[1] - a[1];
      const len = Math.hypot(dx, dz);
      if (remain <= len) {
        const t = len < 1e-6 ? 0 : remain / len;
        lx = a[0] + dx * t;
        lz = a[1] + dz * t;
        break;
      }
      remain -= len;
      lx = b[0];
      lz = b[1];
    }
    return this.snapTrainSlot(sim, camp, sim.padLocalToWorld(camp, lx, lz));
  }

  trainQueue(sim: Sim, campId: number): Unit[] {
    return sim.units
      .filter((u) => u.job === "train" && u.targetId === campId)
      .sort((a, b) => a.channelId - b.channelId || a.id - b.id);
  }

  walkableTrainDest(sim: Sim, u: Unit, dest: { x: number; z: number }): { x: number; z: number } {
    if (sim.world.walkableAt(dest.x, dest.z)) return dest;
    const camp = sim.buildingById(u.targetId);
    if (camp) {
      const edge = sim.padEdge(camp.x, camp.z, camp.padW, camp.padD, camp.yaw, dest.x, dest.z);
      if (sim.world.walkableAt(edge.x, edge.z)) return edge;
    }
    return nearestLand(sim.world, dest.x, dest.z) ?? dest;
  }

  pathToSlot(sim: Sim, u: Unit, dest: { x: number; z: number }): void {
    const d = this.walkableTrainDest(sim, u, dest);
    const last = u.path.length ? u.path[u.path.length - 1] : null;
    if (last && dist2(last.x, last.z, d.x, d.z) <= 0.16) return;
    u.path = astar(sim.world, u.x, u.z, d.x, d.z);
    if (!u.path.length) {
      const safe = sim.world.walkableAt(d.x, d.z) ? d : nearestLand(sim.world, d.x, d.z);
      u.path = safe ? [safe] : [];
    }
    u.pathI = 0;
  }

  advanceTrain(sim: Sim, u: Unit, dt: number): boolean {
    // v0.40 破损停机：营在训途中被打成骨架 → 当场释放排队者（修好后可重训）。
    const camp = sim.buildings.find((b) => b.id === u.targetId && b.hp > 0 && b.level >= 1 && !b.shell);
    if (!camp || !u.trainKind) {
      u.job = "idle";
      u.trainKind = null;
      u.channel = 0;
      u.targetId = 0;
      return false;
    }
    const queue = this.trainQueue(sim, camp.id);
    let slot = queue.findIndex((o) => o.id === u.id);
    if (slot < 0) slot = queue.length;
    const dest = this.trainSlotPos(sim, camp, slot);
    if (dist2(u.x, u.z, dest.x, dest.z) > 0.18 * 0.18) {
      this.pathToSlot(sim, u, dest);
      return true;
    }
    u.path = [];
    u.pathI = 0;
    u.x = dest.x;
    u.z = dest.z;
    u.y = sim.world.heightAt(u.x, u.z);
    u.yaw = Math.atan2(camp.x - u.x, camp.z - u.z);
    if (slot === 0) {
      // v0.27-1 队伍系数（敌方削弱 Wrapper）：红方训兵整体慢 25%。
      u.channel += dt * sim.rates.of(u.team as Team).train;
      if (u.channel >= TRAIN_TIME) this.finishTrain(sim, u, camp);
    } else {
      u.channel = 0;
    }
    return true;
  }

  finishTrain(sim: Sim, u: Unit, camp: Building): void {
    const kind = u.trainKind!;
    u.kind = kind;
    u.str = Math.max(u.str, 1);
    u.hp = u.maxHp = unitHp(kind, u.str);
    u.order = kind === "spy" ? sim.teams[u.team as Team].order : "fight";
    u.job = "idle";
    u.trainKind = null;
    u.channel = 0;
    u.channelId = 0;
    u.carry = 0;
    u.targetId = 0;
    u.buildId = 0; // v0.38：buildId 已从 clearOrders 移出（建工身份粘性），训成士兵时显式卸任
    u.disguise = kind === "spy" ? null : u.disguise;
    // v0.28c 训成出营散开：旧实现只偏到门口旁 0.8 格，新兵堆在门口堵住训练排队。
    // 现在与茅屋出生同款：弹到营地外 2~3 格的开阔点（随机偏移避免连训的新兵叠同一点），
    // 再交给 order（fight / 团队令）接管。
    let out = sim.padLocalToWorld(camp, (Math.random() - 0.5) * 2.4, camp.padD / 2 + 2.2 + Math.random() * 1.0);
    if (!sim.world.walkableAt(out.x, out.z)) out = sim.padLocalToWorld(camp, 0, camp.padD / 2 + 2.2);
    if (!sim.world.walkableAt(out.x, out.z)) {
      const fb = sim.spawnNear(camp);
      if (fb) out = fb;
    }
    u.x = out.x;
    u.z = out.z;
    u.y = sim.world.heightAt(u.x, u.z);
    u.path = [];
    u.pathI = 0;
    u.think = 0.2;
    sim.toast(TRAIN_DONE[kind]);
    const nxt = this.trainQueue(sim, camp.id)[0];
    if (nxt) {
      nxt.think = 0;
      nxt.path = [];
      nxt.pathI = 0;
    }
  }

  trainAllows(sim: Sim, u: Unit, x: number, z: number): boolean {
    if (u.job !== "train") return false;
    const camp = sim.buildingById(u.targetId);
    if (!camp) return false;
    if (inPad(x, z, sim.buildingPad(camp), 0.25)) return true;
    const queue = this.trainQueue(sim, camp.id);
    let slot = queue.findIndex((o) => o.id === u.id);
    if (slot < 0) slot = 0;
    const dest = this.trainSlotPos(sim, camp, slot);
    return dist2(x, z, dest.x, dest.z) <= 0.55 * 0.55;
  }

  /**
   * v0.37 AI 训兵池（唯一出口）：真正空闲的户外村民。
   * 在途入住（targetId>0）/建营者/搬运砍树若进池，会把刚被 assignHomes 指派的人拉去训武士，
   * 茅屋空置、人口停产。AI 侧要用**同一个池子**算"还能征多少人"（劳动力保底），
   * 故从 train() 里抽成公开方法——否则两处条件漂移，AI 会以为有人可征、train() 却空转。
   */
  draftableWalkers(sim: Sim, team: Team): Unit[] {
    return sim.units.filter(
      (u) =>
        u.team === team &&
        u.kind === "walker" &&
        u.hp > 0 &&
        u.homeId === 0 &&
        u.carry === 0 &&
        u.foundKind === null &&
        u.targetId === 0 &&
        u.job !== "haul" &&
        u.job !== "chop" &&
        u.job !== "repair" && // v0.40 修理工不征（修一半被拉去训兵，营永远修不好）
        !sim.inSwamp(u),
    );
  }

  train(sim: Sim, team: Team, kind: TrainKind, maxWalkers = Infinity): boolean {
    const selected = sim.selectedOf(team);
    let walkers: Unit[];
    if (team === 0) { // BLUE
      if (!selected.length) {
        sim.toast("先选人");
        return false;
      }
      walkers = selected.filter((u) => u.kind === "walker" && u.homeId === 0 && !sim.inSwamp(u));
      if (!walkers.length) {
        sim.toast("选中的人不能训练");
        return false;
      }
    } else {
      // v0.35 AI 训兵池：只收真正空闲的户外村民（唯一出口见 draftableWalkers）。
      walkers = this.draftableWalkers(sim, team);
      if (!walkers.length) return false;
    }
    const campKind = CAMP_FOR[kind];
    // v0.40 破损停机：进骨架的营不接新兵（修好才恢复；已有排队者在 advanceTrain 侧释放）。
    const camps = sim.buildings.filter((b) => b.team === team && b.kind === campKind && b.level >= 1 && b.hp > 0 && !b.shell);
    if (!camps.length) {
      if (team !== 0) {
        const t = sim.teams[team];
        if (!t.wanted.includes(campKind)) t.wanted.push(campKind);
        // v0.31 "已有人管"口径扩展：该营地已有 L0 地基/L1 建筑也算覆盖——否则地基落成后
        // （assignCampFounder 落基即清 foundKind）每次重试都会再派一名营者重复落基。
        const covered =
          sim.buildings.some((b) => b.team === team && b.kind === campKind && b.hp > 0) ||
          sim.units.some((u) => u.team === team && u.kind === "walker" && u.foundKind === campKind);
        if (!covered) {
          // v0.31 候选排除已有建设任务（foundKind 非空）的村民：不把别处的营者改派过来。
          // v0.31.1 同时排除在途指派（targetId>0）：assignHomes 刚下过入住令的村民被
          // 半路改派建营，路过茅屋门口会被 tryOccupy 吸走、当场卸任。
          const idle = walkers.find((u) => u.carry === 0 && u.targetId === 0 && !u.foundKind && u.job !== "train" && u.job !== "haul" && u.job !== "chop")
            ?? walkers.find((u) => u.carry === 0 && u.targetId === 0 && !u.foundKind && u.job !== "train");
          if (idle) sim.assignCampFounder(idle, campKind);
        }
      }
      // v0.40 修理优先于重建：同类营只是被打成骨架就不另起新营（covered 已含骨架），
      // 修理工/玩家修理把它救回来——否则每被拆一次就多一座营。
      const damaged = sim.buildings.some(
        (b) => b.team === team && b.kind === campKind && b.level >= 1 && b.hp > 0 && b.shell,
      );
      if (damaged) {
        if (team === 0) sim.toast("先修理训练营");
        return false;
      }
      sim.toast("先盖训练营");
      return false;
    }
    const queued = walkers.filter((w) => w.job === "train");
    // v0.31 建营者不入队：ready 不排除 foundKind 会把正在建营的村民直接训成兵，
    // 营地请求随之悬空（训练/建营抢人的另一处根因）。
    // v0.31 队列限量（AI 专用）：旧实现一次成功就全量送人（实测 40+ 村民一次入队），
    // 无视 armyCap 涌成兵海，还会把兵种阶梯点名的特种兵冲成一大批。
    // v0.31.1 限量截空显式拒绝（返回 false）：空切片曾返回 true，economy 误记"训练
    // 成功"吃满 8s 冷却静默空转——"没人可训"与"训练成功"必须分开。
    const pool = walkers.filter((w) => w.job !== "train" && !w.foundKind);
    if (!pool.length) return true; // 全员已在队列/建营：维持旧"已在训"语义
    const ready = Number.isFinite(maxWalkers) ? pool.slice(0, Math.max(0, maxWalkers)) : pool;
    if (!ready.length) return false;
    let camp = camps[0]!;
    const follow = queued[0] ? sim.buildingById(queued[0].targetId) : undefined;
    if (follow && follow.hp > 0 && follow.level >= 1) {
      camp = follow;
    } else {
      let cx = 0;
      let cz = 0;
      for (const w of ready) {
        cx += w.x;
        cz += w.z;
      }
      cx /= ready.length;
      cz /= ready.length;
      let bestD = dist2(cx, cz, camp.x, camp.z);
      for (const c of camps) {
        const d = dist2(cx, cz, c.x, c.z);
        if (d < bestD) {
          bestD = d;
          camp = c;
        }
      }
    }
    for (const w of ready) this.sendWalkerToCamp(sim, w, camp, kind);
    if (team === 0) sim.toast("前往训练");
    return true;
  }
}
