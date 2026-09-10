// v0.37 敌方 AI：目标选择（纯几何，无状态、只读 Sim）——"打哪儿、在哪儿集结"的唯一来源。
//
// 旧实现把 cluster() 在军事子脑与神力子脑各抄了一份，且军事子脑用"敌方建筑+单位的密集点"
// 当唯一靶心：波次散开各自打最近的目标，看起来就是零散骚扰。现在统一成：
//   - assaultFocus：敌方**建筑**密集点优先（拆家才是胜负手，rebirth 除外），没建筑了才打单位；
//     返回的 targetId 就是全波统一集火的目标（焦点集火，不再各打各的）。
//   - rallyPoint：自家前沿集结点（离敌方焦点最近的自家茅屋门口），波次在此成型后整队出击。
//   - densePoint：通用密集点聚类（神力子脑砸法术复用，删掉各自抄写的副本）。

import type { Sim } from "../sim";
import { BLUE, Cell, dist2, isSoldier, RED, Team } from "../types";

/** 突击焦点：集结点坐标 + 全波统一集火的目标 id（建筑优先，无建筑则取单位）。 */
export interface Focus extends Cell {
  targetId: number;
}

export class Targeting {
  /** 点群密集点：邻域（半径 √20 ≈ 4.5 格）内同伴最多者；空数组返回 null。 */
  static densePoint(pts: Cell[]): Cell | null {
    if (!pts.length) return null;
    let best = pts[0]!;
    let bestN = -1;
    for (const p of pts) {
      let n = 0;
      for (const q of pts) if (dist2(p.x, p.z, q.x, q.z) < 20) n++;
      if (n > bestN) {
        bestN = n;
        best = p;
      }
    }
    return best;
  }

  /**
   * 突击焦点：敌方建筑密集点优先（同分时茅屋优先——拆屋才是拆人口与胜负），
   * 敌方已无建筑时退回单位密集点；两者都无返回 null（无目标可打）。
   */
  static assaultFocus(sim: Sim, team: Team): Focus | null {
    const foe: Team = team === RED ? BLUE : RED;
    const houses = sim.buildings.filter((b) => b.team === foe && b.hp > 0 && b.kind !== "rebirth");
    const units = sim.units.filter((u) => u.team === foe && u.hp > 0 && u.homeId === 0);
    const pts: Cell[] = [...houses.map((h) => ({ x: h.x, z: h.z })), ...units.map((u) => ({ x: u.x, z: u.z }))];
    const candidates: Array<Cell & { targetId: number; bonus: number }> = houses.length
      ? houses.map((h) => ({ x: h.x, z: h.z, targetId: h.id, bonus: h.kind === "hut" ? 1.5 : 0 }))
      : units.map((u) => ({ x: u.x, z: u.z, targetId: u.id, bonus: 0 }));
    if (!candidates.length) return null;
    let best = candidates[0]!;
    let bestScore = -1e9;
    for (const c of candidates) {
      let score = c.bonus;
      for (const q of pts) if (dist2(c.x, c.z, q.x, q.z) < 20) score++;
      if (score > bestScore) {
        bestScore = score;
        best = c;
      }
    }
    return { x: best.x, z: best.z, targetId: best.targetId };
  }

  /**
   * 前沿集结点：离敌方焦点最近的自家茅屋门口（无茅屋退回本队出生点）。
   * 波次在自家前沿成型——比从各处零散出发更容易被打成添油，也少走一段路。
   */
  static rallyPoint(sim: Sim, team: Team, focus: Focus): Cell {
    const huts = sim.buildings.filter((b) => b.team === team && b.kind === "hut" && b.level >= 1 && b.hp > 0);
    if (huts.length) {
      let best = huts[0]!;
      let bestD = dist2(best.x, best.z, focus.x, focus.z);
      for (const h of huts) {
        const d = dist2(h.x, h.z, focus.x, focus.z);
        if (d < bestD) {
          bestD = d;
          best = h;
        }
      }
      return sim.hutDoor(best);
    }
    const pad = sim.world.startPad(team);
    return { x: pad.x, z: pad.z };
  }

  /**
   * 守家锚点：离自家出生点最近的自家茅屋门口（无茅屋退回出生点）。
   * 与 rallyPoint 的区别在锚点取向：这里是"家"（待命/收兵/老家告警半径的圆心），
   * 而集结点是"最靠敌的前沿"。
   */
  static homePoint(sim: Sim, team: Team): Cell {
    const pad = sim.world.startPad(team);
    const huts = sim.buildings.filter((b) => b.team === team && b.kind === "hut" && b.level >= 1 && b.hp > 0);
    if (huts.length) {
      let best = huts[0]!;
      let bestD = dist2(best.x, best.z, pad.x, pad.z);
      for (const h of huts) {
        const d = dist2(h.x, h.z, pad.x, pad.z);
        if (d < bestD) {
          bestD = d;
          best = h;
        }
      }
      return sim.hutDoor(best);
    }
    return { x: pad.x, z: pad.z };
  }

  /**
   * v0.38 软目标（大龙专用）：在敌方建筑里挑**附近敌方军事力量最少**的那座。
   * 为何不能给龙用 assaultFocus：那挑的是“最密集点”＝玩家主力与塔群正上方，
   * 600 血的龙孤身飞进去必被集火（用户实测“大龙一过来就被集火”）。
   * 评分：威胁分 = 半径内敌方军事单位数 + 塔 × 2；同分取离 from 更近的（省飞行时间）。
   */
  static softFocus(sim: Sim, team: Team, from: Cell, radius = 12): Focus | null {
    const foe: Team = team === RED ? BLUE : RED;
    const houses = sim.buildings.filter((b) => b.team === foe && b.hp > 0 && b.kind !== "rebirth");
    if (!houses.length) return null;
    const threats = sim.units.filter(
      (u) => u.team === foe && u.hp > 0 && u.homeId === 0 && (isSoldier(u.kind) || u.kind === "dragon"),
    );
    const towers = sim.buildings.filter((b) => b.team === foe && b.hp > 0 && b.kind === "tower");
    const r2 = radius * radius;
    let best = houses[0]!;
    let bestScore = 1e9;
    let bestD = 1e9;
    for (const h of houses) {
      let score = 0;
      for (const u of threats) if (dist2(h.x, h.z, u.x, u.z) <= r2) score++;
      for (const t of towers) if (dist2(h.x, h.z, t.x, t.z) <= r2) score += 2;
      // 茅屋优先扣 1 分：拆屋即拆人口与胜负，同威胁度时先拆屋
      if (h.kind === "hut") score -= 1;
      const d = dist2(h.x, h.z, from.x, from.z);
      if (score < bestScore || (score === bestScore && d < bestD)) {
        bestScore = score;
        bestD = d;
        best = h;
      }
    }
    return { x: best.x, z: best.z, targetId: best.id };
  }

  /** 集结点附近的散兵落点：按单位 id 确定性摊开（避免整队挤一个点对撞打转）。 */
  static scatter(anchor: Cell, unitId: number, radius = 2.0): Cell {
    const h1 = Math.sin(unitId * 12.9898) * 43758.5453;
    const fr = h1 - Math.floor(h1);
    const h2 = Math.sin(unitId * 78.233) * 12345.6789;
    const fa = (h2 - Math.floor(h2)) * Math.PI * 2;
    return { x: anchor.x + Math.cos(fa) * fr * radius, z: anchor.z + Math.sin(fa) * fr * radius };
  }
}
