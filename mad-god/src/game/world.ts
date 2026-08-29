import {
  BLUE,
  Cell,
  clamp,
  inMap,
  MAX_H,
  MAX_SLOPE,
  padSize,
  RED,
  RNG,
  SAMPLES,
  STEP,
  Team,
  WATER,
  WORLD,
} from "./types";
import { WorldGen } from "./world-gen";
import { MASK_PEAK, type FeatureStat } from "./world-gen/terrain-features";
import { MapSmoother, type SmoothReport } from "./map-smoother";

export interface Pad {
  x: number;
  z: number;
  w: number;
  d: number;
  yaw: number;
}

export interface StartPad {
  x: number;
  z: number;
  yaw: number;
  h: number;
}

export function localOnPad(px: number, pz: number, pad: Pad): { x: number; z: number } {
  const dx = px - pad.x;
  const dz = pz - pad.z;
  const c = Math.cos(-pad.yaw);
  const s = Math.sin(-pad.yaw);
  return { x: dx * c - dz * s, z: dx * s + dz * c };
}

/**
 * 站位外扩（格）：padEdge 把"可站立的边缘点"放在地基边界再往外这么多，
 * 单位不会贴墙站（贴墙会与 resolveCollisions 的推出互斥、抖个没完）。
 * v0.24 提为常量：攻击建筑的射程判定也必须按同一口径算，否则会出现
 * "指令让你站的地方，比射程允许的更远"——武士永远拆不到屋（实测斜角差 0.03 格）。
 */
export const PAD_STAND_INFLATE = 0.62;

/**
 * 旋转矩形地基沿 (px,pz) 方向的**支撑半径**：从中心到该方向上边界点的距离。
 * 旧代码到处用 max(padW,padD)*0.5 当半径，等于把地基当圆——2.6 见方的地基从中心
 * 到边缘是 1.30（正对边）到 1.84（对角）之间变化，用定值就会让"能不能打到建筑"
 * 取决于单位从哪个方向接近。与 localOnPad 同一套坐标变换，口径一致。
 */
export function padSupportRadius(pad: Pad, px: number, pz: number): number {
  const l = localOnPad(px, pz, pad);
  const hw = pad.w / 2;
  const hd = pad.d / 2;
  const t = Math.max(Math.abs(l.x) / hw, Math.abs(l.z) / hd, 1e-6);
  return Math.hypot(l.x, l.z) / t;
}

export function inPad(px: number, pz: number, pad: Pad, inflate = 0): boolean {
  const l = localOnPad(px, pz, pad);
  return Math.abs(l.x) <= pad.w / 2 + inflate && Math.abs(l.z) <= pad.d / 2 + inflate;
}

export const TREE_BLOCK_R = 0.32;
export const DOOR_SLIT_HALF = 0.28;
export const DOOR_SLIT_DEPTH = 0.45;

// v0.18b 岩浆流体参数（flowLava 物理模拟用）。
export const NEIGH8: ReadonlyArray<readonly [number, number]> = [
  [1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1],
];
/** 低于该厚度的浆停止流动（凝固边缘）；v0.21 0.5→0.35：薄浆也淌，前沿铺得更开更汹涌 */
export const LAVA_FLOW_MIN = 0.35;
/** 平顶上超过该厚度才会向外漫溢（"攒厚了溢出"的阈值）；v0.21 3.0→2.2：更早漫溢出火山口 */
export const LAVA_SPREAD_AT = 2.2;
/** 单格岩浆厚度上限：超出部分转移/注入时蒸发（厚浆散热快），防洼地积出烧不完的深池 */
export const LAVA_MAX_DEPTH = 12;

export interface TreeBlock {
  x: number;
  z: number;
  r: number;
}

export function worldOnPad(lx: number, lz: number, pad: Pad): { x: number; z: number } {
  const c = Math.cos(pad.yaw);
  const s = Math.sin(pad.yaw);
  return { x: pad.x + lx * c - lz * s, z: pad.z + lx * s + lz * c };
}

/** Front door slit after pad.yaw: local +Z, |x| < ~0.28, z near +d/2. */
export function inDoorSlit(px: number, pz: number, pad: Pad): boolean {
  const l = localOnPad(px, pz, pad);
  const front = pad.d / 2;
  return Math.abs(l.x) < DOOR_SLIT_HALF && l.z >= front - DOOR_SLIT_DEPTH && l.z <= front + 0.16;
}

export function padsOverlap(a: Pad, b: Pad): boolean {
  const axes: [number, number][] = [
    [Math.cos(a.yaw), Math.sin(a.yaw)],
    [-Math.sin(a.yaw), Math.cos(a.yaw)],
    [Math.cos(b.yaw), Math.sin(b.yaw)],
    [-Math.sin(b.yaw), Math.cos(b.yaw)],
  ];
  const corners = (p: Pad): [number, number][] => {
    const hw = p.w / 2;
    const hd = p.d / 2;
    const c = Math.cos(p.yaw);
    const s = Math.sin(p.yaw);
    const out: [number, number][] = [];
    for (const [lx, lz] of [
      [-hw, -hd],
      [hw, -hd],
      [hw, hd],
      [-hw, hd],
    ] as const) {
      out.push([p.x + lx * c - lz * s, p.z + lx * s + lz * c]);
    }
    return out;
  };
  const ca = corners(a);
  const cb = corners(b);
  for (const [ax, az] of axes) {
    let minA = Infinity;
    let maxA = -Infinity;
    let minB = Infinity;
    let maxB = -Infinity;
    for (const [x, z] of ca) {
      const t = x * ax + z * az;
      if (t < minA) minA = t;
      if (t > maxA) maxA = t;
    }
    for (const [x, z] of cb) {
      const t = x * ax + z * az;
      if (t < minB) minB = t;
      if (t > maxB) maxB = t;
    }
    if (maxA < minB || maxB < minA) return false;
  }
  return true;
}

export function closestOnPad(px: number, pz: number, pad: Pad): { x: number; z: number } {
  const l = localOnPad(px, pz, pad);
  const hx = pad.w / 2;
  const hz = pad.d / 2;
  const lx = clamp(l.x, -hx, hx);
  const lz = clamp(l.z, -hz, hz);
  const c = Math.cos(pad.yaw);
  const s = Math.sin(pad.yaw);
  return { x: pad.x + lx * c - lz * s, z: pad.z + lx * s + lz * c };
}

