// v0.36 出生点规划器：只读取 World 已完成的终局高度场/岛表，不参与岛屿生成。
// 分裂模式是硬不变量：双方必须落在两座不同的可玩岛；无解返回原因给外层确定性重生成。

import { ISLE_BASE_MIN, ISLE_FOREST_MIN, SAMPLES, STEP, WORLD } from "../types";
import { MASK_CHANNEL, MASK_PEAK } from "./terrain-features";
import type { Island, World } from "../world";
import { initialBaseLayout, type SpawnPoint, yawToward } from "./start-layout";

const OPEN_REACH = 6;
const OPEN_MIN = 6;
const START_RADIUS = 3.2;
const START_PREFER_H = 2;
const START_MAX_H = 5.2;
const START_HIGH_PENALTY = 12;
/** ISLE_FOREST_MIN 是平滑前 5× 余量；这里读终局地形，按其注释还原实际 400 格门槛。 */
const FINAL_FOREST_MIN = Math.ceil(ISLE_FOREST_MIN / 5);
/** flattenPad 的最大缓坡环带；完整开局布局在这个外扩内都必须仍属于目标岛。 */
const BASE_PAD_CLEARANCE = 2;
const CANDIDATE_STRIDE = 8; // 2 格；与旧 farthestPair 的终局精度一致
const CANDIDATE_LIMIT = 256; // 小岛约百余候选；不截掉岛心，否则低地偏好会只留下贴岸点
const OPEN_DIRS: ReadonlyArray<readonly [number, number]> = [
  [1, 0], [-1, 0], [0, 1], [0, -1],
  [0.7071, 0.7071], [0.7071, -0.7071], [-0.7071, 0.7071], [-0.7071, -0.7071],
];

interface Candidate {
  x: number;
  z: number;
  mean: number;
  localScore: number;
}

export interface SpawnPlan {
  starts: [SpawnPoint, SpawnPoint];
  islandLabels: [number, number];
}

export type SpawnPlanResult =
  | { ok: true; plan: SpawnPlan }
  | { ok: false; reason: "not-enough-islands" | "island-too-small" | "island-no-forest" | "no-start-pair" };

export class SpawnPlanner {
  /** 纯确定性入口：不持有 RNG；同一份终局地形必得同一对出生点。 */
  static plan(world: World, split: boolean, templateId: string): SpawnPlanResult {
    if (!world.islands.length) return { ok: false, reason: "not-enough-islands" };
    if (!split) {
      const isle = world.islands[0]!;
      const plan = this.connectedPair(world, isle, templateId);
      return plan ? { ok: true, plan } : { ok: false, reason: "no-start-pair" };
    }

    const large = world.islands.filter((i) => i.cells >= ISLE_BASE_MIN);
    if (large.length < 2) {
      return {
        ok: false,
        reason: world.islands.length < 2 ? "not-enough-islands" : "island-too-small",
      };
    }
    const playable = large.filter((i) => this.forestableCells(world, i.label) >= FINAL_FOREST_MIN);
    if (playable.length < 2) return { ok: false, reason: "island-no-forest" };

    // 保持既有队伍排序：蓝方最大可玩岛、红方第二大可玩岛；第三岛保持中立资源岛。
    const plan = this.splitPair(world, playable[0]!, playable[1]!);
    return plan ? { ok: true, plan } : { ok: false, reason: "no-start-pair" };
  }

  /** 出生平台落地并再次平滑后复验；失败时外层丢弃整次 attempt，绝不挪到同岛。 */
  static validate(world: World, plan: SpawnPlan, split: boolean): boolean {
    const a = world.islandAt(plan.starts[0].x, plan.starts[0].z);
    const b = world.islandAt(plan.starts[1].x, plan.starts[1].z);
    if (a < 0 || b < 0 || (split ? a === b : a !== b)) return false;
    if (!world.walkableAt(plan.starts[0].x, plan.starts[0].z) || !world.walkableAt(plan.starts[1].x, plan.starts[1].z)) return false;
    return this.layoutFits(world, plan.starts[0], a) && this.layoutFits(world, plan.starts[1], b);
  }

