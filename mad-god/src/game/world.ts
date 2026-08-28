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

export function inPad(px: number, pz: number, pad: Pad, inflate = 0): boolean {
  const l = localOnPad(px, pz, pad);
  return Math.abs(l.x) <= pad.w / 2 + inflate && Math.abs(l.z) <= pad.d / 2 + inflate;
}

export const TREE_BLOCK_R = 0.32;
export const DOOR_SLIT_HALF = 0.28;
export const DOOR_SLIT_DEPTH = 0.45;

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

  constructor(seed = 1989) {
    this.h = new Float32Array(SAMPLES * SAMPLES);
    this.lava = new Float32Array(SAMPLES * SAMPLES);
    this.scorch = new Float32Array(SAMPLES * SAMPLES);
    this.swamp = new Float32Array(SAMPLES * SAMPLES);
    this.rng = new RNG(seed);
    this.starts = [
      { x: 11.2, z: 38.4, yaw: 0.18, h: 2.05 },
      { x: 39.4, z: 12.2, yaw: -0.22, h: 2.05 },
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
   * v0.13 盒式松弛：对 [minIx..maxIx]×[minIz..maxIz] 做 iter 轮 3×3 邻域均值。
   * 水面以下样本保持原值（clamp 不动），避免海岸被抹平；全部走脏区机制。
   */
  smoothField(iter: number, minIx: number, minIz: number, maxIx: number, maxIz: number): void {
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
          this.h[i] = tmp[i]!;
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

  walkableAt(x: number, z: number): boolean {
    if (!this.inMap(x, z)) return false;
    if (this.heightAt(x, z) <= WATER) return false;
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
        const nv = Math.max(0.02, this.h[i]! - depth * fall);
        if (nv !== this.h[i]) {
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
   * v0.18 火山高原（Agent V）：把半径 r 内地形抬到绝对高度 h（clamp 0~MAX_H）。
   * 内 55% 区域精确抬到 h（顶部平坦），外圈 0.55r~r 环形带 smoothstep 过渡回原高
   * （C1 连续、无断崖），环形带再做 1 轮盒式松弛圆角——内外圈手法与 flattenPad 同款。
   * 逐帧以递增的 h 调用即可得到"隆起动画"；水面以下样本由 setSample 内部清 lava/swamp。
   */
  raisePlateau(x: number, z: number, r: number, h: number): void {
    const target = clamp(h, 0, MAX_H);
    const minIx = clamp(Math.floor((x - r) / STEP), 0, SAMPLES - 1);
    const maxIx = clamp(Math.ceil((x + r) / STEP), 0, SAMPLES - 1);
    const minIz = clamp(Math.floor((z - r) / STEP), 0, SAMPLES - 1);
    const maxIz = clamp(Math.ceil((z + r) / STEP), 0, SAMPLES - 1);
    for (let iz = minIz; iz <= maxIz; iz++) {
      for (let ix = minIx; ix <= maxIx; ix++) {
        const px = ix * STEP;
        const pz = iz * STEP;
        const d = Math.hypot(px - x, pz - z);
        if (d > r) continue;
        if (d <= r * 0.55) {
          // 顶部精确区：直接设到 target（setSample 内含 clamp / 标脏 / 水面清 lava）。
          this.setSample(ix, iz, target);
          continue;
        }
        // 外圈缓坡：0.55r~r 带从 target 平滑过渡回原高（smoothstep 保证导数连续）。
        const t = clamp((d - r * 0.55) / (r * 0.45), 0, 1);
        const f = t * t * (3 - 2 * t);
        const i = this.idx(ix, iz);
        const nv = clamp(this.h[i]! + (target - this.h[i]!) * (1 - f), 0, MAX_H);
        if (nv !== this.h[i]) {
          this.h[i] = nv;
          this.markSample(ix, iz);
        }
      }
    }
    // v0.18 环形带 1 轮盒式松弛：圆滑缓坡两端拐角（只写 0.55r~r 带，顶部保持精确平坦）。
    for (let iz = minIz; iz <= maxIz; iz++) {
      for (let ix = minIx; ix <= maxIx; ix++) {
        const px = ix * STEP;
        const pz = iz * STEP;
        const d = Math.hypot(px - x, pz - z);
        if (d <= r * 0.55 || d > r) continue;
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

  flowLava(dt: number): { x: number; z: number }[] {
    const splash: { x: number; z: number }[] = [];
    const add = new Float32Array(this.lava.length);
    const neigh: [number, number][] = [
      [1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1],
    ];
    for (let iz = 1; iz < SAMPLES - 1; iz++) {
      for (let ix = 1; ix < SAMPLES - 1; ix++) {
        const i = this.idx(ix, iz);
        const amt = this.lava[i]!;
        if (amt <= 0) continue;
        const h = this.h[i]!;
        this.scorch[i] = Math.max(this.scorch[i]!, 1.15);
        let best = i;
        let bestH = h;
        for (const [dx, dz] of neigh) {
          const j = this.idx(ix + dx, iz + dz);
          const nh = this.h[j]!;
          if (nh < bestH - 0.012) {
            bestH = nh;
            best = j;
          }
        }
        if (best !== i) {
          const move = Math.min(amt, 0.7 * dt + amt * 0.16);
          add[i] -= move;
          add[best] += move;
          if (this.lava[best]! <= 0 && splash.length < 5) {
            splash.push({ x: (best % SAMPLES) * STEP, z: Math.floor(best / SAMPLES) * STEP });
          }
        }
        for (const [dx, dz] of neigh) {
          const j = this.idx(ix + dx, iz + dz);
          if (this.lava[j]! <= 0) this.scorch[j] = Math.max(this.scorch[j]!, 0.85);
        }
      }
    }
    for (let i = 0; i < add.length; i++) {
      if (add[i] === 0) continue;
      this.lava[i] = Math.max(0, this.lava[i]! + add[i]!);
      this.markSample(i % SAMPLES, (i / SAMPLES) | 0);
    }
    return splash;
  }

  tickFx(dt: number): void {
    for (let i = 0; i < this.lava.length; i++) {
      if (this.lava[i]! > 0) {
        this.lava[i] = Math.max(0, this.lava[i]! - dt);
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
    const rng = this.rng;
    const cx = WORLD * 0.5;
    const cz = WORLD * 0.5;
    const n1 = rng.float(0, 2);
    const n2 = rng.float(0, 2);
    for (let iz = 0; iz < SAMPLES; iz++) {
      for (let ix = 0; ix < SAMPLES; ix++) {
        const x = ix * STEP;
        const z = iz * STEP;
        const dx = x - cx;
        const dz = z - cz;
        const dist = Math.hypot(dx, dz);
        const n =
          Math.sin(x * 0.28 + n1) * 0.95 +
          Math.cos(z * 0.22 + n2) * 0.75 +
          Math.sin((x + z) * 0.15) * 0.5 +
          Math.sin(x * 0.71) * Math.cos(z * 0.53) * 0.42;
        const edge = 19.6 + n * 1.7;
        const t = clamp((edge + 0.6 - dist) / 2.8, 0, 1);
        const land = t * t * (3 - 2 * t);
        let h = 0.04;
        if (land > 0) {
          const inland = Math.max(0, 1 - dist / Math.max(edge, 1));
          h = 0.06 + land * (0.32 + inland * 2.05 + n * 0.5);
          const knoll = Math.sin(x * 0.52) * Math.cos(z * 0.41);
          if (inland > 0.32) {
            // v0.13 用 smoothstep(0,1,knoll) 替代 max(0,knoll)：保留"鼓包只增不减"的形态，去掉导数尖点。
            const k = clamp(knoll, 0, 1);
            h += k * k * (3 - 2 * k) * 1.05 * inland;
          }
        }
        this.h[this.idx(ix, iz)] = clamp(h, 0, MAX_H);
      }
    }
    // v0.13 生成期 3 轮盒式松弛：消除高频颗粒感，保留岛屿宏观形状（水面以下不动）。
    this.smoothField(3, 0, 0, SAMPLES - 1, SAMPLES - 1);
    const ridgeX0 = 14;
    const ridgeZ0 = 36;
    const ridgeX1 = 36;
    const ridgeZ1 = 16;
    for (let i = 0; i <= 36; i++) {
      const t = i / 36;
      const x = ridgeX0 + (ridgeX1 - ridgeX0) * t;
      const z = ridgeZ0 + (ridgeZ1 - ridgeZ0) * t;
      this.sculpt(x, z, 1.8, 0.35);
    }
    // v0.13 山脊凸包后再松弛 2 轮，让 ridge 融入地形。
    this.smoothField(2, 0, 0, SAMPLES - 1, SAMPLES - 1);
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
    for (const s of this.starts) {
      // v0.13 出生平台高度随当地地形（+0.25）：出生点大多在海岸边，固定 2.05 会在平台边造出两米海崖。
      const sh = Math.max(this.heightAt(s.x, s.z), 0.8) + 0.25;
      this.flattenPad(s.x, s.z, 3.2, 3.2, s.yaw, sh);
    }
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