export function pushCircleFromPad(
  px: number,
  pz: number,
  r: number,
  pad: Pad,
): { x: number; z: number } {
  const l = localOnPad(px, pz, pad);
  const hx = pad.w / 2;
  const hz = pad.d / 2;
  const cx = clamp(l.x, -hx, hx);
  const cz = clamp(l.z, -hz, hz);
  let dx = l.x - cx;
  let dz = l.z - cz;
  let lx = l.x;
  let lz = l.z;
  if (dx * dx + dz * dz < 1e-10) {
    const ox = hx - Math.abs(l.x);
    const oz = hz - Math.abs(l.z);
    if (ox < oz) lx += (l.x >= 0 ? 1 : -1) * (ox + r);
    else lz += (l.z >= 0 ? 1 : -1) * (oz + r);
  } else {
    const d = Math.hypot(dx, dz);
    if (d < r) {
      const push = (r - d) / d;
      lx += dx * push;
      lz += dz * push;
    }
  }
  const c = Math.cos(pad.yaw);
  const s = Math.sin(pad.yaw);
  return { x: pad.x + lx * c - lz * s, z: pad.z + lx * s + lz * c };
}

export class World {
  h: Float32Array;
  /**
   * v0.25 地貌特征掩膜（MASK_PEAK / MASK_CHANNEL 位或），与 h 等长。
   * 只在**生成期**有意义：它告诉后面的松弛/削峰/形态学工序"这一格的高差是地物、
   * 不是噪声毛刺"，从而对山体与河床轻手对待。对局中的法术雕刻不改它
   *（法术本来就该留下破坏痕迹，且那时平滑工序早就跑完了）。
   */
  fmask: Uint8Array;
  lava: Float32Array;
  scorch: Float32Array;
  swamp: Float32Array;
  pads: Pad[] = [];
  trees: TreeBlock[] = [];
  dirty = true;
  dirtyMinX = 0;
  dirtyMinZ = 0;
  dirtyMaxX = SAMPLES - 1;
  dirtyMaxZ = SAMPLES - 1;
  rng: RNG;
  starts: [StartPad, StartPad];
  lastSwampX = 0;
  lastSwampZ = 0;
  /** v0.24 生成种子（rng.s 会被推进，原 seed 单独存以便复现/日志）。 */
  genSeed = 0;
  /** v0.24 最后一次强制平滑的统计（填缺/削刺/去尖峰/残留绊人边数），供日志与检查断言。 */
  smoothReport: SmoothReport | null = null;
  /** v0.24 本图所用世界模板（供 logger 与 terrain-gen-check 断言；同 seed 必同模板）。 */
  templateId = "";
  templateName = "";
  /** v0.25 本图各地物的落地统计（山脉/河流/…），供日志与检查脚本断言"特征确实放上了"。 */
  genFeatures: FeatureStat[] = [];

  constructor(seed = 1989) {
    this.h = new Float32Array(SAMPLES * SAMPLES);
    this.fmask = new Uint8Array(SAMPLES * SAMPLES);
    this.lava = new Float32Array(SAMPLES * SAMPLES);
    this.scorch = new Float32Array(SAMPLES * SAMPLES);
    this.swamp = new Float32Array(SAMPLES * SAMPLES);
    this.rng = new RNG(seed);
    this.genSeed = seed;
    this.starts = [
      { x: 15, z: 54, yaw: 0.18, h: 2.05 },
      { x: 55, z: 15, yaw: -0.22, h: 2.05 },
    ];
    this.generate();
  }

  idx(ix: number, iz: number): number {
    return iz * SAMPLES + ix;
  }

  sampleAt(x: number, z: number): number {
    const ix = clamp(Math.round(x / STEP), 0, SAMPLES - 1);
    const iz = clamp(Math.round(z / STEP), 0, SAMPLES - 1);
    return this.idx(ix, iz);
  }

  inMap(x: number, z: number): boolean {
    return inMap(x, z);
  }

  inSample(ix: number, iz: number): boolean {
    return ix >= 0 && iz >= 0 && ix < SAMPLES && iz < SAMPLES;
  }

  height(x: number, z: number): number {
    return this.heightAt(x, z);
  }

  heightAt(x: number, z: number): number {
    const fx = clamp(x / STEP, 0, SAMPLES - 1);
    const fz = clamp(z / STEP, 0, SAMPLES - 1);
    const ix = Math.floor(fx);
    const iz = Math.floor(fz);
    const tx = fx - ix;
    const tz = fz - iz;
    const x1 = Math.min(ix + 1, SAMPLES - 1);
    const z1 = Math.min(iz + 1, SAMPLES - 1);
    const h00 = this.h[this.idx(ix, iz)]!;
    const h10 = this.h[this.idx(x1, iz)]!;
    const h01 = this.h[this.idx(ix, z1)]!;
    const h11 = this.h[this.idx(x1, z1)]!;
    return h00 * (1 - tx) * (1 - tz) + h10 * tx * (1 - tz) + h01 * (1 - tx) * tz + h11 * tx * tz;
  }

  normalAt(x: number, z: number): { x: number; y: number; z: number } {
    const e = STEP;
    const hL = this.heightAt(x - e, z);
    const hR = this.heightAt(x + e, z);
    const hD = this.heightAt(x, z - e);
    const hU = this.heightAt(x, z + e);
    const nx = hL - hR;
    const nz = hD - hU;
    const ny = 2 * e;
    const len = Math.hypot(nx, ny, nz) || 1;
    return { x: nx / len, y: ny / len, z: nz / len };
  }

  slopeAt(x: number, z: number): number {
    const e = STEP;
    const dhx = (this.heightAt(x + e, z) - this.heightAt(x - e, z)) / (2 * e);
    const dhz = (this.heightAt(x, z + e) - this.heightAt(x, z - e)) / (2 * e);
    return Math.hypot(dhx, dhz);
  }

  /**
   * v0.9 弹道视线：沿连线按 STEP 采样，任一点地形高出「两端较高地面 + 0.6」的
   * 平飞弹道线（留 0.12 落地余量）即视为遮挡。与 fireballHit 的飞行撞地判定同一条基准线。
   */
  losBlocked(x0: number, z0: number, x1: number, z1: number): boolean {
    const lineY = Math.max(this.heightAt(x0, z0), this.heightAt(x1, z1)) + 0.6;
    const dist = Math.hypot(x1 - x0, z1 - z0);
    const steps = Math.max(1, Math.ceil(dist / STEP));
    for (let i = 1; i < steps; i++) {
      const t = i / steps;
      const h = this.heightAt(x0 + (x1 - x0) * t, z0 + (z1 - z0) * t);
      if (h > lineY - 0.12) return true;
    }
    return false;
  }

  markSample(ix: number, iz: number): void {
    if (!this.dirty) {
      this.dirtyMinX = this.dirtyMaxX = ix;
      this.dirtyMinZ = this.dirtyMaxZ = iz;
      this.dirty = true;
      return;
    }
    if (ix < this.dirtyMinX) this.dirtyMinX = ix;
    if (ix > this.dirtyMaxX) this.dirtyMaxX = ix;
    if (iz < this.dirtyMinZ) this.dirtyMinZ = iz;
    if (iz > this.dirtyMaxZ) this.dirtyMaxZ = iz;
  }

