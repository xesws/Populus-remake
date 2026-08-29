import { BLUE, clamp, inMap, isCampKind, Team, WORLD } from "../types";
import type { Sim } from "../sim";
import { inPad } from "../world";
import { Spell, SpellResult } from "./spell";

/**
 * v0.18 龙卷风建模（Agent T）：
 *  - (a) 初始方向完全随机，不再瞄向最近建筑；保留周期性随机微调航向。
 *  - (b) 卷到中心不再"卷高即死"：改为切向甩飞（flyVx/flyVz/flyVy/flyDmg），
 *        飞行与落地结算交给 path-system（落地瞬间按 flyDmg 结算伤害）。
 *  - (c) 触水不再反弹：当场转入水龙卷（waterspout）——速度减半、吸/甩参数衰减、
 *        寿命每秒额外 -1.2 加速消耗、只在水上缓慢漂移，直到自然消散。
 *
 * waterspout 字段由主 agent 在共享类型（sim.ts 的 sim.tornado）上补 `waterspout?: boolean`；
 * 补上之前本文件用局部 interface + as 断言兼容，补上之后断言可无缝移除。
 */
export interface TornadoState {
  x: number;
  z: number;
  vx: number;
  vz: number;
  t: number;
  life: number;
  houseT: number;
  waterspout?: boolean;
  /** v0.26b 被甩飞的单位 id（跨施放状态挂 sim 而非 Spell 实例，见 sim.ts 注释）。 */
  flungIds: Set<number>;
}

export class TornadoSpell extends Spell {
  readonly id = "tornado" as const;

  // v0.26b 甩飞落水追踪移到 sim.tornado.flungIds（见 sim.ts 的注释）：
  // TornadoSpell 被 SPELLS 单例与 Sim 实例各持一份，实例字段在 cast/tick 两份
  // 实例间互不可见——旧写法 tick 永远读到空 Set，"甩飞落海即死"从未生效。

  cast(sim: Sim, team: Team, x: number, z: number, _dt?: number): SpellResult {
    const empty: SpellResult = { ok: false, bolts: [], shake: 0, msg: "" };
    if (!inMap(x, z)) return empty;
    if (sim.world.heightAt(x, z) <= 0.20) return { ...empty, msg: "水上不起龙卷风" };
    if (!sim.spendCharge(team, this.id)) return { ...empty, msg: "法力不足" };
    if (!this.beginTornado(sim, x, z)) {
      sim.refundCharge(team, this.id, 1); // 龙卷风还在刮，退还
      return { ...empty, msg: "龙卷风还在刮" };
    }
    return { ok: true, bolts: [], shake: 0.2, msg: "龙卷风升起" };
  }

  beginTornado(sim: Sim, x: number, z: number): boolean {
    if (sim.tornado && sim.tornado.t < sim.tornado.life - 0.4) return false;
    // v0.18 (a) 初始方向完全随机：真正的龙卷风路径不可预测，不再特意去拆最近的建筑。
    const ang = Math.random() * Math.PI * 2;
    const spd = 1.35;
    sim.tornado = { x, z, vx: Math.cos(ang) * spd, vz: Math.sin(ang) * spd, t: 0, life: 16, houseT: 0, flungIds: new Set() };
    sim.fxShake = Math.max(sim.fxShake, 0.22);
    sim.tornadoLift = false;
    sim.tornadoHouse = false;
    return true;
  }

