import { astar, nearestLand, pullString } from "../path";
import { Cell, clamp, dist2, padSize, UNIT_RADIUS, Unit, WORLD } from "../types";
import { applyUnitDamage } from "../damage";
import { inDoorSlit, inPad, pushCircleFromPad, TREE_BLOCK_R } from "../world";
import type { Sim } from "../sim";
import type { ISystem } from "./system";

export class PathSystem implements ISystem {
  private stuckTries = new Map<number, number>();

  update(sim: Sim, dt: number): void {
    this.moveUnits(sim, dt);
    this.watchStuck(sim);
  }

  moveUnits(sim: Sim, dt: number): void {
    for (const u of sim.units) {
      if (u.homeId > 0) continue;
      if (u.fireT > 0) u.fireT = Math.max(0, u.fireT - dt);
      if (u.ghostT > 0) u.ghostT = Math.max(0, u.ghostT - dt);
      const g0 = sim.world.heightAt(u.x, u.z);
      if (u.flyVy !== 0 || u.y > g0 + 0.08) {
        u.flyVy -= 18 * dt;
        u.x = clamp(u.x + u.flyVx * dt, 0.3, WORLD - 0.3);
        u.z = clamp(u.z + u.flyVz * dt, 0.3, WORLD - 0.3);
        u.y += u.flyVy * dt;
        u.path = [];
        u.pathI = 0;
        const g1 = sim.world.heightAt(u.x, u.z);
        if (u.y <= g1) {
          u.y = g1;
          u.flyVy = 0;
          u.flyVx = 0;
          u.flyVz = 0;
          if (u.flyKill) {
            // v0.12 暴击击飞：摔下来直接死亡。
            u.flyKill = false;
            u.flyDmg = 0;
            u.hp = 0;
          } else if (u.flyDmg > 0) {
            // v0.9 落地伤害：击飞来源（火球）写入的 flyDmg 在落地瞬间结算；法术击飞 flyDmg=0 不受影响。
            applyUnitDamage(u, "firewarrior", u.flyDmg);
            u.flyDmg = 0;
          }
        }
        continue;
      }
      if (u.downT > 0) {
        // v0.12 倒地：不移动，倒计时；站起瞬间结算火球默认命中的延迟伤害。
        u.downT = Math.max(0, u.downT - dt);
        if (u.downT === 0 && u.downDmg > 0) {
          applyUnitDamage(u, "firewarrior", u.downDmg);
          u.downDmg = 0;
        }
        u.y = sim.world.heightAt(u.x, u.z);
        continue;
      }
      const swamp = sim.world.swamp[sim.world.sampleAt(u.x, u.z)]! > 0;
      let spd = 2.4;
      if (u.kind === "warrior") spd = 3.3;
      else if (u.kind === "preacher") spd = 2.55;
      else if (u.kind === "firewarrior") spd = 2.7;
      else if (u.kind === "shaman") spd = 2.1;
      else if (u.kind === "spy") spd = 2.8;
      else if (u.kind === "wildman") spd = 1.8;
      if (swamp) spd *= 0.04;
      const sl = sim.world.slopeAt(u.x, u.z);
      // v0.13 坡度惩罚调缓 + 下限提高（地形已平滑）：消除陡坡爬行感。
      spd *= 1 / (1 + Math.min(sl, 1.5) * 1.4);
      if (spd < 0.5) spd = 0.5;
      if (u.kind === "preacher" && u.channel > 0) {
        u.y = sim.world.heightAt(u.x, u.z);
        continue;
      }
      if (u.job === "train" && u.channel > 0) {
        u.y = sim.world.heightAt(u.x, u.z);
        continue;
      }
      if (!u.path.length) {
        const dest = this.goalCell(sim, u);
        const going =
          u.job === "move" ||
          u.job === "haul" ||
          (u.job === "train" && u.channel <= 0) ||
          (u.job === "chop" && u.channel <= 0);
        if (going && dest && sim.world.land(u.x, u.z) && sim.world.land(dest.x, dest.z)) {
          u.path = [{ x: dest.x, z: dest.z }];
          u.pathI = 0;
        } else {
          u.y = sim.world.heightAt(u.x, u.z);
          continue;
        }
      }
      if (u.pathI >= u.path.length) {
        u.path = [];
        this.onArrive(sim, u);
        u.y = sim.world.heightAt(u.x, u.z);
        continue;
      }
      let step = u.path[u.pathI]!;
      const pulled = pullString(sim.world, u.x, u.z, u.path, u.pathI);
      if (pulled > u.pathI) {
        u.pathI = pulled;
        step = u.path[u.pathI]!;
      }
      if (!sim.world.walkableAt(step.x, step.z) && !sim.trainingSystem.trainAllows(sim, u, step.x, step.z)) {
        u.pathI++;
        continue;
      }
      const dx = step.x - u.x;
      const dz = step.z - u.z;
      const len = Math.hypot(dx, dz);
      const arriveRadius = u.pathI < u.path.length - 1 ? 0.2 : 0.08;
      if (len < arriveRadius) {
        u.pathI++;
        if (u.pathI >= u.path.length) {
          u.path = [];
          this.onArrive(sim, u);
        }
        continue;
      }
      const m = Math.min(1, (spd * dt) / len);
      // v0.24 硬不变量 + 退半步：绝不允许一步迈进不可走的格子（ghostT 穿墙兜底除外）。
      // 为什么需要：点判据 walkableAt 只看格心，而两节点之间的直线会擦过海湾/建筑地基
      // 的缝隙；单位一踏进去，resolveCollisions 立刻用 nearestLand 把它整段弹回栅格点
      //（进度清零）→ repath → 再踏进去，实测每 0.7s 一轮、原地抖 20 秒不前进——
      // 就是用户说的"人物行走卡顿、寻路反复 retry"。
      // 为什么不直接停住：第一版这里写的是"迈不出去就 continue"，结果单位在自家
      // 门口地基边冻 1.5 秒，被 watchStuck 判卡后靠 ghostT 穿墙脱身（观感是人傻站着）。
      // 现在按 m、m/2、m/4、m/8 逐级回退，取"还迈得出去的最远一段"：贴着水湾/地基
      // 边缘照样一格一格往前挪；整步都迈不动才改瞄下一个节点（末节点交给看门狗绕路）。
      // 正向：按 m、m/2、m/4、m/8 逐级回退，取"还迈得出去的最远一段"。
      let mv = 0;
      let mx = 0;
      let mz = 0;
      for (let k = 0; k < 4; k++) {
        const f = m / (1 << k);
        if (this.canStandOn(sim, u, u.x + dx * f, u.z + dz * f)) {
          mv = f;
          mx = dx * f;
          mz = dz * f;
          break;
        }
      }
      // 正向全挡：贴着障碍侧滑（±35°、±70°）。房角/树根这类障碍在 0.5 格寻路栅格上
      // 分辨不出来——实测蓝方 walker 卡在地基拐角，正前 0.07 格处高度 0.397（明明是干的）
      // 却整格落在地基内，只退半步就会永久冻在屋角，侧滑才是玩家期待的"擦着屋角绕过去"。
      if (mv <= 0) {
        const an = Math.atan2(dz, dx);
        for (const off of [0.61, -0.61, 1.22, -1.22]) {
          const ca = an + off;
          const ax = Math.cos(ca);
          const az = Math.sin(ca);
          for (let k = 0; k < 3; k++) {
            const f = m / (1 << k);
            if (this.canStandOn(sim, u, u.x + ax * f, u.z + az * f)) {
              mv = f;
              mx = ax * f;
              mz = az * f;
              break;
            }
          }
          if (mv > 0) break;
        }
      }
      if (mv <= 0) {
        // v0.24 整步都迈不出去时，**不要**u.pathI++ 跳过节点：跳过等于让单位隔着障碍
        // 去瞄更远的前方节点（实测瞄到 2.4 格外），下一步照样被拦，一路跳到路径末尾
        // → 路径清空 → 走上面 !u.path.length 的"直冲目的地"兜底 → 扎进水里 → 卡死穿墙。
        // 正确做法是就地向 A* 要一条"从脚下出发"的新走廊（首节点必在 0.5 格内），
        // 并用 think 做 0.35s 节流，避免每帧重算。
        // 节流：think 还大于 0.05 说明刚刚已经重算过一条走廊了（每帧重算会把 CPU 烧光，
        // 而且新走廊和旧的一样拦住去路时，重算本身没有任何信息增益）。
        if (u.think <= 0.05) {
          const dest = this.goalCell(sim, u);
          if (dest) this.repathKeepJob(sim, u, dest);
          else u.path = [];
          u.pathI = 0;
          u.think = 0.35;
        }
        u.y = sim.world.heightAt(u.x, u.z);
        continue;
      }
      u.x += mx;
      u.z += mz;
      u.yaw = Math.atan2(dx, dz);
      u.y = sim.world.heightAt(u.x, u.z);
    }
    this.resolveCollisions(sim);
    for (const u of sim.units) {
      if (u.flyVy !== 0 || u.y > sim.world.heightAt(u.x, u.z) + 0.08) continue;
      // v0.13 高度指数趋近 + 离地钳制：随地形起伏更顺滑，同时不会被误判为腾空。
      const gh = sim.world.heightAt(u.x, u.z);
      u.y += (gh - u.y) * Math.min(1, 20 * dt);
      if (u.y > gh + 0.02) u.y = gh + 0.02;
    }
  }