  markAll(): void {
    this.dirty = true;
    this.dirtyMinX = 0;
    this.dirtyMinZ = 0;
    this.dirtyMaxX = SAMPLES - 1;
    this.dirtyMaxZ = SAMPLES - 1;
  }

  setSample(ix: number, iz: number, v: number): void {
    if (!this.inSample(ix, iz)) return;
    const nv = clamp(v, 0, MAX_H);
    const i = this.idx(ix, iz);
    if (this.h[i] === nv) return;
    this.h[i] = nv;
    this.markSample(ix, iz);
    if (nv <= WATER) {
      this.lava[i] = 0;
      this.swamp[i] = 0;
    }
  }

  /**
   * v0.24 单块可通行大陆：以游戏真实通行判据（h > WATER）做 4 邻接 BFS，只保留最大连通
   * 陆域，其余飞地降回浅海基准（0.04）。返回被填平的采样格数。
   * 为什么必要：WorldGen 的连通域标记只用于挑出生点，小块飞地仍是"可走陆地"——
   * 单位寻路/建筑随机取点一旦落到孤岛，astar 直接给不出完整路径
   *（实测 move-check 10 次挂 4 次：plain arrives d=6.13、long path len=30 截断）。
   * 本项目没有船只，跨海不可达的地块对玩法就是废地块，填平成海才是一劳永逸的解。
   * 必须放在滩涂抬升**之后**：滩涂 0.16 仍低于 WATER，不会被垫成假连通；
   * 也必须在出生平台整平之前：出生点已由 WorldGen 保证落在其最大域内，这里再校验一次，
   * 万一该格被本步骤判为飞地（平滑/削峰改变了海陆界），就地迁到保留域内的最近格。
   */
  floodDisconnectedLand(): number {
    const n = SAMPLES * SAMPLES;
    const lab = new Int32Array(n).fill(-1);
    const queue = new Int32Array(n); // BFS 队列入队总次数 ≤ 格数，一次预分配
    let kept = -1;
    let keptCount = 0;
    let label = 0;
    for (let i = 0; i < n; i++) {
      if (lab[i] !== -1 || this.h[i]! <= WATER) continue;
      let head = 0;
      let tail = 0;
      queue[tail++] = i;
      lab[i] = label;
      while (head < tail) {
        const cur = queue[head++]!;
        const cz = (cur / SAMPLES) | 0;
        const cx = cur - cz * SAMPLES;
        // 4 邻接（不用 8 邻接）：对角相接不算连通，与 astar 的通行语义一致。
        if (cx > 0) {
          const nb = cur - 1;
          if (lab[nb] === -1 && this.h[nb]! > WATER) {
            lab[nb] = label;
            queue[tail++] = nb;
          }
        }
        if (cx < SAMPLES - 1) {
          const nb = cur + 1;
          if (lab[nb] === -1 && this.h[nb]! > WATER) {
            lab[nb] = label;
            queue[tail++] = nb;
          }
        }
        if (cz > 0) {
          const nb = cur - SAMPLES;
          if (lab[nb] === -1 && this.h[nb]! > WATER) {
            lab[nb] = label;
            queue[tail++] = nb;
          }
        }
        if (cz < SAMPLES - 1) {
          const nb = cur + SAMPLES;
          if (lab[nb] === -1 && this.h[nb]! > WATER) {
            lab[nb] = label;
            queue[tail++] = nb;
          }
        }
      }
      if (tail > keptCount) {
        keptCount = tail;
        kept = label;
      }
      label++;
    }
    let flooded = 0;
    for (let i = 0; i < n; i++) {
      if (this.h[i]! <= WATER || lab[i] === kept) continue;
      // 走 setSample：降为海的同时清掉该格 lava/swamp，语义与天然海格一致。
      this.setSample(i % SAMPLES, (i / SAMPLES) | 0, 0.04);
      flooded++;
    }
    // 出生点若被判为飞地（削峰/平滑改写了海陆界时才可能），螺旋迁到保留域内最近格。
    for (const s of this.starts) {
      const si = (Math.round(s.z / STEP) * SAMPLES + Math.round(s.x / STEP)) | 0;
      if (lab[si] === kept) continue;
      let bx = -1;
      let bz = -1;
      outer: for (let r = 1; r < 40; r++) {
        for (let dz = -r; dz <= r; dz++) {
          for (let dx = -r; dx <= r; dx++) {
            if (Math.abs(dx) !== r && Math.abs(dz) !== r) continue;
            const ix = Math.round(s.x / STEP) + dx;
            const iz = Math.round(s.z / STEP) + dz;
            if (ix < 1 || iz < 1 || ix >= SAMPLES - 1 || iz >= SAMPLES - 1) continue;
            if (lab[iz * SAMPLES + ix] !== kept) continue;
            bx = ix * STEP;
            bz = iz * STEP;
            break outer;
          }
        }
      }
      if (bx >= 0) {
        s.x = bx;
        s.z = bz;
      }
    }
    return flooded;
  }

