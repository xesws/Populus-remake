import { Cell, clamp, inMap, STEP, WATER, WORLD } from "./types";
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

/**
 * 绳套平滑（string pulling）：把路径上能"直线看见"的节点合并，减少锯齿折线。
 * v0.24 关键修正：采样必须**按距离**而不是固定 5 个点。
 * 旧实现只取 t=0,0.2,0.4,0.6,0.8 五个点（连终点都不查），而一次最多看 12 个节点
 * ≈6 格，采样间距达 1.2 格——0.5~1 格宽的水湾、建筑地基全被"跨"过去，于是单位被
 * 指向对岸的远节点、直着走进去：脚下变成不可走格 → resolveCollisions 用 nearestLand
 * 把它弹回原地（进度清零）→ watchStuck 判卡 → 2 次后干脆开 ghostT 穿墙。
 * 这就是"人物行走卡顿、寻路反复 retry"的机制性来源。
 * 现在按 STEP(0.25 格) 采样并覆盖到终点，并把抄近路跨度限制在 3 格内：
 * 只有走廊真的干净才会被合并，否则老老实实沿 astar 的逐节点走。
 */
export function pullString(world: World, fromX: number, fromZ: number, path: Cell[], fromI: number): number {
  if (fromI >= path.length - 1) return fromI;
  // 只能"跳过"能直线走通的节点，一条都不通时原样返回 fromI。
  // 旧实现在这里写死 best = fromI + 1：即使下一节点的直线被水/地基挡住也照样推进一格，
  // 于是 pathI 每帧 +1、0.7 秒就冲到路径末尾，单位盯着对岸的终点不敢迈步（移动层守卫
  // 让它原地不动），最后只能靠 watchStuck 的 ghostT 穿墙脱身——实测多花 6 秒。
  let best = fromI;
  const maxJ = Math.min(path.length - 1, fromI + 12);
  for (let j = fromI + 1; j <= maxJ; j++) {
    const pj = path[j]!;
    const segX = pj.x - fromX;
    const segZ = pj.z - fromZ;
    const span = Math.hypot(segX, segZ);
    if (span > 2.0) break; // 抄近路不超过 2 格：更远的关键点交给 astar
    // 采样间距必须**小于双线性格边长(0.25 格)**：取 STEP/2=0.125。
    // 上一版按 STEP 采样，正好每格跳一个点——而 walkableAt 现在是整格判据
    //（四角全陆），一个混合格的宽度就是 0.25 格，间距 0.25 的采样能整格跨过去，
    // 于是"抄近路"照样能把单位指向一条穿过混合格对角线上的假走廊。
    const steps = Math.max(2, Math.ceil(span / (STEP / 2)));
    let walkable = true;
    for (let s = 0; s <= steps; s++) {
      const t = s / steps; // 含终点（s = steps → t = 1），旧实现漏掉的那一段
      if (!world.walkableAt(fromX + segX * t, fromZ + segZ * t)) {
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
  // v0.24 预算随图放大：默认值原是 52 格图时代的 8000，而 72 格图的节点数是
  // 144×144=20736——跨图长距离绕行会撞预算，astar 返回**被截断的部分路径**
  //（单位走到半路就 idle 停下，实测差 0.25~5 格不等）。生成器已保证单连通大陆，
  // 所以走完预算仍到不了的目标就是真不可达（被地基/树墙封死），此时穷举也无意义，
  // 但 20736 是全图上限，实测最长跨图路径 ~60ms，只在玩家点击/绕行时发生。
  maxVisit = 20736,
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
    // v0.24 八边形距离（octile）：max + (√2−1)·min。
    // 旧式 max(dx,dz) + 0.001·min(dx,dz) 几乎不给对角步计分，在 diag 代价 1.42 的图上
    // 严重低估 → 退化成 Dijkstra 式均匀扩散；地图从 52 格放大到 72 格（节点 10816→20736）
    // 后直接撞 maxVisit，返回被截断的"部分路径"（单位走半路就 idle 停下）。
    // 一致性/可采纳性：步代价为 1 与 1.42 ≥ √2，climb/slope 只增不减，故恒不高估。
    return Math.max(dx, dz) + 0.4142 * Math.min(dx, dz);
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
      // v0.24 边的可通行性：节点栅格 0.5 格粗于地形场（heightAt 是插值），
      // 两个"可走"节点之间完全可以横着一条 <WATER 的细滩涂/水湾（实测半岛图
      // (65.0,20.5)→(65.5,21.0) 中点 h=0.137）——单位按直线走过去就中途下沉，
      // 被 resolveCollisions 的 nearestLand 弹回原地，形成 repath 死循环。
      // 采样密度与移动层同阶（每帧踩 spd·dt ≈0.12 格）：一条边取 4 等分（0.125 格）。
      // 只对贴水的临界边查（内陆边一次都不查）：无条件全查实测把 astar 平均耗时的
      // 从 1.3ms 抬到 5.7ms、最差 23.8ms，而每次重规划都要调它，CPU 吃不消。
      // 地基/树冠那类内陆缝隙交给移动层的"退半步"策略兜（见 path-system.walkUnits）。
      if (ch < WATER + 0.25 || nh < WATER + 0.25) {
        const segX = nwx - cwx;
        const segZ = nwz - cwz;
        let blocked = false;
        for (let s = 1; s <= 3; s++) {
          const t = s / 4;
          if (!world.walkableAt(cwx + segX * t, cwz + segZ * t)) {
            blocked = true;
            break;
          }
        }
        if (blocked) continue;
      }
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