  /**
   * 单位能否站到 (x,z)：ghostT（穿墙兜底）放行、整格可走放行、训练位放行。
   * 抽成单一入口，免得正向与侧滑两处判据走偏。
   */
  canStandOn(sim: Sim, u: Unit, x: number, z: number): boolean {
    return (
      u.ghostT > 0 ||
      sim.world.walkableAt(x, z) ||
      sim.trainingSystem.trainAllows(sim, u, x, z)
    );
  }

  onArrive(sim: Sim, u: Unit): void {
    if (u.job === "move") {
      u.job = "idle";
      u.moveX = -1;
      u.moveZ = -1;
      // Hold position after a player move order: idle wander must not immediately walk the unit away.
      u.think = 30;
    } else {
      u.think = 0;
    }
    const home = sim.buildingById(u.targetId);
    if (home) {
      u.yaw = Math.atan2(home.x - u.x, home.z - u.z);
      return;
    }
    const tr = sim.trees.find((t) => t.id === u.targetId);
    if (tr) u.yaw = Math.atan2(tr.x - u.x, tr.z - u.z);
  }

  goalCell(sim: Sim, u: Unit): Cell | null {
    if (u.job === "move" && u.moveX >= 0) {
      return { x: u.moveX, z: u.moveZ };
    }
    if (u.job === "train" && u.targetId) {
      const camp = sim.buildingById(u.targetId);
      if (camp && camp.level >= 1) {
        const queue = sim.trainingSystem.trainQueue(sim, camp.id);
        let slot = queue.findIndex((o) => o.id === u.id);
        if (slot < 0) slot = 0;
        return sim.trainingSystem.trainSlotPos(sim, camp, slot);
      }
    }
    if (u.path.length) {
      const last = u.path[u.path.length - 1]!;
      return { x: last.x, z: last.z };
    }
    if (u.targetId) {
      const b = sim.buildingById(u.targetId);
      if (b) return sim.padEdge(b.x, b.z, b.padW, b.padD, b.yaw, u.x, u.z);
      const tr = sim.trees.find((t) => t.id === u.targetId);
      if (tr && tr.alive) return sim.treeRim(tr, u.x, u.z);
    }
    if (u.settleX >= 0) {
      const pad = padSize(1);
      return sim.padEdge(u.settleX, u.settleZ, pad.w, pad.d, u.settleYaw, u.x, u.z);
    }
    return null;
  }