  /**
   * v0.24 坡度钳制：把任意相邻采样的高差压到 maxDH 以内（削峰，不填谷）——
   * ridge 窄脊等陡壁靠盒滤压不平时使用；多轮迭代让削掉的量沿坡向下传导。
   * 只处理陆地格（水面以下不动），保证坡度测试阈值稳定通过。
   * v0.24 修正两处漏网：
   * 1) 原来只扫 [1..SAMPLES-2]，**图边框一整圈从未被钳过**——peninsula 模板的陆地
   *    本来就是贴边伸入的（楔形基底压图边），边框处留下 2.9+ 的陡壁（坡度检查挂）。
   *    现在全格扫描，越界的邻格直接不参与比较。
   * 2) 观测口径 slopeAt 是 hypot(Δh/Δx, Δh/Δz) 的中心差分：45° 斜坡上两个分量同时取满，
   *    实测上界 = hypot(1,1)×(2·maxDH/0.5格)。maxDH 取 0.40 时理论上界 2.26，
   *    给坡度检查的阈值 2.5 留出余量（0.55 时上界 2.545，正好压线导致偶发超标）。
   */
  clampSlope(maxDH: number): void {
    // v0.24 改成 chamfer 式双向扫描。
    // 旧写法是单向 Gauss-Seidel（每轮按行扫描、只跟 4 邻比较）：往"右下"方向一遍就能
    // 传到位，往"左上"方向要一格一轮——72 格图（289 采样）最坏要 ~150 轮，实测 465ms，
    // 光造一张图就够玩家感觉到卡顿。现在正向（左上→右下，吃左/上邻）+ 反向
    //（右下→左上，吃右/下邻）各扫一遍即可把削量传到全图，4 轮内必然收敛。
    const cap = (nh: number) => Math.max(WATER + 0.02, nh + maxDH);
    for (let round = 0; round < 4; round++) {
      let changed = false;
      for (let iz = 0; iz < SAMPLES; iz++) {
        for (let ix = 0; ix < SAMPLES; ix++) {
          const i = iz * SAMPLES + ix;
          if (this.h[i]! <= WATER) continue;
          let v = this.h[i]!;
          if (ix > 0) v = Math.min(v, cap(this.h[i - 1]!));
          if (iz > 0) v = Math.min(v, cap(this.h[i - SAMPLES]!));
          if (v !== this.h[i]) {
            this.h[i] = v;
            changed = true;
          }
        }
      }
      for (let iz = SAMPLES - 1; iz >= 0; iz--) {
        for (let ix = SAMPLES - 1; ix >= 0; ix--) {
          const i = iz * SAMPLES + ix;
          if (this.h[i]! <= WATER) continue;
          let v = this.h[i]!;
          if (ix < SAMPLES - 1) v = Math.min(v, cap(this.h[i + 1]!));
          if (iz < SAMPLES - 1) v = Math.min(v, cap(this.h[i + SAMPLES]!));
          if (v !== this.h[i]) {
            this.h[i] = v;
            changed = true;
          }
        }
      }
      if (!changed) break;
    }
  }

  /**
   * v0.13 盒式松弛：对 [minIx..maxIx]×[minIz..maxIz] 做 iter 轮 3×3 邻域均值。
   * 水面以下样本保持原值（clamp 不动），避免海岸被抹平；全部走脏区机制。
   *
   * v0.25 特征感知：登记过 MASK_PEAK 的山体只吃 PEAK_RELAX 倍的拉近量。
   * 为什么必须这样而不是"少做几轮"：7 轮松弛是为"可走区丝滑"服务的（v0.24 的
   * 硬指标），一刀切减轮数会让平原重新长出绊人缝；而山体的 footprint 有 3~5 格宽，
   * 7 轮 3×3 box 的有效模糊半径 ≈2.2 采样（约 0.55 格），足矣把 5 格高的山头
   * 削成 2 格多的丘陵——正是"加了山又等于没加"。所以只对山体减弱力度，平原照旧全松弛。
   */
  smoothField(iter: number, minIx: number, minIz: number, maxIx: number, maxIz: number): void {
    /** 山体的松弛保留系数：0.25 = 只往均值挪四分之一，其余照旧全量。 */
    const PEAK_RELAX = 0.25;
    const loIx = Math.max(1, minIx);
    const loIz = Math.max(1, minIz);
    const hiIx = Math.min(SAMPLES - 2, maxIx);
    const hiIz = Math.min(SAMPLES - 2, maxIz);
    const tmp = new Float32Array(this.h.length);
    for (let pass = 0; pass < iter; pass++) {
      for (let iz = loIz; iz <= hiIz; iz++) {
        for (let ix = loIx; ix <= hiIx; ix++) {
          const i = this.idx(ix, iz);
          if (this.h[i]! <= WATER) continue;
          tmp[i] =
            (this.h[this.idx(ix - 1, iz - 1)]! +
              this.h[this.idx(ix, iz - 1)]! +
              this.h[this.idx(ix + 1, iz - 1)]! +
              this.h[this.idx(ix - 1, iz)]! +
              this.h[i]! +
              this.h[this.idx(ix + 1, iz)]! +
              this.h[this.idx(ix - 1, iz + 1)]! +
              this.h[this.idx(ix, iz + 1)]! +
              this.h[this.idx(ix + 1, iz + 1)]!) /
            9;
        }
      }
      for (let iz = loIz; iz <= hiIz; iz++) {
        for (let ix = loIx; ix <= hiIx; ix++) {
          const i = this.idx(ix, iz);
          if (this.h[i]! <= WATER || tmp[i] === 0) continue;
          const w = (this.fmask[i]! & MASK_PEAK) !== 0 ? PEAK_RELAX : 1;
          this.h[i] = this.h[i]! + (tmp[i]! - this.h[i]!) * w;
          this.markSample(ix, iz);
        }
      }
    }
  }

  sculpt(x: number, z: number, radius: number, dh: number): boolean {
    const r = Math.max(0.2, radius);
    const minIx = clamp(Math.floor((x - r) / STEP), 0, SAMPLES - 1);
    const maxIx = clamp(Math.ceil((x + r) / STEP), 0, SAMPLES - 1);
    const minIz = clamp(Math.floor((z - r) / STEP), 0, SAMPLES - 1);
    const maxIz = clamp(Math.ceil((z + r) / STEP), 0, SAMPLES - 1);
    let changed = false;
    for (let iz = minIz; iz <= maxIz; iz++) {
      for (let ix = minIx; ix <= maxIx; ix++) {
        const wx = ix * STEP;
        const wz = iz * STEP;
        const d = Math.hypot(wx - x, wz - z);
        if (d > r) continue;
        // v0.13 smoothstep falloff：笔刷边缘导数归零（C1 连续），不再留唇沿。
        const t = 1 - d / r;
        const falloff = t * t * (3 - 2 * t);
        const i = this.idx(ix, iz);
        const nv = clamp(this.h[i]! + dh * falloff, 0, MAX_H);
        if (nv !== this.h[i]) {
          this.h[i] = nv;
          this.markSample(ix, iz);
          changed = true;
        }
      }
    }
    return changed;
  }

