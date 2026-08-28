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

export function astar(
  world: World,
  sx: number,
  sz: number,
  tx: number,
  tz: number,
  maxVisit = 2400,
): Cell[] {
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
  const open: number[] = [];
  const start = sgz * GW + sgx;
  const goal = tgz * GW + tgx;
  gScore[start] = 0;
  open.push(start);

  const heur = (i: number) => {
    const x = i % GW;
    const z = (i / GW) | 0;
    const dx = Math.abs(x - tgx);
    const dz = Math.abs(z - tgz);
    return Math.max(dx, dz) + Math.min(dx, dz) * 0.001;
  };

  let visits = 0;
  let best = start;
  let bestH = heur(start);

  while (open.length && visits < maxVisit) {
    visits++;
    let bi = 0;
    let bv = 1e18;
    for (let i = 0; i < open.length; i++) {
      const n = open[i]!;
      const f = gScore[n]! + heur(n);
      if (f < bv) {
        bv = f;
        bi = i;
      }
    }
    const cur = open[bi]!;
    open[bi] = open[open.length - 1]!;
    open.pop();
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
      const cost = diag + climb * 1.15 + slope * 1.25 + swamp;
      const ni = nz * GW + nx;
      const ng = gScore[cur]! + cost;
      if (ng < gScore[ni]!) {
        gScore[ni] = ng;
        came[ni] = cur;
        open.push(ni);
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