  repathKeepJob(sim: Sim, u: Unit, dest: Cell): void {
    u.path = astar(sim.world, u.x, u.z, dest.x, dest.z);
    if (!u.path.length) u.path = [{ x: dest.x, z: dest.z }];
    u.pathI = 0;
  }

  detourAround(sim: Sim, u: Unit, dest: Cell): Cell | null {
    let bx = (u.x + dest.x) * 0.5;
    let bz = (u.z + dest.z) * 0.5;
    let bestD = 1e9;
    let found = false;
    for (const b of sim.buildings) {
      if (b.hp <= 0) continue;
      const midX = (u.x + dest.x) * 0.5;
      const midZ = (u.z + dest.z) * 0.5;
      const pad = sim.buildingPad(b);
      if (!inPad(u.x, u.z, pad, 2.6) && !inPad(midX, midZ, pad, 1.4)) continue;
      const d = dist2(u.x, u.z, b.x, b.z);
      if (d < bestD) {
        bestD = d;
        bx = b.x;
        bz = b.z;
        found = true;
      }
    }
    for (const t of sim.trees) {
      if (!t.alive) continue;
      const d = dist2(u.x, u.z, t.x, t.z);
      if (d < 3.4 * 3.4 && d < bestD) {
        bestD = d;
        bx = t.x;
        bz = t.z;
        found = true;
      }
    }
    for (const o of sim.units) {
      if (o.id === u.id || o.hp <= 0) continue;
      const d = dist2(u.x, u.z, o.x, o.z);
      if (d < 0.72 * 0.72 && d < bestD) {
        bestD = d;
        bx = o.x;
        bz = o.z;
        found = true;
      }
    }
    let dx = u.x - bx;
    let dz = u.z - bz;
    let len = Math.hypot(dx, dz);
    if (!found || len < 1e-4) {
      dx = dest.x - u.x;
      dz = dest.z - u.z;
      len = Math.hypot(dx, dz);
      if (len < 1e-4) return null;
    }
    dx /= len;
    dz /= len;
    const sides: [number, number][] = [
      [-dz, dx],
      [dz, -dx],
    ];
    let best: Cell | null = null;
    let bestScore = 1e9;
    for (const [px, pz] of sides) {
      for (const dist of [1.4, 2.1, 2.8]) {
        const x = u.x + px * dist;
        const z = u.z + pz * dist;
        if (!sim.world.walkableAt(x, z)) continue;
        const score = dist2(x, z, dest.x, dest.z);
        if (score < bestScore) {
          bestScore = score;
          best = { x, z };
        }
      }
    }
    return best;
  }