  flattenPad(cx: number, cz: number, w: number, d: number, yaw: number, h: number): void {
    const target = clamp(h, 0, MAX_H);
    const pad: Pad = { x: cx, z: cz, w, d, yaw };
    const reach = 0.5 * Math.hypot(w, d) + 0.6;
    const minIx = clamp(Math.floor((cx - reach) / STEP), 0, SAMPLES - 1);
    const maxIx = clamp(Math.ceil((cx + reach) / STEP), 0, SAMPLES - 1);
    const minIz = clamp(Math.floor((cz - reach) / STEP), 0, SAMPLES - 1);
    const maxIz = clamp(Math.ceil((cz + reach) / STEP), 0, SAMPLES - 1);
    for (let iz = minIz; iz <= maxIz; iz++) {
      for (let ix = minIx; ix <= maxIx; ix++) {
        const px = ix * STEP;
        const pz = iz * STEP;
        if (inPad(px, pz, pad, 0.45)) {
          // pad 内部（含 0.45 膨胀）精确平整：房屋地基要求不变。
          this.setSample(ix, iz, target);
          continue;
        }
        if (inPad(px, pz, pad, 2.0)) {
          // v0.13 环形缓坡：pad 外 0.45~2.0 带 smoothstep 过渡到原地形（C1 连续，消除四周断崖）。
          const l = localOnPad(px, pz, pad);
          const infl = Math.max(Math.abs(l.x) - pad.w / 2, Math.abs(l.z) - pad.d / 2, 0);
          const t = clamp(infl / 1.55, 0, 1);
          const f = t * t * (3 - 2 * t);
          const i = this.idx(ix, iz);
          const nv = this.h[i]! + (target - this.h[i]!) * (1 - f);
          if (nv !== this.h[i]) {
            this.h[i] = nv;
            this.markSample(ix, iz);
          }
        }
      }
    }
    // v0.13 环形带 1 轮松弛：圆滑缓坡两端拐角（只写环形带，pad 内部保持精确平整）。
    for (let iz = minIz; iz <= maxIz; iz++) {
      for (let ix = minIx; ix <= maxIx; ix++) {
        const px = ix * STEP;
        const pz = iz * STEP;
        if (inPad(px, pz, pad, 0.45) || !inPad(px, pz, pad, 2.3)) continue;
        const i = this.idx(ix, iz);
        if (this.h[i]! <= WATER) continue;
        let sum = 0;
        for (let dz = -1; dz <= 1; dz++) {
          for (let dx = -1; dx <= 1; dx++) sum += this.h[this.idx(ix + dx, iz + dz)]!;
        }
        this.h[i] = sum / 9;
        this.markSample(ix, iz);
      }
    }
  }

  land(x: number, z: number): boolean {
    return this.inMap(x, z) && this.heightAt(x, z) > WATER;
  }

  /**
   * 所在双线性格是否四角全为陆地（取格口径与 heightAt 完全一致）。
   * v0.24 新增：「整格一致」可走判据的基础，见 walkableAt。
   */
  cellLand(x: number, z: number): boolean {
    const fx = clamp(x / STEP, 0, SAMPLES - 1);
    const fz = clamp(z / STEP, 0, SAMPLES - 1);
    const ix = Math.floor(fx);
    const iz = Math.floor(fz);
    const x1 = Math.min(ix + 1, SAMPLES - 1);
    const z1 = Math.min(iz + 1, SAMPLES - 1);
    return (
      this.h[this.idx(ix, iz)]! > WATER &&
      this.h[this.idx(x1, iz)]! > WATER &&
      this.h[this.idx(ix, z1)]! > WATER &&
      this.h[this.idx(x1, z1)]! > WATER
    );
  }

  walkableAt(x: number, z: number): boolean {
    if (!this.inMap(x, z)) return false;
    // v0.24 陆海可走性升到「整格一致」：所在双线性格的 4 个角点必须全是陆地。
    // 旧判据 heightAt(x,z) > WATER 是**点判据**，允许"正好踩在一个海角上"算陆，
    // 于是同一条线段两端都可走、中段却被另一侧的海角点拉回水下：实测半岛 seed 7
    // 的 walker 站在 (63.62,22.97)，正前方 0.11 格处 h=0.106——这种格内不一致是
    // 寻路/移动层怎么加密采样都追不上的（永远有更细的缝）。
    // 而双线性是四角的凸组合：四角都 >WATER ⟹ 格内处处 >WATER，
    // 从此点判据对整条线段都说话算话，而不是只对端点算话。代价是岸边少掉 ≤0.25 格。
    if (!this.cellLand(x, z)) return false;
    for (const p of this.pads) {
      if (inPad(x, z, p) && !inDoorSlit(x, z, p)) return false;
    }
    for (const t of this.trees) {
      const dx = x - t.x;
      const dz = z - t.z;
      if (dx * dx + dz * dz < t.r * t.r) return false;
    }
    return true;
  }

  walkable(x: number, z: number): boolean {
    return this.walkableAt(x, z);
  }

  setPads(pads: Pad[]): void {
    this.pads = pads;
  }

  setTrees(trees: TreeBlock[]): void {
    this.trees = trees;
  }

  padStats(cx: number, cz: number, w: number, d: number, yaw: number): {
    land: number;
    mean: number;
    variance: number;
    maxSlope: number;
    n: number;
  } {
    const pad: Pad = { x: cx, z: cz, w, d, yaw };
    const reach = 0.5 * Math.hypot(w, d) + STEP;
    const minIx = clamp(Math.floor((cx - reach) / STEP), 0, SAMPLES - 1);
    const maxIx = clamp(Math.ceil((cx + reach) / STEP), 0, SAMPLES - 1);
    const minIz = clamp(Math.floor((cz - reach) / STEP), 0, SAMPLES - 1);
    const maxIz = clamp(Math.ceil((cz + reach) / STEP), 0, SAMPLES - 1);
    let n = 0;
    let land = 0;
    let sum = 0;
    let maxSlope = 0;
    const hs: number[] = [];
    for (let iz = minIz; iz <= maxIz; iz++) {
      for (let ix = minIx; ix <= maxIx; ix++) {
        const wx = ix * STEP;
        const wz = iz * STEP;
        if (!inPad(wx, wz, pad)) continue;
        const hv = this.h[this.idx(ix, iz)]!;
        n++;
        hs.push(hv);
        sum += hv;
        if (hv > WATER) land++;
        const sl = this.slopeAt(wx, wz);
        if (sl > maxSlope) maxSlope = sl;
      }
    }
    if (!n) return { land: 0, mean: 0, variance: 99, maxSlope: 99, n: 0 };
    const mean = sum / n;
    let acc = 0;
    for (const hv of hs) acc += (hv - mean) * (hv - mean);
    return { land: land / n, mean, variance: acc / n, maxSlope, n };
  }

  padReady(cx: number, cz: number, w: number, d: number, yaw: number): boolean {
    const s = this.padStats(cx, cz, w, d, yaw);
    return s.n > 0 && s.land >= 0.80 && s.variance < 0.22 && s.maxSlope < 0.70 && s.mean > WATER;
  }

  /** v0.11a：房屋占地各级恒定，地形只判「可住 / 不可住」；任何就绪的 L1 pad 都可一路升到 L3。 */
  houseLevelAt(cx: number, cz: number, yaw = 0): number {
    const pad = padSize(1);
    return this.padReady(cx, cz, pad.w, pad.d, yaw) ? 3 : 0;
  }

  countMismatch(cx: number, cz: number, radius: number, targetH: number): Cell[] {
    const out: Cell[] = [];
    const step = 0.5;
    for (let z = cz - radius; z <= cz + radius + 1e-6; z += step) {
      for (let x = cx - radius; x <= cx + radius + 1e-6; x += step) {
        if (!this.inMap(x, z)) continue;
        if (Math.abs(this.heightAt(x, z) - targetH) > 0.12) out.push({ x, z });
      }
    }
    return out;
  }

