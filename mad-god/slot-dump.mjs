// src/game/types.ts
var WORLD = 52;
var STEP = 0.25;
var SAMPLES = 209;
var MAX_H = 8;
var WATER = 0.2;
var MAX_SLOPE = 0.7;
var BLUE = 0;
var RED = 1;
var NEUTRAL = 2;
var CAMP_FOR = {
  warrior: "warriorHut",
  preacher: "temple",
  firewarrior: "fireHut",
  spy: "spyHut"
};
function isCampKind(kind) {
  return kind === "warriorHut" || kind === "temple" || kind === "fireHut" || kind === "spyHut";
}
function woodNeedFor(kind, level) {
  if (isCampKind(kind)) return level >= 1 ? 0 : 4;
  if (kind === "hut") {
    if (level <= 0) return 2;
    if (level === 1) return 3;
    if (level === 2) return 4;
    return 0;
  }
  return 0;
}
var CHOP_TIME = 1.2;
var TRAIN_TIME = 4;
var TREE_REGEN = 25;
function canConvert(kind) {
  return kind !== "shaman" && kind !== "preacher";
}
var UNIT_RADIUS = {
  shaman: 0.24,
  walker: 0.22,
  warrior: 0.25,
  preacher: 0.24,
  firewarrior: 0.25,
  spy: 0.22,
  wildman: 0.22
};
var HOUSE_PAD = [0, 2.6, 4.4, 6.4];
function padSize(level) {
  const lv = level >= 3 ? 3 : level === 2 ? 2 : 1;
  const s2 = HOUSE_PAD[lv];
  return { w: s2, d: s2 };
}
function inMap(x, z) {
  return x >= 0 && z >= 0 && x <= WORLD && z <= WORLD;
}
function clamp(v, a, b) {
  return v < a ? a : v > b ? b : v;
}
function dist2(ax, az, bx, bz) {
  const dx = ax - bx;
  const dz = az - bz;
  return dx * dx + dz * dz;
}
function unitHp(kind, str) {
  if (kind === "shaman") return 14;
  if (kind === "warrior") return 10 + str * 2;
  if (kind === "preacher") return 7 + str;
  if (kind === "firewarrior") return 8 + str;
  if (kind === "spy") return 4 + str;
  if (kind === "wildman") return 3 + str * 2;
  return 3 + str * 3;
}
function houseHp(level) {
  return level === 3 ? 70 : level === 2 ? 36 : 18;
}
function houseMaxPop(level) {
  return level === 3 ? 8 : level === 2 ? 5 : 2;
}
function snapYaw(yaw) {
  const step = Math.PI / 4;
  return Math.round(yaw / step) * step;
}
function isTribe(team) {
  return team === 0 || team === 1;
}
var RNG = class {
  s;
  constructor(seed) {
    this.s = seed >>> 0;
  }
  next() {
    this.s = Math.imul(this.s, 1664525) + 1013904223 >>> 0;
    return this.s / 4294967296;
  }
  float(a, b) {
    return a + (b - a) * this.next();
  }
  int(a, b) {
    return Math.floor(this.float(a, b + 1 - 1e-9));
  }
  pick(arr) {
    return arr[this.int(0, arr.length - 1)];
  }
};

// src/game/path.ts
var CELL = 0.5;
var GW = Math.round(WORLD / CELL);
var DX = [1, -1, 0, 0, 1, 1, -1, -1];
var DZ = [0, 0, 1, -1, 1, -1, 1, -1];
function gxOf(x) {
  return clamp(Math.round(x / CELL), 0, GW - 1);
}
function worldOf(g) {
  return g * CELL;
}
function nearestLand(world, x, z) {
  if (world.walkableAt(x, z)) return { x, z };
  const sx = gxOf(x);
  const sz = gxOf(z);
  for (let r = 1; r <= 16; r++) {
    for (let dz = -r; dz <= r; dz++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.abs(dx) !== r && Math.abs(dz) !== r) continue;
        const wx = worldOf(sx + dx);
        const wz = worldOf(sz + dz);
        if (world.walkableAt(wx, wz)) return { x: wx, z: wz };
      }
    }
  }
  return null;
}
function astar(world, sx, sz, tx, tz, maxVisit = 2400) {
  if (!inMap(sx, sz)) return [];
  if (!world.land(sx, sz)) {
    const from = nearestLand(world, sx, sz);
    if (!from) return [];
    sx = from.x;
    sz = from.z;
  }
  if (!world.walkableAt(tx, tz)) {
    const alt = nearestLand(world, tx, tz);
    if (!alt) return [];
    tx = alt.x;
    tz = alt.z;
  }
  const sgx = gxOf(sx);
  const sgz = gxOf(sz);
  const tgx = gxOf(tx);
  const tgz = gxOf(tz);
  if (sgx === tgx && sgz === tgz) return [{ x: tx, z: tz }];
  const gScore = new Float32Array(GW * GW);
  gScore.fill(1e9);
  const came = new Int32Array(GW * GW);
  came.fill(-1);
  const open = [];
  const start = sgz * GW + sgx;
  const goal = tgz * GW + tgx;
  gScore[start] = 0;
  open.push(start);
  const heur = (i) => {
    const x = i % GW;
    const z = i / GW | 0;
    const dx = Math.abs(x - tgx);
    const dz = Math.abs(z - tgz);
    return Math.max(dx, dz) + Math.min(dx, dz) * 1e-3;
  };
  let visits = 0;
  let best = start;
  let bestH = heur(start);
  while (open.length && visits < maxVisit) {
    visits++;
    let bi = 0;
    let bv = 1e18;
    for (let i = 0; i < open.length; i++) {
      const n = open[i];
      const f = gScore[n] + heur(n);
      if (f < bv) {
        bv = f;
        bi = i;
      }
    }
    const cur = open[bi];
    open[bi] = open[open.length - 1];
    open.pop();
    if (cur === goal) return rebuild(came, cur, tx, tz);
    const h = heur(cur);
    if (h < bestH) {
      bestH = h;
      best = cur;
    }
    const cx = cur % GW;
    const cz = cur / GW | 0;
    const cwx = worldOf(cx);
    const cwz = worldOf(cz);
    const ch = world.heightAt(cwx, cwz);
    for (let k = 0; k < 8; k++) {
      const nx = cx + DX[k];
      const nz = cz + DZ[k];
      if (nx < 0 || nz < 0 || nx >= GW || nz >= GW) continue;
      const nwx = worldOf(nx);
      const nwz = worldOf(nz);
      if (!world.walkableAt(nwx, nwz)) continue;
      const nh = world.heightAt(nwx, nwz);
      if (Math.abs(nh - ch) > 1.6) continue;
      const diag = k >= 4 ? 1.42 : 1;
      const swamp = world.swamp[world.sampleAt(nwx, nwz)] > 0 ? 1.6 : 0;
      const cost = diag + Math.abs(nh - ch) * 0.55 + swamp;
      const ni = nz * GW + nx;
      const ng = gScore[cur] + cost;
      if (ng < gScore[ni]) {
        gScore[ni] = ng;
        came[ni] = cur;
        open.push(ni);
      }
    }
  }
  if (best !== start) return rebuild(came, best, worldOf(best % GW), worldOf(best / GW | 0));
  return [];
}
function rebuild(came, end, tx, tz) {
  const path = [];
  let c = end;
  while (c >= 0) {
    path.push({ x: worldOf(c % GW), z: worldOf(c / GW | 0) });
    c = came[c];
  }
  path.reverse();
  if (path.length) {
    path[path.length - 1] = { x: tx, z: tz };
  }
  return path;
}