  private static splitPair(world: World, blue: Island, red: Island): SpawnPlan | null {
    const aa = this.candidates(world, blue.label);
    const bb = this.candidates(world, red.label);
    let best: SpawnPlan | null = null;
    let bestScore = -Infinity;
    for (const a of aa) {
      for (const b of bb) {
        const sa = this.makeStart(world, a, b.x, b.z);
        const sb = this.makeStart(world, b, a.x, a.z);
        if (!this.layoutFits(world, sa, blue.label) || !this.layoutFits(world, sb, red.label)) continue;
        const score = a.localScore + b.localScore + Math.hypot(a.x - b.x, a.z - b.z) * 0.02;
        if (score <= bestScore) continue;
        bestScore = score;
        best = { starts: [sa, sb], islandLabels: [blue.label, red.label] };
      }
    }
    return best;
  }

  private static connectedPair(world: World, isle: Island, templateId: string): SpawnPlan | null {
    const cand = this.candidates(world, isle.label);
    const minD = templateId === "peninsula" ? 24 : 36;
    let best: SpawnPlan | null = null;
    let bestScore = -Infinity;
    for (let i = 0; i < cand.length; i++) {
      const a = cand[i]!;
      for (let j = i + 1; j < cand.length; j++) {
        const b = cand[j]!;
        const d = Math.hypot(a.x - b.x, a.z - b.z);
        if (d < minD) continue;
        const score = d * d + (a.localScore + b.localScore) * 12;
        if (score <= bestScore) continue;
        const sa = this.makeStart(world, a, b.x, b.z);
        const sb = this.makeStart(world, b, a.x, a.z);
        if (!this.layoutFits(world, sa, isle.label) || !this.layoutFits(world, sb, isle.label)) continue;
        bestScore = score;
        best = { starts: [sa, sb], islandLabels: [isle.label, isle.label] };
      }
    }
    return best;
  }

  private static makeStart(world: World, c: Candidate, tx: number, tz: number): SpawnPoint {
    return {
      x: c.x,
      z: c.z,
      yaw: yawToward(c.x, c.z, tx, tz),
      h: Math.max(c.mean, world.heightAt(c.x, c.z), 0.8) + 0.25,
    };
  }

  private static candidates(world: World, label: number): Candidate[] {
    const out: Candidate[] = [];
    const margin = Math.round(4 / STEP);
    const rS = Math.ceil(START_RADIUS / STEP);
    const r2 = (START_RADIUS / STEP) ** 2;
    for (let iz = margin; iz < SAMPLES - margin; iz += CANDIDATE_STRIDE) {
      for (let ix = margin; ix < SAMPLES - margin; ix += CANDIDATE_STRIDE) {
        if (world.islandGrid[iz * SAMPLES + ix] !== label) continue;
        const st = this.circleStats(world, label, ix, iz, rS, r2);
        if (st.coverage < 0.8 || st.open < OPEN_MIN || st.maxH > START_MAX_H || st.feature) continue;
        if (!this.hasNearbyForestGround(world, label, ix * STEP, iz * STEP)) continue;
        const high = Math.max(0, st.mean - START_PREFER_H);
        out.push({
          x: ix * STEP,
          z: iz * STEP,
          mean: st.mean,
          localScore: st.coverage * 10 + st.open - START_HIGH_PENALTY * high * high,
        });
      }
    }
    out.sort((a, b) => b.localScore - a.localScore || a.z - b.z || a.x - b.x);
    return out.slice(0, CANDIDATE_LIMIT);
  }