  landCells(): Cell[] {
    const out: Cell[] = [];
    for (let z = 1; z < WORLD; z += 1) {
      for (let x = 1; x < WORLD; x += 1) {
        if (this.heightAt(x, z) > WATER) out.push({ x, z });
      }
    }
    return out;
  }

  paintSwamp(x: number, z: number): number {
    const r = 1.85;
    const life = 28 + ((Math.abs((x * 17 + z * 9) | 0) % 10));
    let n = 0;
    const minIx = clamp(Math.floor((x - r - 0.8) / STEP), 0, SAMPLES - 1);
    const maxIx = clamp(Math.ceil((x + r + 0.8) / STEP), 0, SAMPLES - 1);
    const minIz = clamp(Math.floor((z - r - 0.8) / STEP), 0, SAMPLES - 1);
    const maxIz = clamp(Math.ceil((z + r + 0.8) / STEP), 0, SAMPLES - 1);
    for (let iz = minIz; iz <= maxIz; iz++) {
      for (let ix = minIx; ix <= maxIx; ix++) {
        const wx = ix * STEP;
        const wz = iz * STEP;
        const d = Math.hypot(wx - x, wz - z);
        const wob = Math.sin(ix * 1.7 + iz * 0.6) * 0.55 + Math.cos(iz * 1.3) * 0.35;
        if (d > r + wob) continue;
        const h = this.h[this.idx(ix, iz)]!;
        if (h <= WATER) continue;
        if (this.slopeAt(wx, wz) >= MAX_SLOPE * 0.92 && ((ix + iz) & 1) === 1) continue;
        this.swamp[this.idx(ix, iz)] = life;
        n++;
      }
    }
    if (n) {
      this.lastSwampX = x;
      this.lastSwampZ = z;
      this.markAll();
    }
    return n;
  }

  lastRiverTips: { x: number; z: number }[] = [];
  lastRiverCells: { x: number; z: number; ang: number }[] = [];

  growRivers(cx: number, cz: number, reach: number): { x: number; z: number }[] {
    this.lava.fill(0);
    this.lastRiverTips = [];
    this.lastRiverCells = [];
    const splash: { x: number; z: number }[] = [];
    const stepLen = 0.32;
    for (let k = 0; k < 4; k++) {
      const ang = k * (Math.PI / 2) + 0.22;
      const dx = Math.cos(ang);
      const dz = Math.sin(ang);
      let tipX = cx;
      let tipZ = cz;
      for (let s = 0; s <= reach; s++) {
        const x = cx + dx * s * stepLen;
        const z = cz + dz * s * stepLen;
        if (!inMap(x, z)) break;
        const i = this.sampleAt(x, z);
        this.lava[i] = 3.6;
        this.scorch[i] = Math.max(this.scorch[i]!, 1.1);
        this.lastRiverCells.push({ x, z, ang });
        this.markSample(clamp(Math.round(x / STEP), 0, SAMPLES - 1), clamp(Math.round(z / STEP), 0, SAMPLES - 1));
        tipX = x;
        tipZ = z;
        if (s >= 6 && s === reach) splash.push({ x, z });
      }
      this.lastRiverTips.push({ x: tipX, z: tipZ });
    }
    return splash;
  }

  sinkTrench(x: number, z: number, depth: number, radius: number): void {
    const r = Math.max(0.18, radius);
    const minIx = clamp(Math.floor((x - r) / STEP), 0, SAMPLES - 1);
    const maxIx = clamp(Math.ceil((x + r) / STEP), 0, SAMPLES - 1);
    const minIz = clamp(Math.floor((z - r) / STEP), 0, SAMPLES - 1);
    const maxIz = clamp(Math.ceil((z + r) / STEP), 0, SAMPLES - 1);
    for (let iz = minIz; iz <= maxIz; iz++) {
      for (let ix = minIx; ix <= maxIx; ix++) {
        const wx = ix * STEP;
        const wz = iz * STEP;
        const d = Math.hypot(wx - x, wz - z);
        if (d > r) continue;
        // v0.13 smoothstep falloff：坑沿 C1 连续，不再留唇沿。
        const t = 1 - d / r;
        const fall = t * t * (3 - 2 * t);
        const i = this.idx(ix, iz);
        const orig = this.h[i]!;
        // v0.24 陆地格坑底不得入水：低地（如 0.8 的整平平台）挖 0.64 深的沟会让沟底
        // 掉到 0.16 < WATER，地震裂缝变成水道——岩浆泡在水里（seedLava 的浆会被
        // setSample 的水下清除逻辑抹掉），裂缝上也找不到任何立足点/可建点。
        // 只钳陆地格（原高 > WATER），水下格保持"最低 0.02"的原语义。
        const floorH = orig > WATER ? WATER + 0.14 : 0.02;
        const nv = Math.max(floorH, orig - depth * fall);
        if (nv !== orig) {
          this.h[i] = nv;
          this.markSample(ix, iz);
        }
      }
    }
  }

  seedLava(x: number, z: number, r: number, life: number): void {
    const minIx = clamp(Math.floor((x - r) / STEP), 0, SAMPLES - 1);
    const maxIx = clamp(Math.ceil((x + r) / STEP), 0, SAMPLES - 1);
    const minIz = clamp(Math.floor((z - r) / STEP), 0, SAMPLES - 1);
    const maxIz = clamp(Math.ceil((z + r) / STEP), 0, SAMPLES - 1);
    for (let iz = minIz; iz <= maxIz; iz++) {
      for (let ix = minIx; ix <= maxIx; ix++) {
        const d = Math.hypot(ix * STEP - x, iz * STEP - z);
        if (d > r) continue;
        const i = this.idx(ix, iz);
        this.lava[i] = Math.max(this.lava[i]!, life);
        // v0.18 播浆必留焦土（与 growRivers 一致）：seedLava 是地震等法术铺浆的唯一入口，
        // 若不在此写 scorch，干涸后地面不会留下灰褐焦土。
        this.scorch[i] = Math.max(this.scorch[i]!, 1.1);
        this.markSample(ix, iz);
      }
    }
  }