// src/game/world.ts
function localOnPad(px2, pz2, pad) {
  const dx = px2 - pad.x;
  const dz = pz2 - pad.z;
  const c = Math.cos(-pad.yaw);
  const s2 = Math.sin(-pad.yaw);
  return { x: dx * c - dz * s2, z: dx * s2 + dz * c };
}
function inPad(px2, pz2, pad, inflate = 0) {
  const l = localOnPad(px2, pz2, pad);
  return Math.abs(l.x) <= pad.w / 2 + inflate && Math.abs(l.z) <= pad.d / 2 + inflate;
}
function padsOverlap(a, b) {
  const axes = [
    [Math.cos(a.yaw), Math.sin(a.yaw)],
    [-Math.sin(a.yaw), Math.cos(a.yaw)],
    [Math.cos(b.yaw), Math.sin(b.yaw)],
    [-Math.sin(b.yaw), Math.cos(b.yaw)]
  ];
  const corners = (p) => {
    const hw = p.w / 2;
    const hd = p.d / 2;
    const c = Math.cos(p.yaw);
    const s2 = Math.sin(p.yaw);
    const out = [];
    for (const [lx, lz] of [
      [-hw, -hd],
      [hw, -hd],
      [hw, hd],
      [-hw, hd]
    ]) {
      out.push([p.x + lx * c - lz * s2, p.z + lx * s2 + lz * c]);
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
function pushCircleFromPad(px2, pz2, r, pad) {
  const l = localOnPad(px2, pz2, pad);
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
  const s2 = Math.sin(pad.yaw);
  return { x: pad.x + lx * c - lz * s2, z: pad.z + lx * s2 + lz * c };
}
var World = class {
  h;
  lava;
  scorch;
  swamp;
  pads = [];
  dirty = true;
  dirtyMinX = 0;
  dirtyMinZ = 0;
  dirtyMaxX = SAMPLES - 1;
  dirtyMaxZ = SAMPLES - 1;
  rng;
  starts;
  constructor(seed = 1989) {
    this.h = new Float32Array(SAMPLES * SAMPLES);
    this.lava = new Float32Array(SAMPLES * SAMPLES);
    this.scorch = new Float32Array(SAMPLES * SAMPLES);
    this.swamp = new Float32Array(SAMPLES * SAMPLES);
    this.rng = new RNG(seed);
    this.starts = [
      { x: 11.2, z: 38.4, yaw: 0.18, h: 2.05 },
      { x: 39.4, z: 12.2, yaw: -0.22, h: 2.05 }
    ];
    this.generate();
  }
  idx(ix, iz) {
    return iz * SAMPLES + ix;
  }
  sampleAt(x, z) {
    const ix = clamp(Math.round(x / STEP), 0, SAMPLES - 1);
    const iz = clamp(Math.round(z / STEP), 0, SAMPLES - 1);
    return this.idx(ix, iz);
  }
  inMap(x, z) {
    return inMap(x, z);
  }
  inSample(ix, iz) {
    return ix >= 0 && iz >= 0 && ix < SAMPLES && iz < SAMPLES;
  }
  height(x, z) {
    return this.heightAt(x, z);
  }
  heightAt(x, z) {
    const fx2 = clamp(x / STEP, 0, SAMPLES - 1);
    const fz2 = clamp(z / STEP, 0, SAMPLES - 1);
    const ix = Math.floor(fx2);
    const iz = Math.floor(fz2);
    const tx = fx2 - ix;
    const tz = fz2 - iz;
    const x1 = Math.min(ix + 1, SAMPLES - 1);
    const z1 = Math.min(iz + 1, SAMPLES - 1);
    const h00 = this.h[this.idx(ix, iz)];
    const h10 = this.h[this.idx(x1, iz)];
    const h01 = this.h[this.idx(ix, z1)];
    const h11 = this.h[this.idx(x1, z1)];
    return h00 * (1 - tx) * (1 - tz) + h10 * tx * (1 - tz) + h01 * (1 - tx) * tz + h11 * tx * tz;
  }
  normalAt(x, z) {
    const e = STEP;
    const hL = this.heightAt(x - e, z);
    const hR = this.heightAt(x + e, z);
    const hD = this.heightAt(x, z - e);
    const hU = this.heightAt(x, z + e);
    const nx = hL - hR;
    const nz = hD - hU;
    const ny = 2 * e;
    const len2 = Math.hypot(nx, ny, nz) || 1;
    return { x: nx / len2, y: ny / len2, z: nz / len2 };
  }
  slopeAt(x, z) {
    const e = STEP;
    const dhx = (this.heightAt(x + e, z) - this.heightAt(x - e, z)) / (2 * e);
    const dhz = (this.heightAt(x, z + e) - this.heightAt(x, z - e)) / (2 * e);
    return Math.hypot(dhx, dhz);
  }
  markSample(ix, iz) {
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
  markAll() {
    this.dirty = true;
    this.dirtyMinX = 0;
    this.dirtyMinZ = 0;
    this.dirtyMaxX = SAMPLES - 1;
    this.dirtyMaxZ = SAMPLES - 1;
  }
  setSample(ix, iz, v) {
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
  sculpt(x, z, radius, dh) {
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
        const nv = clamp(this.h[i] + dh * falloff, 0, MAX_H);
        if (nv !== this.h[i]) {
          this.h[i] = nv;
          this.markSample(ix, iz);
          changed = true;
        }
      }
    }
    return changed;
  }
  flattenPad(cx, cz, w, d, yaw, h) {
    const target = clamp(h, 0, MAX_H);
    const pad = { x: cx, z: cz, w, d, yaw };
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
  land(x, z) {
    return this.inMap(x, z) && this.heightAt(x, z) > WATER;
  }
  walkableAt(x, z) {
    if (!this.inMap(x, z)) return false;
    if (this.heightAt(x, z) <= WATER) return false;
    if (this.slopeAt(x, z) >= MAX_SLOPE) return false;
    for (const p of this.pads) {
      if (inPad(x, z, p)) return false;
    }
    return true;
  }
  walkable(x, z) {
    return this.walkableAt(x, z);
  }
  setPads(pads) {
    this.pads = pads;
  }
  padStats(cx, cz, w, d, yaw) {
    const pad = { x: cx, z: cz, w, d, yaw };
    const reach = 0.5 * Math.hypot(w, d) + STEP;
    const minIx = clamp(Math.floor((cx - reach) / STEP), 0, SAMPLES - 1);
    const maxIx = clamp(Math.ceil((cx + reach) / STEP), 0, SAMPLES - 1);
    const minIz = clamp(Math.floor((cz - reach) / STEP), 0, SAMPLES - 1);
    const maxIz = clamp(Math.ceil((cz + reach) / STEP), 0, SAMPLES - 1);
    let n = 0;
    let land = 0;
    let sum = 0;
    let maxSlope = 0;
    const hs = [];
    for (let iz = minIz; iz <= maxIz; iz++) {
      for (let ix = minIx; ix <= maxIx; ix++) {
        const wx = ix * STEP;
        const wz = iz * STEP;
        if (!inPad(wx, wz, pad)) continue;
        const hv = this.h[this.idx(ix, iz)];
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
  padReady(cx, cz, w, d, yaw) {
    const s2 = this.padStats(cx, cz, w, d, yaw);
    return s2.n > 0 && s2.land >= 0.8 && s2.variance < 0.22 && s2.maxSlope < 0.7 && s2.mean > WATER;
  }
  houseLevelAt(cx, cz, yaw = 0) {
    if (this.padReady(cx, cz, 6.4, 6.4, yaw)) return 3;
    if (this.padReady(cx, cz, 4.4, 4.4, yaw)) return 2;
    if (this.padReady(cx, cz, 2.6, 2.6, yaw)) return 1;
    return 0;
  }
  countMismatch(cx, cz, radius, targetH) {
    const out = [];
    const step = 0.5;
    for (let z = cz - radius; z <= cz + radius + 1e-6; z += step) {
      for (let x = cx - radius; x <= cx + radius + 1e-6; x += step) {
        if (!this.inMap(x, z)) continue;
        if (Math.abs(this.heightAt(x, z) - targetH) > 0.12) out.push({ x, z });
      }
    }
    return out;
  }
  landCells() {
    const out = [];
    for (let z = 1; z < WORLD; z += 1) {
      for (let x = 1; x < WORLD; x += 1) {
        if (this.heightAt(x, z) > WATER) out.push({ x, z });
      }
    }
    return out;
  }
  tickFx(dt) {
    for (let i = 0; i < this.lava.length; i++) {
      if (this.lava[i] > 0) {
        this.lava[i] = Math.max(0, this.lava[i] - dt);
        if (this.lava[i] === 0) this.dirty = true;
      }
      if (this.scorch[i] > 0) {
        this.scorch[i] = Math.max(0, this.scorch[i] - dt * 0.15);
        if (this.scorch[i] === 0) this.dirty = true;
      }
      if (this.swamp[i] > 0) {
        this.swamp[i] = Math.max(0, this.swamp[i] - dt);
        if (this.swamp[i] === 0) this.dirty = true;
      }
    }
  }
  generate() {
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
        const n = Math.sin(x * 0.28 + n1) * 0.95 + Math.cos(z * 0.22 + n2) * 0.75 + Math.sin((x + z) * 0.15) * 0.5 + Math.sin(x * 0.71) * Math.cos(z * 0.53) * 0.42;
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
    for (const s2 of this.starts) {
      this.flattenPad(s2.x, s2.z, 3.2, 3.2, s2.yaw, s2.h);
    }
    this.markAll();
  }
  startPad(team) {
    return this.starts[team];
  }
  startCell(team) {
    const s2 = this.starts[team === BLUE ? 0 : team === RED ? 1 : 0];
    return { x: s2.x, z: s2.z };
  }
};

// src/game/sim.ts
var NEXT = 1;
function nid() {
  return NEXT++;
}
var TRAIN_DONE = {
  warrior: "\u4E00\u540D\u52C7\u58EB\u6210\u4E3A\u6B66\u58EB",
  preacher: "\u4E00\u540D\u52C7\u58EB\u6210\u4E3A\u4F20\u6559\u58EB",
  firewarrior: "\u4E00\u540D\u52C7\u58EB\u6210\u4E3A\u706B\u6218\u58EB",
  spy: "\u4E00\u540D\u52C7\u58EB\u6210\u4E3A\u95F4\u8C0D"
};
var Sim = class {
  world;
  units = [];
  buildings = [];
  trees = [];
  shots = [];
  ankhs = [];
  teams;
  winner = null;
  time = 0;
  logs = [];
  toastGen = 0;
  armageddon = false;
  review = false;
  freezeMerge = false;
  lockWin = false;
  fxBolts = [];
  fxShake = 0;
  fxQuake = null;
  fxVolcano = null;
  trainJoinN = 1;
  constructor(world) {
    this.world = world;
    const b = world.startPad(BLUE);
    const r = world.startPad(RED);
    this.teams = [
      { mana: 70, manaCap: 100, order: "settle", magnetX: b.x, magnetZ: b.z, hasShaman: true, shamanRevive: 0, wanted: [] },
      { mana: 70, manaCap: 100, order: "settle", magnetX: r.x, magnetZ: r.z, hasShaman: true, shamanRevive: 0, wanted: [] }
    ];
    this.seed();
  }
  seed() {
    this.placeStart(BLUE);
    this.placeStart(RED);
    this.seedWildmen();
    this.seedTrees();
  }
  placeStart(team) {
    const s2 = this.world.startPad(team);
    const rebirth = this.placeComplete(team, s2.x, s2.z, s2.yaw, "rebirth", 1, 3.2, 3.2);
    const toCx2 = WORLD * 0.5 - s2.x;
    const toCz2 = WORLD * 0.5 - s2.z;
    const len2 = Math.hypot(toCx2, toCz2) || 1;
    const fx2 = toCx2 / len2;
    const fz2 = toCz2 / len2;
    const px2 = -fz2;
    const pz2 = fx2;
    const h1x = s2.x + fx2 * 4 + px2 * 4;
    const h1z = s2.z + fz2 * 4 + pz2 * 4;
    const h2x = s2.x + fx2 * 4 - px2 * 4;
    const h2z = s2.z + fz2 * 4 - pz2 * 4;
    const hut1 = this.placeComplete(team, h1x, h1z, s2.yaw + 0.12, "hut", 1);
    const hut2 = this.placeComplete(team, h2x, h2z, s2.yaw - 0.12, "hut", 1);
    const sh = this.spawnNear(rebirth) ?? { x: s2.x + 0.4, z: s2.z + 1.8 };
    this.addUnit(team, "shaman", sh.x, sh.z);
    const w1 = this.spawnNear(hut1) ?? { x: h1x + 1.6, z: h1z + 1.2 };
    const w2 = this.spawnNear(hut2) ?? { x: h2x - 1.6, z: h2z + 1.2 };
    this.addUnit(team, "walker", w1.x, w1.z);
    this.addUnit(team, "walker", w2.x, w2.z);
  }
  seedWildmen() {
    const pts = [
      { x: 26, z: 26 },
      { x: 22, z: 30 },
      { x: 30, z: 22 },
      { x: 24, z: 18 },
      { x: 18, z: 24 },
      { x: 33, z: 28 },
      { x: 28, z: 34 }
    ];
    for (const p of pts) {
      if (this.world.land(p.x, p.z)) this.addUnit(NEUTRAL, "wildman", p.x, p.z);
    }
  }
  seedTrees() {
    const rng = this.world.rng;
    const n = rng.int(28, 40);
    const pads = this.buildings.map((b) => this.buildingPad(b));
    for (const s2 of this.world.starts) pads.push({ x: s2.x, z: s2.z, w: 3.6, d: 3.6, yaw: s2.yaw });
    let tries = 0;
    while (this.trees.length < n && tries < 2e3) {
      tries++;
      const x = rng.float(3, WORLD - 3);
      const z = rng.float(3, WORLD - 3);
      if (!this.world.land(x, z)) continue;
      if (this.world.heightAt(x, z) <= WATER + 0.15) continue;
      if (this.world.slopeAt(x, z) > 0.55) continue;
      let blocked = false;
      for (const p of pads) {
        if (inPad(x, z, p, 0.9)) {
          blocked = true;
          break;
        }
      }
      if (blocked) continue;
      for (const t of this.trees) {
        if (dist2(x, z, t.x, t.z) < 4.84) {
          blocked = true;
          break;
        }
      }
      if (blocked) continue;
      this.trees.push({
        id: nid(),
        x,
        z,
        y: this.world.heightAt(x, z),
        alive: true,
        regen: 0
      });
    }
  }
  addUnit(team, kind, x, z, str = 1) {
    const hp = unitHp(kind, str);
    const u = {
      id: nid(),
      team,
      kind,
      x,
      z,
      y: this.world.heightAt(x, z),
      yaw: 0,
      hp,
      maxHp: hp,
      str,
      order: isTribe(team) ? this.teams[team].order : "settle",
      path: [],
      pathI: 0,
      think: 0,
      atkCd: 0,
      selected: false,
      phase: Math.random() * Math.PI * 2,
      settleT: 0,
      settleX: -1,
      settleZ: -1,
      settleYaw: 0,
      channel: 0,
      channelId: 0,
      disguise: null,
      carry: 0,
      job: "idle",
      targetId: 0,
      trainKind: null,
      foundKind: null
    };
    this.units.push(u);
    if (kind === "shaman" && isTribe(team)) this.teams[team].hasShaman = true;
    return u;
  }
  buildingPad(b) {
    return { x: b.x, z: b.z, w: b.padW, d: b.padD, yaw: b.yaw };
  }
  canFound(x, z, level, yaw, ignoreId = 0) {
    const pad = padSize(level);
    if (!this.world.padReady(x, z, pad.w, pad.d, yaw)) return false;
    const mine = { x, z, w: pad.w, d: pad.d, yaw };
    for (const b of this.buildings) {
      if (b.hp <= 0 || b.id === ignoreId) continue;
      if (padsOverlap(mine, this.buildingPad(b))) return false;
    }
    return true;
  }
  padEdge(cx, cz, w, d, yaw, fromX, fromZ) {
    const pad = { x: cx, z: cz, w, d, yaw };
    const inflate = 0.45;
    const ang = Math.atan2(fromX - cx, fromZ - cz);
    const hw = w / 2 + inflate;
    const hd = d / 2 + inflate;
    const lx = Math.cos(ang - yaw) * hw;
    const lz = Math.sin(ang - yaw) * hd;
    const c = Math.cos(yaw);
    const s2 = Math.sin(yaw);
    let x = cx + lx * c - lz * s2;
    let z = cz + lx * s2 + lz * c;
    if (!this.world.walkableAt(x, z)) {
      const safe = nearestLand(this.world, x, z);
      if (safe) return safe;
    }
    void pad;
    return { x, z };
  }
  markHouseBlocks() {
    const pads = [];
    for (const b of this.buildings) {
      if (b.hp <= 0) continue;
      pads.push(this.buildingPad(b));
    }
    this.world.setPads(pads);
  }
  placeComplete(team, x, z, yaw, kind, level, padW, padD) {
    const pad = padW !== void 0 && padD !== void 0 ? { w: padW, d: padD } : padSize(kind === "hut" ? Math.max(1, level) : 1);
    const h = Math.max(this.world.heightAt(x, z), 0.8);
    this.world.flattenPad(x, z, pad.w, pad.d, yaw, h);
    const y = this.world.heightAt(x, z);
    const hp = kind === "rebirth" ? 40 : houseHp(Math.max(1, level));
    const b = {
      id: nid(),
      team,
      kind,
      x,
      z,
      y,
      yaw,
      padW: pad.w,
      padD: pad.d,
      level,
      hp,
      maxHp: hp,
      prod: 0,
      wood: 0,
      need: woodNeedFor(kind, level)
    };
    this.buildings.push(b);
    this.markHouseBlocks();
    return b;
  }
  foundSite(team, x, z, yaw, kind) {
    if (!this.canFound(x, z, 1, yaw)) return null;
    const pad = padSize(1);
    const h = this.world.heightAt(x, z);
    this.world.flattenPad(x, z, pad.w, pad.d, yaw, h);
    const y = this.world.heightAt(x, z);
    const b = {
      id: nid(),
      team,
      kind,
      x,
      z,
      y,
      yaw,
      padW: pad.w,
      padD: pad.d,
      level: 0,
      hp: 12,
      maxHp: 12,
      prod: 0,
      wood: 0,
      need: woodNeedFor(kind, 0)
    };
    this.buildings.push(b);
    this.markHouseBlocks();
    return b;
  }
  buildingAt(x, z) {
    return this.buildings.find((b) => b.hp > 0 && inPad(x, z, this.buildingPad(b)));
  }
  unitAt(x, z, r = 0.55) {
    let best;
    let bestD = r * r;
    for (const u of this.units) {
      const d = dist2(u.x, u.z, x, z);
      if (d <= bestD) {
        bestD = d;
        best = u;
      }
    }
    return best;
  }
  countPop(team) {
    return this.units.filter((u) => u.team === team).length;
  }
  popCap(team) {
    let n = 0;
    for (const b of this.buildings) {
      if (b.team === team && b.hp > 0 && b.kind === "hut" && b.level >= 1) n += houseMaxPop(b.level);
    }
    return n;
  }
  countKind(team, kind) {
    return this.units.filter((u) => u.team === team && u.kind === kind).length;
  }
  countHouses(team) {
    return this.buildings.filter((b) => b.team === team && b.hp > 0 && b.kind === "hut" && b.level >= 1).length;
  }
  countWood(team) {
    let n = 0;
    for (const u of this.units) if (u.team === team) n += u.carry;
    for (const b of this.buildings) if (b.team === team && b.hp > 0) n += b.wood;
    return n;
  }
  spend(team, cost) {
    const t = this.teams[team];
    if (t.mana < cost) return false;
    t.mana -= cost;
    return true;
  }
  toast(msg) {
    this.logs.push(msg);
    if (this.logs.length > 8) this.logs.shift();
    this.toastGen++;
  }
  selectedOf(team) {
    return this.units.filter((u) => u.team === team && u.selected);
  }
  setOrder(team, order) {
    this.teams[team].order = order;
    const selected = this.selectedOf(team);
    const pool = selected.length ? selected : team === BLUE ? [] : this.units.filter((u) => u.team === team);
    if (team === BLUE && !selected.length) {
      this.toast("\u5148\u9009\u4EBA");
      return;
    }
    for (const u of pool) {
      if (u.kind !== "walker" && u.kind !== "shaman" && u.kind !== "spy") continue;
      if (u.job === "train") continue;
      u.order = order;
      u.path = [];
      u.think = 0;
    }
  }
  setMagnet(team, x, z) {
    this.teams[team].magnetX = x;
    this.teams[team].magnetZ = z;
  }
  sendWalkerToCamp(u, camp2, kind) {
    u.job = "train";
    u.trainKind = kind;
    u.targetId = camp2.id;
    u.carry = 0;
    u.channel = 0;
    u.channelId = this.trainJoinN++;
    u.path = [];
    u.pathI = 0;
    u.think = 0;
    const q = this.trainQueue(camp2.id);
    const slot = Math.max(0, q.findIndex((o) => o.id === u.id));
    this.pathToSlot(u, this.trainSlotPos(camp2, slot));
  }
  padLocalToWorld(camp2, lx, lz) {
    const c = Math.cos(camp2.yaw);
    const s2 = Math.sin(camp2.yaw);
    return { x: camp2.x + lx * c - lz * s2, z: camp2.z + lx * s2 + lz * c };
  }
  trainDoor(camp2) {
    const fx2 = -Math.sin(camp2.yaw);
    const fz2 = Math.cos(camp2.yaw);
    const dist = camp2.padD / 2 + 0.85;
    return { x: camp2.x + fx2 * dist, z: camp2.z + fz2 * dist, fx: fx2, fz: fz2 };
  }
  trainSlotPos(camp2, slot) {
    const margin = 0.85;
    const hw = camp2.padW / 2 + margin;
    const hd = camp2.padD / 2 + margin;
    const segs = [
      [[0, hd], [-hw, hd]],
      [[-hw, hd], [-hw, -hd]],
      [[-hw, -hd], [hw, -hd]],
      [[hw, -hd], [hw, hd]],
      [[hw, hd], [0, hd]]
    ];
    let remain = Math.max(0, slot) * 0.7;
    const loop = 4 * (hw + hd);
    if (loop > 0.01) remain = remain % loop;
    let lx = 0;
    let lz = hd;
    for (const [a, b] of segs) {
      const dx = b[0] - a[0];
      const dz = b[1] - a[1];
      const len2 = Math.hypot(dx, dz);
      if (remain <= len2) {
        const t = len2 < 1e-6 ? 0 : remain / len2;
        lx = a[0] + dx * t;
        lz = a[1] + dz * t;
        break;
      }
      remain -= len2;
      lx = b[0];
      lz = b[1];
    }
    let p = this.padLocalToWorld(camp2, lx, lz);
    for (let k = 0; k < 8 && !this.world.walkableAt(p.x, p.z); k++) {
      const ox = p.x - camp2.x;
      const oz = p.z - camp2.z;
      const n = Math.hypot(ox, oz) || 1;
      p = { x: p.x + ox / n * 0.22, z: p.z + oz / n * 0.22 };
    }
    return p;
  }
  trainQueue(campId) {
    return this.units.filter((u) => u.job === "train" && u.targetId === campId).sort((a, b) => a.channelId - b.channelId || a.id - b.id);
  }
  assignCampFounder(u, campKind) {
    u.foundKind = campKind;
    u.job = "idle";
    u.think = 0;
    u.path = [];
    u.pathI = 0;
    const site = this.findCampSite(u);
    if (!site) return;
    u.settleX = site.x;
    u.settleZ = site.z;
    const made = this.foundSite(u.team, site.x, site.z, u.settleYaw, campKind);
    if (made) {
      u.foundKind = null;
      u.settleX = -1;
      u.settleZ = -1;
      return;
    }
    const pad = padSize(1);
    const edge = this.padEdge(site.x, site.z, pad.w, pad.d, u.settleYaw, u.x, u.z);
    u.path = astar(this.world, u.x, u.z, edge.x, edge.z);
  }
  train(team, kind) {
    const selected = this.selectedOf(team);
    let walkers;
    if (team === BLUE) {
      if (!selected.length) {
        this.toast("\u5148\u9009\u4EBA");
        return false;
      }
      walkers = selected.filter((u) => u.kind === "walker");
      if (!walkers.length) {
        this.toast("\u9009\u4E2D\u7684\u4EBA\u4E0D\u80FD\u8BAD\u7EC3");
        return false;
      }
    } else {
      walkers = this.units.filter((u) => u.team === team && u.kind === "walker");
      if (!walkers.length) return false;
    }
    const campKind = CAMP_FOR[kind];
    const camps = this.buildings.filter((b) => b.team === team && b.kind === campKind && b.level >= 1 && b.hp > 0);
    if (!camps.length) {
      if (team !== BLUE) {
        const t = this.teams[team];
        if (!t.wanted.includes(campKind)) t.wanted.push(campKind);
        const already = this.units.find((u) => u.team === team && u.kind === "walker" && u.foundKind === campKind);
        if (!already) {
          const idle = walkers.find((u) => u.carry === 0 && u.job !== "train" && u.job !== "haul" && u.job !== "chop") ?? walkers.find((u) => u.carry === 0 && u.job !== "train");
          if (idle) this.assignCampFounder(idle, campKind);
        }
      }
      this.toast("\u5148\u76D6\u8BAD\u7EC3\u8425");
      return false;
    }
    const queued = walkers.filter((w) => w.job === "train");
    const ready = walkers.filter((w) => w.job !== "train");
    if (!ready.length) return true;
    let camp2 = camps[0];
    const follow = queued[0] ? this.buildingById(queued[0].targetId) : void 0;
    if (follow && follow.hp > 0 && follow.level >= 1) {
      camp2 = follow;
    } else {
      let cx = 0;
      let cz = 0;
      for (const w of ready) {
        cx += w.x;
        cz += w.z;
      }
      cx /= ready.length;
      cz /= ready.length;
      let bestD = dist2(cx, cz, camp2.x, camp2.z);
      for (const c of camps) {
        const d = dist2(cx, cz, c.x, c.z);
        if (d < bestD) {
          bestD = d;
          camp2 = c;
        }
      }
    }
    for (const w of ready) this.sendWalkerToCamp(w, camp2, kind);
    if (team === BLUE) this.toast("\u524D\u5F80\u8BAD\u7EC3");
    return true;
  }
  tick(dt) {
    if (this.winner !== null) return;
    this.time += dt;
    this.world.tickFx(dt);
    this.tickTrees(dt);
    this.refreshHouses();
    this.markHouseBlocks();
    this.regenMana(dt);
    this.produce(dt);
    this.thinkUnits(dt);
    this.moveUnits(dt);
    this.combat(dt);
    this.projectiles(dt);
    this.hazards(dt);
    this.mergeWalkers();
    this.respawnShamans(dt);
    this.cull();
    this.checkWin();
  }
  tickTrees(dt) {
    for (const t of this.trees) {
      if (t.alive) continue;
      t.regen -= dt;
      if (t.regen > 0) continue;
      if (this.world.heightAt(t.x, t.z) <= WATER) {
        t.regen = 4;
        continue;
      }
      t.alive = true;
      t.regen = 0;
      t.y = this.world.heightAt(t.x, t.z);
    }
  }
  regenMana(dt) {
    for (const team of [BLUE, RED]) {
      const t = this.teams[team];
      let cap = 80;
      let regen = 1.2;
      for (const b of this.buildings) {
        if (b.team !== team || b.kind !== "hut" || b.level < 1) continue;
        cap += b.level * 18;
        regen += b.level * 0.85;
      }
      const pop = this.countPop(team);
      cap += Math.min(80, pop * 2);
      regen += pop * 0.1;
      t.manaCap = cap;
      t.mana = clamp(t.mana + regen * dt, 0, t.manaCap);
    }
  }
  refreshHouses() {
    for (const b of this.buildings) {
      if (this.world.heightAt(b.x, b.z) <= WATER) {
        b.hp = 0;
        continue;
      }
      if (b.kind === "hut") {
        if (this.world.houseLevelAt(b.x, b.z, b.yaw) === 0) b.hp = 0;
      } else if (isCampKind(b.kind)) {
        const s2 = this.world.padStats(b.x, b.z, b.padW, b.padD, b.yaw);
        if (s2.n === 0 || s2.land < 0.55 || s2.mean <= WATER) b.hp = 0;
      }
    }
  }
  produce(dt) {
    for (const b of this.buildings) {
      if (b.hp <= 0 || b.kind !== "hut" || b.level < 1) continue;
      if (this.countPop(b.team) >= this.popCap(b.team)) continue;
      const rate = b.level === 3 ? 0.28 : b.level === 2 ? 0.18 : 0.11;
      b.prod += rate * dt;
      if (b.prod >= 1) {
        const spot = this.spawnNear(b);
        if (!spot) continue;
        b.prod = 0;
        this.addUnit(b.team, "walker", spot.x, spot.z);
      }
    }
  }
  spawnNear(b) {
    for (let k = 0; k < 20; k++) {
      const ang = k / 20 * Math.PI * 2 + b.yaw;
      const x = b.x + Math.cos(ang) * (b.padW * 0.5 + 0.55);
      const z = b.z + Math.sin(ang) * (b.padD * 0.5 + 0.55);
      if (this.world.walkableAt(x, z)) return { x, z };
    }
    return nearestLand(this.world, b.x, b.z);
  }
  thinkUnits(dt) {
    for (const u of this.units) {
      u.think -= dt;
      u.atkCd -= dt;
      if (u.job === "train") {
        this.advanceTrain(u, dt);
        continue;
      }
      if (u.kind === "walker" && this.advanceWalker(u, dt)) {
        u.path = [];
        continue;
      }
      if (u.kind === "preacher" && u.channel > 0) continue;
      if (u.think > 0 && u.path.length) continue;
      u.think = 0.6 + Math.random() * 0.5;
      this.repath(u);
    }
  }
  advanceWalker(u, dt) {
    if (u.job === "train") return this.advanceTrain(u, dt);
    if (u.order !== "settle") return false;
    if (!isTribe(u.team)) return false;
    if (u.carry === 1) {
      const site = this.buildingById(u.targetId) ?? this.nearestNeedSite(u.team, u.x, u.z);
      if (!site || !this.needsWood(site)) return false;
      const edge = this.padEdge(site.x, site.z, site.padW, site.padD, site.yaw, u.x, u.z);
      if (dist2(u.x, u.z, edge.x, edge.z) > 1.6 && dist2(u.x, u.z, site.x, site.z) > 2.6) return false;
      u.carry = 0;
      u.job = "idle";
      u.targetId = 0;
      this.deliverWood(site);
      if (u.trainKind && isTribe(u.team)) {
        const campKind = CAMP_FOR[u.trainKind];
        const camp2 = this.buildings.find((b) => b.team === u.team && b.kind === campKind && b.level >= 1 && b.hp > 0);
        if (camp2) {
          this.sendWalkerToCamp(u, camp2, u.trainKind);
          return true;
        }
      }
      return true;
    }
    if (u.job === "chop") {
      const tree = this.trees.find((t) => t.id === u.targetId);
      if (!tree || !tree.alive) {
        u.job = "idle";
        u.targetId = 0;
        u.channel = 0;
        return false;
      }
      if (dist2(u.x, u.z, tree.x, tree.z) > 0.95) return false;
      u.channel += dt;
      if (u.channel >= CHOP_TIME) {
        u.channel = 0;
        u.carry = 1;
        u.job = "haul";
        tree.alive = false;
        tree.regen = TREE_REGEN;
        u.targetId = 0;
      }
      return true;
    }
    if (u.settleX >= 0 && !this.buildingAt(u.settleX, u.settleZ)) {
      const pad = padSize(1);
      const edge = this.padEdge(u.settleX, u.settleZ, pad.w, pad.d, u.settleYaw, u.x, u.z);
      if (dist2(u.x, u.z, edge.x, edge.z) <= 1.5) {
        const kind = u.foundKind ?? "hut";
        if (kind === "hut" && this.hasNeedSite(u.team)) {
          u.settleX = -1;
          u.settleZ = -1;
          return false;
        }
        const made = this.foundSite(u.team, u.settleX, u.settleZ, u.settleYaw, kind);
        u.settleX = -1;
        u.settleZ = -1;
        if (made) u.foundKind = null;
        if (made && kind !== "hut") this.toast(u.team === BLUE ? "\u5F00\u59CB\u642D\u5EFA\u8BAD\u7EC3\u8425" : "\u654C\u65B9\u5F00\u5EFA\u8BAD\u7EC3\u8425");
        return !!made;
      }
    }
    return false;
  }
  pathToSlot(u, dest) {
    const last = u.path.length ? u.path[u.path.length - 1] : null;
    if (last && dist2(last.x, last.z, dest.x, dest.z) <= 0.04) return;
    u.path = astar(this.world, u.x, u.z, dest.x, dest.z);
    if (!u.path.length) u.path = [{ x: dest.x, z: dest.z }];
    u.pathI = 0;
  }
  advanceTrain(u, dt) {
    const camp2 = this.buildings.find((b) => b.id === u.targetId && b.hp > 0 && b.level >= 1);
    if (!camp2 || !u.trainKind) {
      u.job = "idle";
      u.trainKind = null;
      u.channel = 0;
      u.targetId = 0;
      return false;
    }
    const queue = this.trainQueue(camp2.id);
    let slot = queue.findIndex((o) => o.id === u.id);
    if (slot < 0) slot = queue.length;
    const dest = this.trainSlotPos(camp2, slot);
    if (dist2(u.x, u.z, dest.x, dest.z) > 0.18 * 0.18) {
      this.pathToSlot(u, dest);
      return true;
    }
    u.path = [];
    u.pathI = 0;
    u.x = dest.x;
    u.z = dest.z;
    u.y = this.world.heightAt(u.x, u.z);
    u.yaw = Math.atan2(camp2.x - u.x, camp2.z - u.z);
    if (slot === 0) {
      u.channel += dt;
      if (u.channel >= TRAIN_TIME) this.finishTrain(u, camp2);
    } else {
      u.channel = 0;
    }
    return true;
  }
  finishTrain(u, camp2) {
    const kind = u.trainKind;
    u.kind = kind;
    u.str = Math.max(u.str, 1);
    u.hp = u.maxHp = unitHp(kind, u.str);
    u.order = kind === "spy" ? this.teams[u.team].order : "fight";
    u.job = "idle";
    u.trainKind = null;
    u.channel = 0;
    u.channelId = 0;
    u.carry = 0;
    u.targetId = 0;
    u.disguise = kind === "spy" ? null : u.disguise;
    const door2 = this.trainDoor(camp2);
    const rx = Math.cos(camp2.yaw);
    const rz = -Math.sin(camp2.yaw);
    let sx = door2.x + rx * 0.8;
    let sz = door2.z + rz * 0.8;
    if (!this.world.walkableAt(sx, sz)) {
      sx = door2.x - rx * 0.8;
      sz = door2.z - rz * 0.8;
    }
    if (!this.world.walkableAt(sx, sz)) {
      const safe = nearestLand(this.world, sx, sz);
      if (safe) {
        sx = safe.x;
        sz = safe.z;
      }
    }
    u.x = sx;
    u.z = sz;
    u.y = this.world.heightAt(u.x, u.z);
    u.path = [];
    u.pathI = 0;
    u.think = 0.2;
    this.toast(TRAIN_DONE[kind]);
    const nxt = this.trainQueue(camp2.id)[0];
    if (nxt) {
      nxt.think = 0;
      nxt.path = [];
      nxt.pathI = 0;
    }
  }
  deliverWood(b) {
    if (b.hp <= 0 || b.need <= 0 || b.wood >= b.need) return;
    b.wood += 1;
    if (b.wood < b.need) return;
    this.completeStep(b);
  }
  completeStep(b) {
    if (b.kind === "hut") {
      this.upgradeBuilding(b, Math.min(3, b.level + 1));
      return;
    }
    if (isCampKind(b.kind) && b.level === 0) this.upgradeBuilding(b, 1);
  }
  upgradeBuilding(b, level) {
    b.level = level;
    const pad = padSize(b.kind === "hut" ? level : 1);
    const h = this.world.heightAt(b.x, b.z);
    this.world.flattenPad(b.x, b.z, pad.w, pad.d, b.yaw, h);
    b.padW = pad.w;
    b.padD = pad.d;
    b.y = this.world.heightAt(b.x, b.z);
    const hp = houseHp(Math.max(1, level));
    const ratio = b.maxHp > 0 ? b.hp / b.maxHp : 1;
    b.maxHp = hp;
    b.hp = Math.max(1, Math.round(hp * ratio));
    b.wood = 0;
    b.need = woodNeedFor(b.kind, level);
    this.markHouseBlocks();
    if (b.kind === "hut") {
      if (level === 1) this.toast(b.team === BLUE ? "\u5B50\u6C11\u7B51\u8D77\u4E00\u5EA7\u5C4B\u5B87" : "\u654C\u6C11\u7B51\u5C4B");
      else this.toast(b.team === BLUE ? `\u8305\u5C4B\u5347\u81F3 ${level} \u7EA7` : "\u654C\u65B9\u8305\u5C4B\u5347\u7EA7");
    } else if (isCampKind(b.kind)) {
      this.toast(b.team === BLUE ? "\u8BAD\u7EC3\u8425\u843D\u6210" : "\u654C\u65B9\u8BAD\u7EC3\u8425\u843D\u6210");
    }
  }
  needsWood(b) {
    return b.hp > 0 && b.need > 0 && b.wood < b.need;
  }
  hasNeedSite(team) {
    return this.buildings.some((b) => b.team === team && this.needsWood(b));
  }
  nearestNeedSite(team, x, z) {
    let best = null;
    let bestD = 1e9;
    for (const b of this.buildings) {
      if (b.team !== team || !this.needsWood(b)) continue;
      const d = dist2(x, z, b.x, b.z);
      if (d < bestD) {
        bestD = d;
        best = b;
      }
    }
    return best;
  }
  buildingById(id) {
    if (!id) return null;
    return this.buildings.find((b) => b.id === id && b.hp > 0) ?? null;
  }
  wantedCampToFound(team) {
    for (const k of this.teams[team].wanted) {
      const exists = this.buildings.some((b) => b.team === team && b.kind === k && b.hp > 0);
      if (!exists) return k;
    }
    return null;
  }
  nearestTree(x, z) {
    let best = null;
    let bestD = 1e9;
    for (const t of this.trees) {
      if (!t.alive) continue;
      const d = dist2(x, z, t.x, t.z);
      if (d < bestD) {
        bestD = d;
        best = t;
      }
    }
    return best;
  }
  repath(u) {
    if (u.team === NEUTRAL) {
      this.wander(u);
      return;
    }
    const team = this.teams[u.team];
    const enemy = u.team === BLUE ? RED : BLUE;
    if (this.armageddon) {
      u.order = "fight";
      u.path = astar(this.world, u.x, u.z, WORLD * 0.5, WORLD * 0.5);
      u.pathI = 0;
      return;
    }
    if (u.job === "train" && u.targetId) {
      const camp2 = this.buildingById(u.targetId);
      if (camp2) {
        const queue = this.trainQueue(camp2.id);
        let slot = queue.findIndex((o) => o.id === u.id);
        if (slot < 0) slot = queue.length;
        const dest = this.trainSlotPos(camp2, slot);
        if (dist2(u.x, u.z, dest.x, dest.z) <= 0.18 * 0.18) {
          u.path = [];
          u.pathI = 0;
        } else {
          this.pathToSlot(u, dest);
        }
        return;
      }
    }
    if (u.kind === "preacher") {
      const tgt = this.nearestConvertible(u);
      if (tgt) {
        u.path = astar(this.world, u.x, u.z, tgt.x, tgt.z);
        u.pathI = 0;
        return;
      }
    }
    if (u.kind === "warrior" || u.kind === "firewarrior" || u.order === "fight") {
      const tgt = this.nearestThreat(u, enemy);
      if (tgt) {
        u.path = astar(this.world, u.x, u.z, tgt.x, tgt.z);
        u.pathI = 0;
        return;
      }
    }
    if (u.kind === "shaman" && u.order === "settle") {
      const home = this.nearestHouse(u.team, u.x, u.z);
      if (home && dist2(u.x, u.z, home.x, home.z) > 9) {
        u.path = astar(this.world, u.x, u.z, home.x, home.z);
        u.pathI = 0;
      } else {
        this.wander(u);
      }
      return;
    }
    if (u.order === "shaman") {
      const sh = this.units.find((o) => o.team === u.team && o.kind === "shaman");
      if (sh) {
        u.path = astar(this.world, u.x, u.z, sh.x, sh.z);
        u.pathI = 0;
        return;
      }
    }
    if (u.order === "gather") {
      u.path = astar(this.world, u.x, u.z, team.magnetX, team.magnetZ);
      u.pathI = 0;
      return;
    }
    if (u.kind === "walker" && u.order === "settle") {
      this.repathSettle(u);
      return;
    }
    this.wander(u);
  }
  isAssignedFounder(u) {
    return u.kind === "walker" && u.settleX >= 0 && u.carry === 0 && u.job !== "chop" && u.job !== "haul" && u.job !== "train";
  }
  mayFoundCamp(u, wantCamp) {
    if (!wantCamp || u.foundKind !== wantCamp || u.carry !== 0) return false;
    if (u.job === "chop" || u.job === "haul" || u.job === "train") return false;
    return true;
  }
  tryPrepFound(x, z, yaw) {
    if (!inMap(x, z)) return false;
    if (this.world.heightAt(x, z) <= WATER) return false;
    const pad = padSize(1);
    const mine = { x, z, w: pad.w + 0.7, d: pad.d + 0.7, yaw };
    for (const b of this.buildings) {
      if (b.hp <= 0) continue;
      if (padsOverlap(mine, this.buildingPad(b))) return false;
    }
    const h = Math.max(this.world.heightAt(x, z), 0.8);
    this.world.flattenPad(x, z, pad.w + 1, pad.d + 1, yaw, h);
    return this.canFound(x, z, 1, yaw);
  }
  findCampSite(u) {
    const home = isTribe(u.team) ? this.nearestHouse(u.team, u.x, u.z) : null;
    const ox = home ? home.x : u.x;
    const oz = home ? home.z : u.z;
    const yaw = snapYaw(home ? home.yaw : u.yaw);
    const toCx2 = WORLD * 0.5 - ox;
    const toCz2 = WORLD * 0.5 - oz;
    const len2 = Math.hypot(toCx2, toCz2) || 1;
    const fx2 = toCx2 / len2;
    const fz2 = toCz2 / len2;
    const px2 = -fz2;
    const pz2 = fx2;
    const dists = [6.2, 7.6, 5.4, 9];
    const sides = [0, 1.1, -1.1, 2.1, -2.1];
    for (const dist of dists) {
      for (const side of sides) {
        const x = clamp(ox + fx2 * dist + px2 * side * 2.4, 3, WORLD - 3);
        const z = clamp(oz + fz2 * dist + pz2 * side * 2.4, 3, WORLD - 3);
        if (this.tryPrepFound(x, z, yaw)) {
          u.settleYaw = yaw;
          return { x, z };
        }
      }
    }
    const site = this.findSettleSite(u);
    if (site && this.tryPrepFound(site.x, site.z, u.settleYaw)) return site;
    return site;
  }
  repathSettle(u) {
    if (!isTribe(u.team)) {
      this.wander(u);
      return;
    }
    if (u.carry === 1) {
      const site = this.nearestNeedSite(u.team, u.x, u.z);
      if (site) {
        u.job = "haul";
        u.targetId = site.id;
        const edge = this.padEdge(site.x, site.z, site.padW, site.padD, site.yaw, u.x, u.z);
        u.path = astar(this.world, u.x, u.z, edge.x, edge.z);
        u.pathI = 0;
        return;
      }
    }
    const wantCamp = u.foundKind;
    if (wantCamp && this.mayFoundCamp(u, wantCamp)) {
      let site = null;
      if (u.settleX >= 0 && this.tryPrepFound(u.settleX, u.settleZ, u.settleYaw)) site = { x: u.settleX, z: u.settleZ };
      if (!site) site = this.findCampSite(u);
      if (site) {
        const made = this.foundSite(u.team, site.x, site.z, u.settleYaw, wantCamp);
        u.settleX = -1;
        u.settleZ = -1;
        if (made) {
          u.foundKind = null;
          this.toast(u.team === BLUE ? "\u5F00\u59CB\u642D\u5EFA\u8BAD\u7EC3\u8425" : "\u654C\u65B9\u5F00\u5EFA\u8BAD\u7EC3\u8425");
        }
      }
    }
    if (this.hasNeedSite(u.team) && u.carry === 0) {
      const tree = this.nearestTree(u.x, u.z);
      if (tree) {
        u.job = "chop";
        u.targetId = tree.id;
        u.channel = 0;
        u.settleX = -1;
        u.settleZ = -1;
        const dest = this.world.walkableAt(tree.x, tree.z) ? tree : nearestLand(this.world, tree.x, tree.z);
        if (dest) {
          u.path = astar(this.world, u.x, u.z, dest.x, dest.z);
          u.pathI = 0;
          return;
        }
      }
    }
    if (!this.hasNeedSite(u.team) && !wantCamp) {
      if (u.team === BLUE) {
        this.wander(u);
        return;
      }
      let site = null;
      if (u.settleX >= 0 && this.canFound(u.settleX, u.settleZ, 1, u.settleYaw) && !this.buildingAt(u.settleX, u.settleZ)) {
        site = { x: u.settleX, z: u.settleZ };
      }
      if (!site) site = this.findSettleSite(u);
      if (site) {
        u.settleX = site.x;
        u.settleZ = site.z;
        const pad = padSize(1);
        const edge = this.padEdge(site.x, site.z, pad.w, pad.d, u.settleYaw, u.x, u.z);
        u.path = astar(this.world, u.x, u.z, edge.x, edge.z);
        u.pathI = 0;
        return;
      }
    }
    this.wander(u);
  }
  wander(u) {
    for (let i = 0; i < 8; i++) {
      const tx = clamp(u.x + Math.random() * 10 - 5, 1, WORLD - 1);
      const tz = clamp(u.z + Math.random() * 10 - 5, 1, WORLD - 1);
      if (this.world.walkableAt(tx, tz)) {
        u.path = astar(this.world, u.x, u.z, tx, tz);
        u.pathI = 0;
        return;
      }
    }
    u.path = [];
  }
  findSettleSite(u) {
    const home = isTribe(u.team) ? this.nearestHouse(u.team, u.x, u.z) : null;
    const ox = home ? home.x : u.x;
    const oz = home ? home.z : u.z;
    const yaw = snapYaw(u.yaw);
    for (let i = 0; i < 36; i++) {
      const baseX = i < 18 ? ox : u.x;
      const baseZ = i < 18 ? oz : u.z;
      const x = clamp(baseX + Math.random() * 18 - 9, 2, WORLD - 2);
      const z = clamp(baseZ + Math.random() * 18 - 9, 2, WORLD - 2);
      if (!this.canFound(x, z, 1, yaw)) continue;
      u.settleYaw = yaw;
      return { x, z };
    }
    return null;
  }
  nearestThreat(u, enemy) {
    let best = null;
    let bestD = 1e9;
    for (const o of this.units) {
      if (o.team !== enemy) continue;
      const d = dist2(u.x, u.z, o.x, o.z);
      if (d < bestD) {
        bestD = d;
        best = o;
      }
    }
    for (const b of this.buildings) {
      if (b.team !== enemy) continue;
      const d = dist2(u.x, u.z, b.x, b.z) * 0.85;
      if (d < bestD) {
        bestD = d;
        best = { x: b.x, z: b.z };
      }
    }
    return best;
  }
  nearestHouse(team, x, z) {
    let best = null;
    let bestD = 1e9;
    for (const b of this.buildings) {
      if (b.team !== team || b.hp <= 0) continue;
      const d = dist2(x, z, b.x, b.z);
      if (d < bestD) {
        bestD = d;
        best = b;
      }
    }
    return best;
  }
  moveUnits(dt) {
    for (const u of this.units) {
      const swamp = this.world.swamp[this.world.sampleAt(u.x, u.z)] > 0;
      let spd = 2.4;
      if (u.kind === "warrior") spd = 3.3;
      else if (u.kind === "preacher") spd = 2.55;
      else if (u.kind === "firewarrior") spd = 2.7;
      else if (u.kind === "shaman") spd = 2.1;
      else if (u.kind === "spy") spd = 2.8;
      else if (u.kind === "wildman") spd = 1.8;
      if (swamp) spd *= 0.45;
      if (u.kind === "preacher" && u.channel > 0) {
        u.y = this.world.heightAt(u.x, u.z);
        continue;
      }
      if (u.job === "train" && u.channel > 0) {
        u.y = this.world.heightAt(u.x, u.z);
        continue;
      }
      if (!u.path.length) {
        u.y = this.world.heightAt(u.x, u.z);
        continue;
      }
      if (u.pathI >= u.path.length) {
        u.path = [];
        this.onArrive(u);
        u.y = this.world.heightAt(u.x, u.z);
        continue;
      }
      const step = u.path[u.pathI];
      if (!this.world.walkableAt(step.x, step.z) && !this.trainAllows(u, step.x, step.z)) {
        u.pathI++;
        continue;
      }
      const dx = step.x - u.x;
      const dz = step.z - u.z;
      const len2 = Math.hypot(dx, dz);
      if (len2 < 0.08) {
        u.pathI++;
        if (u.pathI >= u.path.length) {
          u.path = [];
          this.onArrive(u);
        }
        continue;
      }
      const m = Math.min(1, spd * dt / len2);
      u.x += dx * m;
      u.z += dz * m;
      u.yaw = Math.atan2(dx, dz);
      u.y = this.world.heightAt(u.x, u.z);
    }
    this.resolveCollisions();
    for (const u of this.units) u.y = this.world.heightAt(u.x, u.z);
  }
  trainAllows(u, x, z) {
    if (u.job !== "train") return false;
    const camp2 = this.buildingById(u.targetId);
    if (!camp2) return false;
    if (inPad(x, z, this.buildingPad(camp2), 0.25)) return true;
    const queue = this.trainQueue(camp2.id);
    let slot = queue.findIndex((o) => o.id === u.id);
    if (slot < 0) slot = 0;
    const dest = this.trainSlotPos(camp2, slot);
    return dist2(x, z, dest.x, dest.z) <= 0.55 * 0.55;
  }
  onArrive(u) {
    u.think = 0;
  }
  resolveCollisions() {
    for (const u of this.units) {
      const r = UNIT_RADIUS[u.kind];
      if (!this.world.walkableAt(u.x, u.z) && u.job !== "train") {
        const safe = nearestLand(this.world, u.x, u.z);
        if (safe) {
          u.x = safe.x;
          u.z = safe.z;
          u.path = [];
          u.pathI = 0;
        }
      }
      for (const b of this.buildings) {
        if (b.hp <= 0) continue;
        if (u.job === "train" && u.targetId === b.id) continue;
        const pushed = pushCircleFromPad(u.x, u.z, r, this.buildingPad(b));
        u.x = pushed.x;
        u.z = pushed.z;
      }
    }
    const n = this.units.length;
    for (let i = 0; i < n; i++) {
      const a = this.units[i];
      const ra = UNIT_RADIUS[a.kind];
      for (let j = i + 1; j < n; j++) {
        const b = this.units[j];
        const rb = UNIT_RADIUS[b.kind];
        const dx = a.x - b.x;
        const dz = a.z - b.z;
        const d2 = dx * dx + dz * dz;
        const need = ra + rb;
        if (d2 >= need * need || d2 < 1e-8) continue;
        const d = Math.sqrt(d2);
        const push = (need - d) / d * 0.5;
        a.x += dx * push;
        a.z += dz * push;
        b.x -= dx * push;
        b.z -= dz * push;
      }
      a.x = clamp(a.x, 0.3, WORLD - 0.3);
      a.z = clamp(a.z, 0.3, WORLD - 0.3);
    }
    for (const u of this.units) {
      if (u.job !== "train" || !u.targetId) continue;
      const camp2 = this.buildingById(u.targetId);
      if (!camp2) continue;
      const queue = this.trainQueue(camp2.id);
      const slot = queue.findIndex((o) => o.id === u.id);
      if (slot < 0) continue;
      const dest = this.trainSlotPos(camp2, slot);
      if (dist2(u.x, u.z, dest.x, dest.z) < 0.55 * 0.55) {
        u.x += (dest.x - u.x) * 0.85;
        u.z += (dest.z - u.z) * 0.85;
      }
    }
  }
  combat(dt) {
    for (const u of this.units) {
      if (!isTribe(u.team)) continue;
      const enemy = u.team === BLUE ? RED : BLUE;
      if (u.kind === "preacher") {
        this.preach(u, dt);
        continue;
      }
      const fighter = u.kind === "warrior" || u.kind === "firewarrior" || u.order === "fight";
      if (!fighter) continue;
      if (u.kind === "firewarrior" && u.atkCd <= 0) {
        const tgt = this.closestEnemyUnit(u, enemy, 4.6);
        if (tgt) {
          const dx = tgt.x - u.x;
          const dz = tgt.z - u.z;
          const len2 = Math.hypot(dx, dz) || 1;
          this.shots.push({
            x: u.x,
            z: u.z,
            y: u.y + 0.45,
            vx: dx / len2 * 9,
            vz: dz / len2 * 9,
            team: u.team,
            dmg: 3.4,
            life: 0.75,
            knock: 0.4,
            ox: u.x,
            oz: u.z
          });
          u.atkCd = 1.15;
          continue;
        }
      }
      const meleeR = 0.85;
      let hitU = null;
      let hitD = meleeR * meleeR;
      for (const o of this.units) {
        if (o.team !== enemy) continue;
        const d = dist2(u.x, u.z, o.x, o.z);
        if (d < hitD) {
          hitD = d;
          hitU = o;
        }
      }
      if (hitU) {
        const dmg = (u.kind === "warrior" ? 4.2 : 1.4 + u.str * 0.4) * dt;
        hitU.hp -= dmg;
        continue;
      }
      for (const b of this.buildings) {
        if (b.team !== enemy) continue;
        if (dist2(u.x, u.z, b.x, b.z) > (b.padW * 0.5 + 0.9) * (b.padW * 0.5 + 0.9)) continue;
        const burn = (u.kind === "warrior" ? 7 : u.kind === "firewarrior" ? 5 : 3.5) * dt;
        b.hp -= burn;
        break;
      }
    }
  }
  preach(u, dt) {
    const reach2 = 1.25 * 1.25;
    let tgt = null;
    let bestD = reach2;
    const enemy = u.team === BLUE ? RED : BLUE;
    for (const o of this.units) {
      if (o.id === u.id) continue;
      const foe = o.team === enemy || o.team === NEUTRAL;
      if (!foe || !canConvert(o.kind)) continue;
      const d = dist2(u.x, u.z, o.x, o.z);
      if (d < bestD) {
        bestD = d;
        tgt = o;
      }
    }
    if (!tgt) {
      u.channel = 0;
      u.channelId = 0;
      return;
    }
    u.path = [];
    if (u.channelId !== tgt.id) {
      u.channel = 0;
      u.channelId = tgt.id;
    }
    u.channel += dt;
    if (u.channel < 1.35) return;
    u.channel = 0;
    u.channelId = 0;
    tgt.team = u.team;
    tgt.kind = "walker";
    tgt.str = Math.max(1, tgt.str);
    tgt.hp = tgt.maxHp = unitHp("walker", tgt.str);
    tgt.order = this.teams[u.team].order;
    tgt.path = [];
    tgt.pathI = 0;
    tgt.think = 0;
    tgt.channel = 0;
    tgt.channelId = 0;
    tgt.selected = false;
    tgt.disguise = null;
    tgt.carry = 0;
    tgt.job = "idle";
    tgt.targetId = 0;
    tgt.trainKind = null;
    tgt.foundKind = null;
    this.toast(u.team === BLUE ? "\u4E00\u540D\u654C\u4EBA\u7688\u4F9D" : "\u4E00\u540D\u5B50\u6C11\u88AB\u611F\u5316");
  }
  nearestConvertible(u) {
    const enemy = u.team === BLUE ? RED : BLUE;
    let best = null;
    let bestD = 1e9;
    for (const o of this.units) {
      if (o.id === u.id) continue;
      if (!canConvert(o.kind)) continue;
      if (o.team !== enemy && o.team !== NEUTRAL) continue;
      let d = dist2(u.x, u.z, o.x, o.z);
      if (o.kind === "walker" || o.kind === "wildman") d *= 0.65;
      if (d < bestD) {
        bestD = d;
        best = o;
      }
    }
    return best;
  }
  pushUnit(u, fromX, fromZ, dist) {
    let dx = u.x - fromX;
    let dz = u.z - fromZ;
    const len2 = Math.hypot(dx, dz) || 1;
    dx /= len2;
    dz /= len2;
    const steps = 10;
    let x = u.x;
    let z = u.z;
    for (let i = 1; i <= steps; i++) {
      const tx = u.x + dx * dist * (i / steps);
      const tz = u.z + dz * dist * (i / steps);
      if (!this.world.walkableAt(tx, tz)) break;
      x = tx;
      z = tz;
    }
    u.x = clamp(x, 0.3, WORLD - 0.3);
    u.z = clamp(z, 0.3, WORLD - 0.3);
    u.path = [];
    u.pathI = 0;
    u.think = 0.15;
  }
  closestEnemyUnit(u, enemy, range) {
    let best = null;
    let bestD = range * range;
    for (const o of this.units) {
      if (o.team !== enemy) continue;
      const d = dist2(u.x, u.z, o.x, o.z);
      if (d < bestD) {
        bestD = d;
        best = o;
      }
    }
    return best;
  }
  projectiles(dt) {
    for (const p of this.shots) {
      p.x += p.vx * dt;
      p.z += p.vz * dt;
      p.life -= dt;
      const enemy = p.team === BLUE ? RED : BLUE;
      for (const u of this.units) {
        if (u.team !== enemy) continue;
        if (dist2(p.x, p.z, u.x, u.z) < 0.28) {
          u.hp -= p.dmg;
          if (p.knock > 0) this.pushUnit(u, p.ox, p.oz, p.knock);
          p.life = 0;
          break;
        }
      }
      if (p.life > 0) {
        const b = this.buildingAt(p.x, p.z);
        if (b && b.team === enemy) {
          b.hp -= p.dmg;
          p.life = 0;
        }
      }
    }
    this.shots = this.shots.filter((p) => p.life > 0);
  }
  hazards(dt) {
    for (const u of this.units) {
      if (!inMap(u.x, u.z) || this.world.heightAt(u.x, u.z) <= WATER) {
        u.hp -= 4 * dt;
        continue;
      }
      const i = this.world.sampleAt(u.x, u.z);
      if (this.world.lava[i] > 0) u.hp -= 10 * dt;
      if (this.world.swamp[i] > 0) {
        u.hp = 0;
        this.world.swamp[i] = 0;
      }
    }
  }
  mergeWalkers() {
    if (this.freezeMerge) return;
    const walkers = this.units.filter((u) => u.kind === "walker" && u.str < 3 && u.job !== "train" && u.carry === 0);
    for (let i = 0; i < walkers.length; i++) {
      const a = walkers[i];
      if (a.hp <= 0) continue;
      for (let j = i + 1; j < walkers.length; j++) {
        const b = walkers[j];
        if (b.hp <= 0 || a.team !== b.team) continue;
        if (dist2(a.x, a.z, b.x, b.z) > 0.36) continue;
        a.str = Math.min(3, a.str + b.str);
        a.hp = a.maxHp = unitHp("walker", a.str);
        b.hp = 0;
        if (a.team === BLUE) this.toast("\u4E24\u540D\u5B50\u6C11\u5408\u4E3A\u66F4\u5F3A\u7684\u884C\u8005");
        break;
      }
    }
  }
  respawnShamans(dt) {
    for (const team of [BLUE, RED]) {
      const t = this.teams[team];
      if (t.hasShaman) continue;
      t.shamanRevive -= dt;
      if (t.shamanRevive > 0) continue;
      const rebirth = this.buildings.find((b) => b.team === team && b.kind === "rebirth" && b.hp > 0);
      const home = rebirth ?? this.nearestHouse(team, t.magnetX, t.magnetZ);
      const s2 = this.world.startPad(team);
      let x = s2.x;
      let z = s2.z + 1.2;
      if (home) {
        const spot = this.spawnNear(home);
        if (spot) {
          x = spot.x;
          z = spot.z;
        } else {
          x = home.x + 0.6;
          z = home.z + 1.2;
        }
      }
      this.addUnit(team, "shaman", x, z);
      t.shamanRevive = 0;
      this.toast(team === BLUE ? "\u796D\u53F8\u5728\u518D\u751F\u70B9\u5F52\u6765" : "\u654C\u65B9\u796D\u53F8\u590D\u6D3B");
    }
  }
  cull() {
    for (const u of this.units) {
      if (u.hp > 0) continue;
      if (u.kind === "shaman" && isTribe(u.team)) {
        this.teams[u.team].hasShaman = false;
        this.teams[u.team].shamanRevive = 8;
        this.toast(u.team === BLUE ? "\u796D\u53F8\u9668\u843D\uFF0C\u5C06\u5728\u518D\u751F\u70B9\u5F52\u6765" : "\u654C\u65B9\u796D\u53F8\u9668\u843D");
      }
    }
    this.units = this.units.filter((u) => u.hp > 0);
    const wrecked = this.buildings.filter((b) => b.hp <= 0);
    if (wrecked.length) {
      for (const b of wrecked) {
        if (b.team === BLUE && (b.kind === "hut" || isCampKind(b.kind))) this.toast("\u4E00\u5EA7\u5C4B\u5B87\u88AB\u6BC1");
      }
    }
    this.buildings = this.buildings.filter((b) => b.hp > 0);
  }
  checkWin() {
    if (this.lockWin) return;
    if (this.time < 20) return;
    const blueDead = this.countPop(BLUE) === 0 && this.countHouses(BLUE) === 0;
    const redDead = this.countPop(RED) === 0 && this.countHouses(RED) === 0;
    if (blueDead && redDead) this.winner = -1;
    else if (blueDead) this.winner = RED;
    else if (redDead) this.winner = BLUE;
  }
  damageArea(cx, cz, r, dmg, team) {
    for (const u of this.units) {
      if (team !== void 0 && u.team === team) continue;
      if (dist2(u.x, u.z, cx, cz) <= r * r) u.hp -= dmg;
    }
    for (const b of this.buildings) {
      if (team !== void 0 && b.team === team) continue;
      if (dist2(b.x, b.z, cx, cz) <= r * r) b.hp -= dmg;
    }
  }
};

// ../../tmp/slot-dump.ts
var sim = new Sim(new World(1989));
sim.freezeMerge = true;
sim.lockWin = true;
var s = sim.world.startPad(BLUE);
var toCx = WORLD * 0.5 - s.x;
var toCz = WORLD * 0.5 - s.z;
var len = Math.hypot(toCx, toCz) || 1;
var fx = toCx / len;
var fz = toCz / len;
var px = -fz;
var pz = fx;
var campX = s.x + fx * 8;
var campZ = s.z + fz * 8;
for (const [a, b] of [[8, 0], [7.2, 2.6], [7.2, -2.6], [9, 1.8], [6.6, 0]]) {
  const x = s.x + fx * a + px * b;
  const z = s.z + fz * a + pz * b;
  sim.tryPrepFound(x, z, s.yaw);
  if (sim.canFound(x, z, 1, s.yaw)) {
    campX = x;
    campZ = z;
    break;
  }
}
sim.placeComplete(BLUE, campX, campZ, s.yaw, "warriorHut", 1);
var camp = sim.buildings.find((b) => b.team === BLUE && b.kind === "warriorHut");
sim.markHouseBlocks();
console.log("start", s);
console.log("camp", { x: camp.x, z: camp.z, yaw: camp.yaw, w: camp.padW, d: camp.padD });
console.log("huts", sim.buildings.filter((b) => b.kind === "hut" && b.team === BLUE).map((b) => ({ x: b.x, z: b.z, w: b.padW, d: b.padD })));
var door = sim.trainDoor(camp);
console.log("door", door, "walkable", sim.world.walkableAt(door.x, door.z), "inPad", inPad(door.x, door.z, sim.buildingPad(camp)));
for (let i = 0; i < 8; i++) {
  const p = sim.trainSlotPos(camp, i);
  const dx = p.x - camp.x;
  const dz = p.z - camp.z;
  console.log(
    `slot ${i}`,
    p.x.toFixed(2),
    p.z.toFixed(2),
    "d",
    Math.hypot(dx, dz).toFixed(2),
    "walk",
    sim.world.walkableAt(p.x, p.z),
    "inPad",
    inPad(p.x, p.z, sim.buildingPad(camp)),
    "h",
    sim.world.heightAt(p.x, p.z).toFixed(2)
  );
}