  private static circleStats(
    world: World,
    label: number,
    cx: number,
    cz: number,
    rS: number,
    r2: number,
  ): { coverage: number; mean: number; maxH: number; open: number; feature: boolean } {
    let same = 0;
    let total = 0;
    let sum = 0;
    let maxH = 0;
    let feature = false;
    for (let dz = -rS; dz <= rS; dz++) {
      for (let dx = -rS; dx <= rS; dx++) {
        if (dx * dx + dz * dz > r2) continue;
        const ix = cx + dx;
        const iz = cz + dz;
        if (ix < 0 || iz < 0 || ix >= SAMPLES || iz >= SAMPLES) continue;
        const i = iz * SAMPLES + ix;
        const h = world.h[i]!;
        total++;
        sum += h;
        if (h > maxH) maxH = h;
        if (world.islandGrid[i] === label) same++;
        if ((world.fmask[i]! & (MASK_PEAK | MASK_CHANNEL)) !== 0) feature = true;
      }
    }
    return {
      coverage: total ? same / total : 0,
      mean: total ? sum / total : 0,
      maxH,
      open: this.openness(world, label, cx, cz),
      feature,
    };
  }

  private static openness(world: World, label: number, ix: number, iz: number): number {
    const reach = Math.round(OPEN_REACH / STEP);
    let n = 0;
    for (const [dx, dz] of OPEN_DIRS) {
      const jx = Math.round(ix + dx * reach);
      const jz = Math.round(iz + dz * reach);
      if (jx < 0 || jz < 0 || jx >= SAMPLES || jz >= SAMPLES) continue;
      if (world.islandGrid[jz * SAMPLES + jx] === label) n++;
    }
    return n;
  }

  /** 出生点 5~16 格环带内至少 20 个终局可种整格，保证锚定森林不是靠 90 次随机碰一个针眼。 */
  private static hasNearbyForestGround(world: World, label: number, x: number, z: number): boolean {
    let cells = 0;
    for (let dz = -16; dz <= 16; dz += 1) {
      for (let dx = -16; dx <= 16; dx += 1) {
        const d2 = dx * dx + dz * dz;
        if (d2 < 5.5 * 5.5 || d2 > 16 * 16) continue;
        const px = x + dx;
        const pz = z + dz;
        if (px < 1 || pz < 1 || px > WORLD - 1 || pz > WORLD - 1) continue;
        if (world.islandAt(px, pz) !== label || !world.cellLand(px, pz)) continue;
        if (world.heightAt(px, pz) < 2.6 && world.slopeAt(px, pz) <= 0.55 && ++cells >= 20) return true;
      }
    }
    return false;
  }

  private static layoutFits(world: World, start: SpawnPoint, label: number): boolean {
    for (const pad of initialBaseLayout(start)) {
      const reach = 0.5 * Math.hypot(pad.w, pad.d) + BASE_PAD_CLEARANCE;
      const c = Math.cos(-pad.yaw);
      const s = Math.sin(-pad.yaw);
      for (let z = pad.z - reach; z <= pad.z + reach + 1e-6; z += 0.5) {
        for (let x = pad.x - reach; x <= pad.x + reach + 1e-6; x += 0.5) {
          const dx = x - pad.x;
          const dz = z - pad.z;
          const lx = dx * c - dz * s;
          const lz = dx * s + dz * c;
          if (Math.abs(lx) > pad.w / 2 + BASE_PAD_CLEARANCE || Math.abs(lz) > pad.d / 2 + BASE_PAD_CLEARANCE) continue;
          if (x < 0 || z < 0 || x > WORLD || z > WORLD) return false;
          if (!world.cellLand(x, z) || world.islandAt(x, z) !== label) return false;
          // 神像周围 3.2 格的地物禁区已由 candidates() 检查；两侧茅屋允许落在可整平的缓丘上，
          // 否则一个远处 MASK_PEAK 边缘会把整座健康岛误判成无出生点。
        }
      }
    }
    return true;
  }

  private static forestableCells(world: World, label: number): number {
    let n = 0;
    for (let iz = 1; iz < SAMPLES - 2; iz++) {
      for (let ix = 1; ix < SAMPLES - 2; ix++) {
        const i = iz * SAMPLES + ix;
        if (world.islandGrid[i] !== label) continue;
        const x = ix * STEP;
        const z = iz * STEP;
        if (!world.cellLand(x, z) || world.heightAt(x, z) >= 2.6 || world.slopeAt(x, z) > 0.55) continue;
        if (++n >= FINAL_FOREST_MIN) return n;
      }
    }
    return n;
  }
}