  /**
   * v0.22 平滑穹顶火山（替代 v0.18 平顶高原与 v0.20 按格噪声）：
   * - **中间高、四周矮**：幂函数锥 (d/r)^1.2——顶部圆滑（火山口）、径向快速单调下降，
   *   岩浆从山顶溢出顺坡向四周流。
   * - **直接设形状**（须传 cast 时的原地面快照 orig）：迭代逼近公式的不动点全是 target，
   *   动画收敛后必然抹成平顶（v0.18 高原的成因）；用快照直接算 target×(1-f)+orig×f 才精确。
   * - 低频方位不规则：有效半径随方位角连续正弦扰动 ±15%（phase 由 spell 随机传入）——平滑的山形各向差异。
   * 水面以下样本由 setSample 内部清 lava/swamp。
   */
  raisePlateau(x: number, z: number, r: number, h: number, phase: number, orig: Float32Array): void {
    const target = clamp(h, 0, MAX_H);
    const minIx = clamp(Math.floor((x - r) / STEP), 0, SAMPLES - 1);
    const maxIx = clamp(Math.ceil((x + r) / STEP), 0, SAMPLES - 1);
    const minIz = clamp(Math.floor((z - r) / STEP), 0, SAMPLES - 1);
    const maxIz = clamp(Math.ceil((z + r) / STEP), 0, SAMPLES - 1);
    for (let iz = minIz; iz <= maxIz; iz++) {
      for (let ix = minIx; ix <= maxIx; ix++) {
        const px = ix * STEP;
        const pz = iz * STEP;
        const dx = px - x;
        const dz = pz - z;
        const d = Math.hypot(dx, dz);
        // 低频方位扰动：连续正弦（平滑），±15%。
        const theta = Math.atan2(dz, dx);
        const rEff = r * (1 + 0.15 * Math.sin(3 * theta + phase));
        if (d > rEff) continue;
        const factor = Math.pow(clamp(d / rEff, 0, 1), 1.2);
        const i = this.idx(ix, iz);
        // 直接设：格目标 = 原高 × factor + target × (1-factor)（中心=target，边缘保持原地面）。
        const nv = clamp(orig[i]! + (target - orig[i]!) * (1 - factor), 0, MAX_H);
        if (nv !== this.h[i]) {
          this.h[i] = nv;
          this.markSample(ix, iz);
        }
      }
    }
    // 1 轮盒式松弛：抹平数字误差毛刺，保持整体平滑（穹顶本身平滑不怕抹）。
    for (let iz = minIz + 1; iz < maxIz; iz++) {
      for (let ix = minIx + 1; ix < maxIx; ix++) {
        const px = ix * STEP;
        const pz = iz * STEP;
        const d = Math.hypot(px - x, pz - z);
        if (d > r) continue;
        const i = this.idx(ix, iz);
        if (this.h[i]! <= WATER) continue;
        let sum = 0;
        for (let dz = -1; dz <= 1; dz++) {
          for (let dx = -1; dx <= 1; dx++) sum += this.h[this.idx(ix + dx, iz + dz)]!;
        }
        this.h[i] = sum / 9;
        this.markSample(ix, iz);
      }
    }
  }

  /**
   * v0.18b 岩浆流体模拟（火山物理溢流，替代旧"最陡邻居确定性搬移"）：
   * - 每帧向「按高差平方加权**随机**选出的下坡邻居」转移——随机选择产生不规则舌状前沿，
   *   而非均匀圆盘/旋转扫描（用户反馈的"麦田怪圈"）；薄浆（<FLOW_MIN）停滞凝结，形成参差边缘。
   * - 无更低邻居且浆厚超过 SPREAD_AT（平顶高原）时，向随机等高/微高邻居溢出推进——
   *   "从口里越喷越多、攒厚了向外溢"的物理观感。
   * - 岩浆流入海格（h<=WATER）直接熄灭（转移量丢弃），海岸形成止步线。
   * - 转移守恒（源扣+目加），总量只被 tickFx 冷却消耗。
   * 只在火山活动期由 VolcanoSpell 调用（地震裂缝是沟内静态浆，不参与流动）。
   */
  flowLava(dt: number): void {
    const add = new Float32Array(this.lava.length);
    for (let iz = 1; iz < SAMPLES - 1; iz++) {
      for (let ix = 1; ix < SAMPLES - 1; ix++) {
        const i = this.idx(ix, iz);
        const amt = this.lava[i]!;
        if (amt < LAVA_FLOW_MIN) continue; // 薄浆停滞：形成参差的凝固边缘
        const h = this.h[i]!;
        this.scorch[i] = Math.max(this.scorch[i]!, 1.15);
        // 候选下坡邻居：高差平方做权重 → 陡坡优先但带随机，分叉不规则。
        let total = 0;
        const cand: number[] = [];
        const w: number[] = [];
        for (let k = 0; k < 8; k++) {
          const j = this.idx(ix + NEIGH8[k]![0], iz + NEIGH8[k]![1]);
          const dh = h - this.h[j]!;
          if (dh > 0.012) {
            const weight = dh * dh;
            cand.push(j);
            w.push(weight);
            total += weight;
          }
        }
        let target = -1;
        if (cand.length > 0) {
          let r = Math.random() * total;
          target = cand[cand.length - 1]!;
          for (let k = 0; k < cand.length; k++) {
            r -= w[k]!;
            if (r <= 0) {
              target = cand[k]!;
              break;
            }
          }
          // 入海熄灭：目标是水格则转移量丢弃（岩浆到海岸止步"嗤"灭）。
          if (this.h[target]! <= WATER) target = -1;
        } else if (amt > LAVA_SPREAD_AT) {
          // 平顶溢出：浆攒厚了向随机平/微高邻居推进（火山平顶的向外漫溢）。
          const k = (Math.random() * 8) | 0;
          const j = this.idx(ix + NEIGH8[k]![0], iz + NEIGH8[k]![1]);
          if (this.h[j]! <= h + 0.05 && this.h[j]! > WATER) target = j;
        }
        if (target >= 0) {
          // v0.21 湍急化：流速近翻倍（0.9+amt*0.12 → 1.7+amt*0.2）——前沿汹涌推进而非缓缓渗淌。
          const move = Math.min(amt * 0.5, dt * (1.7 + amt * 0.2));
          add[i] -= move;
          // 厚度上限 LAVA_MAX_DEPTH：超出部分在转移时蒸发（厚浆表面积大散热快）——
          // 防止洼地积出几十秒烧不完的深池。
          add[target] += Math.min(move, Math.max(0, LAVA_MAX_DEPTH - this.lava[target]!));
          if (this.lava[target]! <= 0) this.scorch[target] = Math.max(this.scorch[target]!, 0.85);
        }
      }
    }
    for (let i = 0; i < add.length; i++) {
      if (add[i] === 0) continue;
      this.lava[i] = Math.max(0, this.lava[i]! + add[i]!);
      this.markSample(i % SAMPLES, (i / SAMPLES) | 0);
    }
  }