  unstick(sim: Sim, u: Unit): void {
    if (u.job === "chop" && u.channel > 0) return;
    if (u.job === "train" && u.channel > 0) return;
    if (u.kind === "preacher" && u.channel > 0) return;
    const dest = this.goalCell(sim, u);
    if (!dest) return;
    const via = this.detourAround(sim, u, dest);
    u.path = [];
    u.pathI = 0;
    let path: Cell[] = [];
    if (via && dist2(via.x, via.z, dest.x, dest.z) > 0.16) {
      const a = astar(sim.world, u.x, u.z, via.x, via.z);
      const b = astar(sim.world, via.x, via.z, dest.x, dest.z);
      if (a.length && b.length) path = a.concat(b);
      else if (b.length) path = b;
      else path = a;
    }
    if (!path.length) path = astar(sim.world, u.x, u.z, dest.x, dest.z);
    if (!path.length) path = [{ x: dest.x, z: dest.z }];
    u.path = path;
    u.pathI = 0;
  }

  watchStuck(sim: Sim): void {
    const now = sim.time;
    const live = new Set<number>();
    for (const u of sim.units) live.add(u.id);
    for (const id of [...sim.stuckWatch.keys()]) {
      if (!live.has(id)) {
        sim.stuckWatch.delete(id);
        this.stuckTries.delete(id);
      }
    }
    for (const u of sim.units) {
      if (u.hp <= 0 || u.homeId > 0) continue;
      if (u.flyVy !== 0 || u.y > sim.world.heightAt(u.x, u.z) + 0.08) continue;
      const going =
        u.path.length > 0 ||
        u.job === "move" ||
        u.job === "haul" ||
        (u.job === "chop" && u.channel <= 0) ||
        (u.job === "train" && u.channel <= 0);
      if (!going) {
        sim.stuckWatch.set(u.id, { x: u.x, z: u.z, t: now });
        this.stuckTries.set(u.id, 0);
        continue;
      }
      const prev = sim.stuckWatch.get(u.id);
      const dest = this.goalCell(sim, u);
      if (!prev) {
        sim.stuckWatch.set(u.id, { x: u.x, z: u.z, t: now });
        this.stuckTries.set(u.id, 0);
        continue;
      }
      // Progress = the distance to the order's destination shrinking. Jitter in place does not count.
      const destDist = dest ? Math.hypot(u.x - dest.x, u.z - dest.z) : 0;
      const prevDist = dest ? Math.hypot(prev.x - dest.x, prev.z - dest.z) : 0;
      const gained = dest ? prevDist - destDist : Math.hypot(u.x - prev.x, u.z - prev.z);
      // 0.15: normal walkers cover >1.4/s; face-grinding along a pad creeps at ~0.1 and must count as stuck.
      if (gained >= 0.15) {
        sim.stuckWatch.set(u.id, { x: u.x, z: u.z, t: now });
        this.stuckTries.set(u.id, 0);
        continue;
      }
      if (now - prev.t >= 1.0) {
        const tries = (this.stuckTries.get(u.id) ?? 0) + 1;
        this.stuckTries.set(u.id, tries);
        if (tries >= 2 && dest) {
          // Last resort: walk straight through (clipping allowed) so corners can never trap a unit.
          u.ghostT = 2.5;
          u.path = [{ x: dest.x, z: dest.z }];
          u.pathI = 0;
        } else {
          this.unstick(sim, u);
        }
        sim.stuckWatch.set(u.id, { x: u.x, z: u.z, t: now });
      }
    }
  }

