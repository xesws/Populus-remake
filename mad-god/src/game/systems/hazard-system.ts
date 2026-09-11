import { BLUE, Building, inMap, isCampKind, Unit, WATER } from "../types";
import type { Sim } from "../sim";
import type { ISystem } from "./system";
import { logger } from "../logger";

/** v0.39 溺水参数：先给一段浸水宽限（被挤下水岸不致命），超过就持续掉血。 */
const DROWN_GRACE = 0.5;
const DROWN_DPS = 6;

export class HazardSystem implements ISystem {
  /** v0.39 溺水计时（单位 id → 连续浸水秒数）：短暂被挤落水不扣血，真涉水才沉。 */
  private wet = new Map<number, number>();

  update(sim: Sim, dt: number): void {
    this.hazards(sim, dt);
  }

  hazards(sim: Sim, dt: number): void {
    if (sim.review) return;
    const lived = new Set<number>();
    for (const u of sim.units) {
      // v0.30 大龙在半空飞行：溺水/岩浆/沼泽都是地面危害，不波及。
      if (u.isFlying()) continue;
      // v0.39 落水判据用**点高**（heightAt ≤ WATER）：只有单位中心真的沉到水面以下才算溺水。
      // 为何不用通行层的整格口径（!cellLand）：后者对海岸线过于敏感——站在可走岸边的村民（格内某个角
      // 在水下、中心明明在干地上）只要被人挤挪半格就会被判“落水”淹死（boat-check 登船用例实测踩到）。
      // 而可走格的格心高度必然 > WATER（walkableAt 要求四角全过水面），所以这条判据对“站在岸上”恒不误杀。
      const wet = !inMap(u.x, u.z) || sim.world.heightAt(u.x, u.z) <= WATER;
      if (wet) {
        // v0.32 船/船员不溺水（船浮着，船员在甲板上）。
        if (u.kind !== "boat" && u.homeId <= 0) this.drown(sim, u, dt);
        lived.add(u.id);
        continue;
      }
      const i = sim.world.sampleAt(u.x, u.z);
      if (sim.world.lava[i]! > 0) {
        u.hp -= 10 * dt;
        if (!sim.lavaHurt && u.team === BLUE) {
          sim.lavaHurt = true;
          sim.toast(u.kind === "shaman" ? "祭司被岩浆烫伤" : "一名子民被岩浆烫伤");
        }
      }
      if (sim.world.swamp[i]! > 0) {
        u.swampT += dt;
        if (u.swampT >= 5) {
          u.hp = 0;
          sim.swampKill = true;
          sim.swampKillX = u.x;
          sim.swampKillZ = u.z;
          if (u.team === BLUE) sim.toast(u.kind === "shaman" ? "祭司死于毒气" : "一名子民死于毒气");
        }
      } else {
        u.swampT = 0;
      }
    }
    // 清掉已上岸/已死亡单位的溺水计时（与 stuckWatch 同款清理口径）
    for (const id of [...this.wet.keys()]) {
      if (!lived.has(id) || !sim.units.some((u) => u.id === id)) this.wet.delete(id);
    }
  }

  /**
   * v0.39 溺水：不能游泳，落水就持续掉血直到沉底（或自己走上岸）。
   * - DROWN_GRACE：短背浸水（被同伴挤下水岸）不扣血，涉水过海必死；
   * - 不做任何“拉回岸边”的救援：旧实现每帧把落水单位弹回陆地，溺水伤害只来得及跑一帧
   *   （≈0.07 血），外加鬼影穿水，才出现了用户看到的“敌人从水里穿过来、水面没伤害”；
   *   现在只有**真的沉到水面以下**（h ≤ WATER）才不给救援，卡在房基/树里的仍会被弹回可走格。
   * - 玩家雕水把敌人沉下去也是合法战术（lower 到水面以下 → 持续擁血）。
   */
  private drown(sim: Sim, u: Unit, dt: number): void {
    const t = (this.wet.get(u.id) ?? 0) + dt;
    this.wet.set(u.id, t);
    if (t < DROWN_GRACE) return;
    u.hp -= DROWN_DPS * dt;
    if (u.hp > 0) return;
    if (u.team === BLUE && !sim.drownHurt) {
      sim.drownHurt = true;
      sim.toast(u.kind === "shaman" ? "祭司溺水身亡" : "一名子民溺水身亡");
    }
    logger.info("combat", `单位#${u.id}(${u.kind}) 溺水身亡`, { team: u.team, x: +u.x.toFixed(1), z: +u.z.toFixed(1) });
  }

  burnBuildings(sim: Sim, dt: number): void {
    for (const b of sim.buildings) {
      if (b.hp <= 0 || b.kind === "rebirth") continue;
      if (!this.lavaOnPad(sim, b)) continue;
      if (!b.shell) {
        b.shell = true;
        b.hp = Math.max(1, b.maxHp * 0.4);
        if (b.team === BLUE && (b.kind === "hut" || isCampKind(b.kind))) sim.toast("一座屋宇烧成骨架");
      } else {
        b.hp -= 4 * dt;
      }
    }
  }

  lavaOnPad(sim: Sim, b: Building): boolean {
    const pts: [number, number][] = [
      [b.x, b.z],
      [b.x + b.padW * 0.35, b.z],
      [b.x - b.padW * 0.35, b.z],
      [b.x, b.z + b.padD * 0.35],
      [b.x, b.z - b.padD * 0.35],
    ];
    for (const [x, z] of pts) {
      if (sim.world.lava[sim.world.sampleAt(x, z)]! > 0) return true;
    }
    return false;
  }
}
