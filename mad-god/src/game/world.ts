import {
  BLUE,
  Cell,
  clamp,
  inMap,
  MAX_H,
  MAX_SLOPE,
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
        const t = 1 - d / r;
        const falloff = t * t;
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
        if (!inPad(ix * STEP, iz * STEP, pad, 0.45)) continue;
        this.setSample(ix, iz, target);
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

  houseLevelAt(cx: number, cz: number, yaw = 0): number {
    if (this.padReady(cx, cz, 6.4, 6.4, yaw)) return 3;
    if (this.padReady(cx, cz, 4.4, 4.4, yaw)) return 2;
    if (this.padReady(cx, cz, 2.6, 2.6, yaw)) return 1;
    return 0;
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
        const fall = (1 - d / r) * (1 - d / r);
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
        this.scorch[i] = Math.max(0, this.scorch[i]! - dt * 0.15);
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
          if (inland > 0.32) h += Math.max(0, knoll) * 1.05 * inland;
        }
        this.h[this.idx(ix, iz)] = clamp(h, 0, MAX_H);
      }
    }
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
    for (const s of this.starts) {
      this.flattenPad(s.x, s.z, 3.2, 3.2, s.yaw, s.h);
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