  resolveCollisions(sim: Sim): void {
    for (const u of sim.units) {
      if (u.homeId > 0) continue;
      if (u.flyVy !== 0 || u.y > sim.world.heightAt(u.x, u.z) + 0.08) continue;
      const r = UNIT_RADIUS[u.kind];
      const holdTrain = u.job === "train" && u.channel > 0;
      if (!sim.world.walkableAt(u.x, u.z) && !holdTrain && u.ghostT <= 0) {
        const dest = this.goalCell(sim, u);
        const keep = !!(dest && (u.path.length || u.job === "move" || u.moveX >= 0 || u.targetId || u.settleX >= 0));
        const safe = nearestLand(sim.world, u.x, u.z);
        if (safe) {
          u.x = safe.x;
          u.z = safe.z;
        }
        if (keep && dest) this.repathKeepJob(sim, u, dest);
        else {
          u.path = [];
          u.pathI = 0;
        }
      }
      for (const b of sim.buildings) {
        if (b.hp <= 0) continue;
        if (holdTrain) continue;
        const pad = sim.buildingPad(b);
        if (u.ghostT > 0) continue;
        if (inDoorSlit(u.x, u.z, pad)) continue;
        const pushed = pushCircleFromPad(u.x, u.z, r, pad);
        const pushDist = Math.hypot(pushed.x - u.x, pushed.z - u.z);
        if (pushDist > 0.12) {
          u.x += (pushed.x - u.x) * 0.45;
          u.z += (pushed.z - u.z) * 0.45;
        }
      }
      for (const t of sim.trees) {
        if (!t.alive) continue;
        const need = r + TREE_BLOCK_R;
        const dx = u.x - t.x;
        const dz = u.z - t.z;
        const d2 = dx * dx + dz * dz;
        if (d2 < 1e-10) {
          u.x += need;
          continue;
        }
        if (d2 >= need * need) continue;
        const d = Math.sqrt(d2);
        const push = (need - d) / d;
        u.x += dx * push;
        u.z += dz * push;
      }
    }
    const n = sim.units.length;
    for (let i = 0; i < n; i++) {
      const a = sim.units[i]!;
      if (a.homeId > 0) continue;
      const ra = UNIT_RADIUS[a.kind];
      for (let j = i + 1; j < n; j++) {
        const b = sim.units[j]!;
        if (b.homeId > 0) continue;
        const rb = UNIT_RADIUS[b.kind];
        const dx = a.x - b.x;
        const dz = a.z - b.z;
        const d2 = dx * dx + dz * dz;
        const need = ra + rb;
        if (d2 >= need * need || d2 < 1e-8) continue;
        const d = Math.sqrt(d2);
        const rawPush = ((need - d) / d) * 0.5;
        const dispMag = rawPush * d;
        const scale = dispMag > 0.04 ? 0.04 / dispMag : 1.0;
        const push = rawPush * scale;
        a.x += dx * push;
        a.z += dz * push;
        b.x -= dx * push;
        b.z -= dz * push;
      }
      a.x = clamp(a.x, 0.3, WORLD - 0.3);
      a.z = clamp(a.z, 0.3, WORLD - 0.3);
    }
    for (const u of sim.units) {
      if (u.job !== "train" || !u.targetId) continue;
      const camp = sim.buildingById(u.targetId);
      if (!camp) continue;
      const queue = sim.trainingSystem.trainQueue(sim, camp.id);
      const slot = queue.findIndex((o) => o.id === u.id);
      if (slot < 0) continue;
      const dest = sim.trainingSystem.trainSlotPos(sim, camp, slot);
      if (dist2(u.x, u.z, dest.x, dest.z) < 0.55 * 0.55) {
        u.x += (dest.x - u.x) * 0.85;
        u.z += (dest.z - u.z) * 0.85;
      }
    }
  }
}
