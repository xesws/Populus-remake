import { Cell, clamp, inMap, WORLD } from "./types";
import { World } from "./world";

const CELL = 0.5;
const GW = Math.round(WORLD / CELL);
const DX = [1, -1, 0, 0, 1, 1, -1, -1];
const DZ = [0, 0, 1, -1, 1, -1, 1, -1];

function gxOf(x: number): number {
  return clamp(Math.round(x / CELL), 0, GW - 1);
}

function worldOf(g: number): number {
  return g * CELL;
}

export function nearestLand(world: World, x: number, z: number): Cell | null {
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

class MinHeap {
  private data: { id: number; f: number; g: number }[] = [];

  get length(): number {
    return this.data.length;
  }

  push(id: number, f: number, g: number): void {
    let i = this.data.length;
    this.data.push({ id, f, g });
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.data[i]!.f < this.data[p]!.f) {
        const tmp = this.data[i]!;
        this.data[i] = this.data[p]!;
        this.data[p] = tmp;
        i = p;
      } else {
        break;
      }
    }
  }

  pop(): { id: number; f: number; g: number } | undefined {
    const len = this.data.length;
    if (len === 0) return undefined;
    const top = this.data[0]!;
    const last = this.data.pop()!;
    if (this.data.length > 0) {
      this.data[0] = last;
      let i = 0;
      const count = this.data.length;
      while (true) {
        const left = (i << 1) + 1;
        const right = left + 1;
        let smallest = i;
        if (left < count && this.data[left]!.f < this.data[smallest]!.f) {
          smallest = left;
        }
        if (right < count && this.data[right]!.f < this.data[smallest]!.f) {
          smallest = right;
        }
        if (smallest !== i) {
          const tmp = this.data[i]!;
          this.data[i] = this.data[smallest]!;
          this.data[smallest] = tmp;
          i = smallest;
        } else {
          break;
        }
      }
    }
    return top;
  }
}

export function pullString(world: World, fromX: number, fromZ: number, path: Cell[], fromI: number): number {
  if (fromI >= path.length - 1) return fromI;
  let best = fromI + 1;
  const maxJ = Math.min(path.length - 1, fromI + 12);
  for (let j = fromI + 1; j <= maxJ; j++) {
    const pj = path[j]!;
    let walkable = true;
    for (let s = 0; s <= 4; s++) {
      const t = s / 5;
      const x = fromX + (pj.x - fromX) * t;
      const z = fromZ + (pj.z - fromZ) * t;
      if (!world.walkableAt(x, z)) {
        walkable = false;
        break;
      }
    }
    if (!walkable) break;
    best = j;
  }
  return best;
}

export function astar(
  world: World,
  sx: number,
  sz: number,
  tx: number,
  tz: number,
  maxVisit = 8000,
): Cell[] {
  if (!inMap(sx, sz)) return [];
  if (!world.walkableAt(sx, sz)) {
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
  const heap = new MinHeap();
  const start = sgz * GW + sgx;
  const goal = tgz * GW + tgx;
  gScore[start] = 0;

  const heur = (i: number) => {
    const x = i % GW;
    const z = (i / GW) | 0;
    const dx = Math.abs(x - tgx);
    const dz = Math.abs(z - tgz);
    return Math.max(dx, dz) + Math.min(dx, dz) * 0.001;
  };

  heap.push(start, heur(start), 0);

  let visits = 0;
  let best = start;
  let bestH = heur(start);

  while (heap.length > 0 && visits < maxVisit) {
    const top = heap.pop()!;
    if (top.g > gScore[top.id]! + 1e-4) continue;
    visits++;
    const cur = top.id;
    if (cur === goal) return rebuild(came, cur, tx, tz);
    const h = heur(cur);
    if (h < bestH) {
      bestH = h;
      best = cur;
    }
    const cx = cur % GW;
    const cz = (cur / GW) | 0;
    const cwx = worldOf(cx);
    const cwz = worldOf(cz);
    const ch = world.heightAt(cwx, cwz);
    for (let k = 0; k < 8; k++) {
      const nx = cx + DX[k]!;
      const nz = cz + DZ[k]!;
      if (nx < 0 || nz < 0 || nx >= GW || nz >= GW) continue;
      const nwx = worldOf(nx);
      const nwz = worldOf(nz);
      if (!world.walkableAt(nwx, nwz)) continue;
      const nh = world.heightAt(nwx, nwz);
      const diag = k >= 4 ? 1.42 : 1;
      const swamp = world.swamp[world.sampleAt(nwx, nwz)]! > 0 ? 1.6 : 0;
      const climb = Math.abs(nh - ch);
      const slope = world.slopeAt(nwx, nwz);
      // v0.13 爬坡成本减半：地形已平滑，路径更直、展开更少、撞 maxVisit 更少。
      const cost = diag + climb * 0.6 + slope * 0.7 + swamp;
      const ni = nz * GW + nx;
      const ng = gScore[cur]! + cost;
      if (ng < gScore[ni]!) {
        gScore[ni] = ng;
        came[ni] = cur;
        heap.push(ni, ng + heur(ni), ng);
      }
    }
  }
  if (best !== start) return rebuild(came, best, worldOf(best % GW), worldOf((best / GW) | 0));
  return [];
}

function rebuild(came: Int32Array, end: number, tx: number, tz: number): Cell[] {
  const path: Cell[] = [];
  let c = end;
  while (c >= 0) {
    path.push({ x: worldOf(c % GW), z: worldOf((c / GW) | 0) });
    c = came[c]!;
  }
  path.reverse();
  if (path.length) {
    path[path.length - 1] = { x: tx, z: tz };
  }
  return path;
}