  tick(sim: Sim, dt: number): void {
    // 甩飞落水判定不依赖 tornado 是否还在：龙卷风消散后，空中的人仍要按落水结算。
    this.tickFlungWaterDeath(sim);
    const raw = sim.tornado;
    if (!raw) return;
    const tw = raw as TornadoState;
    tw.t += dt;
    if (tw.t > tw.life) {
      sim.tornado = null;
      return;
    }
    // 周期性随机微调航向（保留原有节奏；水龙卷漂移速度约为陆上的一半）。
    if (tw.t > 3.8 && Math.floor(tw.t / 1.7) !== Math.floor((tw.t - dt) / 1.7)) {
      const ang = Math.atan2(tw.vz, tw.vx) + (Math.random() - 0.5) * 1.1;
      const spd = (tw.waterspout ? 0.62 : 1.25) + Math.random() * (tw.waterspout ? 0.2 : 0.3);
      tw.vx = Math.cos(ang) * spd;
      tw.vz = Math.sin(ang) * spd;
    }
    // v0.18 (c) 水龙卷：寿命每秒额外 -1.2，加速消散（自然耗尽，而不是凭空消失）。
    if (tw.waterspout) tw.life -= 1.2 * dt;

    let nx = tw.x + tw.vx * dt;
    let nz = tw.z + tw.vz * dt;
    if (tw.waterspout) {
      // 水龙卷不回流上岸：目标点是陆地（或出界）就绕圈找水，找不到就原地漂（寿命照耗）。
      if (!inMap(nx, nz) || sim.world.land(nx, nz)) {
        const step = Math.hypot(tw.vx * dt, tw.vz * dt) || 0.05;
        let found = false;
        for (let k = 1; k <= 8; k++) {
          const a = (k / 8) * Math.PI * 2;
          const px = tw.x + Math.cos(a) * step;
          const pz = tw.z + Math.sin(a) * step;
          if (inMap(px, pz) && !sim.world.land(px, pz)) {
            nx = px;
            nz = pz;
            found = true;
            break;
          }
        }
        if (!found) {
          nx = tw.x;
          nz = tw.z;
        }
      }
    } else if (!sim.world.land(nx, nz)) {
      // v0.18 (c) 入海：触水不反弹——当场转入水龙卷，速度减半，从此只在水上漂。
      tw.waterspout = true;
      tw.vx *= 0.5;
      tw.vz *= 0.5;
      nx = clamp(nx, 0.3, WORLD - 0.3);
      nz = clamp(nz, 0.3, WORLD - 0.3);
      if (sim.world.land(nx, nz)) {
        // 地图外是海，理论上走不到这里；万一钳回来的点仍是陆地就留在原地。
        nx = tw.x;
        nz = tw.z;
      }
    }
    tw.x = nx;
    tw.z = nz;

    // v0.18 (c) 水龙卷衰减：吸人半径/力度、旋转力度、甩飞判定距离、抬升高度全部打折。
    const suckR = tw.waterspout ? 1.15 : 1.7;
    const suckP = tw.waterspout ? 1.35 : 2.6;
    const swirlP = tw.waterspout ? 1.3 : 2.4;
    const flingD = tw.waterspout ? 0.42 : 0.62;
    const liftScale = tw.waterspout ? 0.6 : 1;
    for (const u of sim.units) {
      if (u.hp <= 0) continue;
      if (u.flyVy !== 0) continue; // 已被甩飞在空中：抛物线飞行交给 path-system，不再重复吸入
      const d = Math.hypot(u.x - tw.x, u.z - tw.z);
      if (d > suckR) continue;
      if (d > 0.08) {
        u.x += ((tw.x - u.x) / d) * suckP * dt;
        u.z += ((tw.z - u.z) / d) * suckP * dt;
      }
      const tang = swirlP * dt;
      u.x += (-(tw.z - u.z) / Math.max(0.12, d)) * tang;
      u.z += ((tw.x - u.x) / Math.max(0.12, d)) * tang;
      u.x = clamp(u.x, 0.3, WORLD - 0.3);
      u.z = clamp(u.z, 0.3, WORLD - 0.3);
      const ground = sim.world.heightAt(u.x, u.z);
      u.y = ground + Math.min(2.1, ((1.7 - d) * 1.35 + 0.25) * liftScale);
      u.path = [];
      u.pathI = 0;
      u.think = 0.8;
      sim.tornadoLift = true;
      sim.tornadoLiftX = u.x;
      sim.tornadoLiftZ = u.z;
      // v0.18 (b) 卷到中心不再 hp=0：切向甩飞。落地伤害/落地结算由 path-system 统一处理。
      if (d < flingD && u.y > ground + 1.05 * liftScale) {
        const radial = Math.atan2(u.z - tw.z, u.x - tw.x);
        const ang = radial + Math.PI / 2 + (Math.random() - 0.5) * 1.2; // 切向为主 + 随机偏摆
        const sp = 3 + Math.random() * 2; // 甩出速度 3~5
        u.flyVx = Math.cos(ang) * sp;
        u.flyVz = Math.sin(ang) * sp;
        u.flyVy = 4.5 + Math.random() * 1.5; // 上抛 4.5~6
        u.flyDmg = 3; // 落地伤害（适量）：path-system 落地瞬间结算
        u.flyKill = false; // 清掉可能残留的暴击击飞标记，防止落地被误判直接死亡
        u.path = [];
        u.pathI = 0;
        tw.flungIds.add(u.id);
        if (u.team === BLUE && u.kind === "shaman") sim.toast("祭司被龙卷风卷走");
      }
    }

    let touching = false;
    for (const b of sim.buildings) {
      if (b.hp <= 0 || b.kind === "rebirth") continue;
      const pad = sim.buildingPad(b);
      const d = Math.hypot(b.x - tw.x, b.z - tw.z);
      if (d > 2.05 && !inPad(tw.x, tw.z, pad, 0.35)) continue;
      touching = true;
      if (!b.shell) {
        b.shell = true;
        b.hp = Math.max(1, b.maxHp * 0.4);
        tw.houseT = 0;
        sim.tornadoHouse = true;
        if (b.team === BLUE && (b.kind === "hut" || isCampKind(b.kind))) sim.toast("一座屋宇被卷成骨架");
      } else {
        tw.houseT += dt;
        if (tw.houseT > 0.85) {
          b.hp = 0;
          sim.tornadoHouse = true;
        }
      }
    }
    if (!touching) tw.houseT = Math.max(0, tw.houseT - dt);
  }

  /**
   * v0.18 甩飞落水即死：本法术甩飞的单位，飞行中一旦当前位置已是水面（heightAt<=WATER，
   * 落点必然在海里）→ hp=0。落水单位会在同一帧被 path-system 拉回最近陆地，
   * 所以只能在它还飞着、还跨在水面上时判死。
   */
  private tickFlungWaterDeath(sim: Sim): void {
    const flung = sim.tornado?.flungIds ?? new Set<number>();
    if (flung.size === 0) return;
    for (const id of [...flung]) {
      const u = sim.units.find((x) => x.id === id);
      if (!u || u.hp <= 0) {
        flung.delete(id);
        continue;
      }
      if (u.flyVy !== 0) {
        if (!sim.world.land(u.x, u.z)) {
          u.hp = 0;
          flung.delete(id);
          // 祭司落水由 cull 统一播报"祭司陨落"，这里只播普通子民。
          if (u.team === BLUE && u.kind !== "shaman") sim.toast("一名子民被甩进海里");
        }
        continue;
      }
      // 已安全落地（flyVy 归零）：结束追踪。
      flung.delete(id);
    }
  }
}