  /** v0.18b 火山源头注入：向 (x,z) 半径 r 内**累加**岩浆（seedLava 是 max 截断语义，注入需要累加）。 */
  pourLava(x: number, z: number, r: number, amount: number): void {
    const minIx = clamp(Math.floor((x - r) / STEP), 0, SAMPLES - 1);
    const maxIx = clamp(Math.ceil((x + r) / STEP), 0, SAMPLES - 1);
    const minIz = clamp(Math.floor((z - r) / STEP), 0, SAMPLES - 1);
    const maxIz = clamp(Math.ceil((z + r) / STEP), 0, SAMPLES - 1);
    for (let iz = minIz; iz <= maxIz; iz++) {
      for (let ix = minIx; ix <= maxIx; ix++) {
        const d = Math.hypot(ix * STEP - x, iz * STEP - z);
        if (d > r) continue;
        const i = this.idx(ix, iz);
        if (this.h[i]! <= WATER) continue;
        // 中心满量、边缘 60%：喷口聚集、口缘散落；厚度封顶 LAVA_MAX_DEPTH（超出蒸发）。
        const f = d < r * 0.5 ? 1 : 0.6;
        this.lava[i] = Math.min(LAVA_MAX_DEPTH, this.lava[i]! + amount * f);
        this.markSample(ix, iz);
      }
    }
  }

  tickFx(dt: number): void {
    for (let i = 0; i < this.lava.length; i++) {
      if (this.lava[i]! > 0) {
        // v0.18b 冷却 1.0→1.4/s：火山物理溢流会在洼地积成厚池，冷却太慢会让岩浆池烧一分多钟；
        // quake 的 seed 寿命 6~10 → 干涸 4~7s，仍落在"5~10 秒"要求区间。
        this.lava[i] = Math.max(0, this.lava[i]! - dt * 1.4);
        if (this.lava[i] === 0) this.dirty = true;
      }
      if (this.scorch[i]! > 0) {
        // v0.18 焦土衰减 0.15→0.04/s：焦土是"岩浆干涸后的地面痕迹"，必须比岩浆本身活得久
        // （旧速率 1.1 强度 7 秒就褪光，岩浆未干焦土先消失，观感不对）。
        this.scorch[i] = Math.max(0, this.scorch[i]! - dt * 0.04);
        if (this.scorch[i] === 0) this.dirty = true;
      }
      if (this.swamp[i]! > 0) {
        this.swamp[i] = Math.max(0, this.swamp[i]! - dt);
        if (this.swamp[i] === 0) this.dirty = true;
      }
    }
  }

  generate(): void {
    // v0.24 模板化生成：六地貌模板（大陆/群岛/半岛/双半岛/环礁/高地）× seeded fBm/ridge 噪声，
    // 高度场与双方出生点由 WorldGen 产出（连通域保证互达）；
    // 松弛/滩涂/pad 平台的 v0.13 管线保留在本方法内（坡度与海岸平滑仍由这里负责）。
    const gen = WorldGen.generate(this.genSeed, SAMPLES, STEP);
    this.h.set(gen.heights);
    this.fmask.set(gen.mask);
    this.genFeatures = gen.features;
    this.templateId = gen.templateId;
    this.templateName = gen.templateName;
    this.starts = [
      { x: gen.starts[0].x, z: gen.starts[0].z, yaw: gen.starts[0].yaw, h: gen.starts[0].h },
      { x: gen.starts[1].x, z: gen.starts[1].z, yaw: gen.starts[1].yaw, h: gen.starts[1].h },
    ];
    // v0.13 生成期 4 轮盒式松弛（v0.24 由 3 轮加一轮）：72 格大图的山脊带更长更陡，多松一轮压坡度。
    this.smoothField(4, 0, 0, SAMPLES - 1, SAMPLES - 1);
    // v0.13 山脊融入 3 轮松弛（WorldGen 的 ridge 分量随高度场一起平滑）。
    this.smoothField(3, 0, 0, SAMPLES - 1, SAMPLES - 1);
    // v0.13 浅水滩涂：紧邻陆地的水域抬到 0.16（仍低于 WATER，可通行性不变），海岸线从断崖变缓滩。
    for (let iz = 1; iz < SAMPLES - 1; iz++) {
      for (let ix = 1; ix < SAMPLES - 1; ix++) {
        const i = this.idx(ix, iz);
        if (this.h[i]! > WATER || this.h[i]! >= 0.16) continue;
        let nearLand = false;
        for (let dz = -1; dz <= 1 && !nearLand; dz++) {
          for (let dx = -1; dx <= 1 && !nearLand; dx++) {
            if (this.h[this.idx(ix + dx, iz + dz)]! > WATER) nearLand = true;
          }
        }
        if (nearLand) {
          this.h[i] = 0.16;
          this.markSample(ix, iz);
        }
      }
    }
    // v0.24 强制地图平滑（第 1 遍）：抹掉 0.25 格尺度上的"陆→水→陆"毛刺，让点判据
    // walkableAt 与单位每帧 0.12 格的步长口径一致（见 map-smoother.ts）。
    // 放在填海/出生平台之前，后面几步才是在干净地形上做决策。
    this.smoothReport = MapSmoother.smooth(this.h);
    // v0.24 单块可通行大陆：填平与最大陆域不连通的飞地（并把被迫落在飞地上的出生点
    // 迁进保留域）。必须在滩涂之后、出生平台整平之前——见 floodDisconnectedLand 注释。
    this.floodDisconnectedLand();
    for (const s of this.starts) {
      // v0.13 出生平台高度随当地地形（+0.25）：避免固定高度在平台边造出海崖。
      const sh = Math.max(this.heightAt(s.x, s.z), 0.8) + 0.25;
      this.flattenPad(s.x, s.z, 3.2, 3.2, s.yaw, sh);
    }
    // v0.24 坡度钳制（管线最后一步）：ridge 窄脊陡壁靠盒滤压不平、出生平台在山脚的
    // 接缝也会产生新陡壁——统一在收尾逐对削峰到每采样高差 ≤0.40（差分口径的上界 2.26，
    // 低于坡度检查阈值 2.5，见 clampSlope 注释）。
    this.clampSlope(0.4);
    // v0.24 强制地图平滑（终遍，权威）：出生平台整平与削峰都会重新刻出亚格毛刺
    // （平台边缘的环形缓坡、pad 内高精度格与 pad 外低格之间的落差），所以出图前
    // 必须再扫一遍。residualSeams 就是"还能把单位绊倒的边"的数量，检查脚本断言它为 0。
    this.smoothReport = MapSmoother.smooth(this.h);
    this.markAll();
  }

  startPad(team: Team): StartPad {
    return this.starts[team];
  }

  startCell(team: Team): Cell {
    const s = this.starts[team === BLUE ? 0 : team === RED ? 1 : 0];
    return { x: s.x, z: s.z };
  }
}

export { RED };
