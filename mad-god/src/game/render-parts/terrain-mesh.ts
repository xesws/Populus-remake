import * as THREE from "three";
import { SAMPLES, STEP, WATER } from "../types";
import type { DirtyWindow, World } from "../world";

/**
 * v0.25b 地形网格（从 render.ts 的 makeTerrainGeo / paintVertex / rebuildTerrain /
 * updateDirtyTerrain 抽出成独立类，职责单一：**顶点色 + 顶点法线的增量维护**）。
 *
 * 为什么要有这个类（"火山一开整个前端卡死"的修复）：
 * 地形是 289×289 = 83521 顶点、166464 三角形的规则格网。旧实现只要有一格变脏，
 * 就按**包围盒**决定重绘范围，并且每帧无条件调 `geometry.computeVertexNormals()`
 * —— 那是全量重算（实测 15.6ms/次）+ 整块缓冲重传（≈1MB/帧）。
 * 而火山的 `holdPadsNearVolcano` 每帧给全图每栋建筑重铺地基，脏点散落在整张图上，
 * 包围盒必然被撑满 → 火山活动期连续 ~680 帧全量重建 → 主线程被吃满，看起来就是页面假死。
 *
 * 现在的口径（三件事分别计费）：
 * 1. 重绘集合 = `DirtyWindow.paint` 的**格清单**（World 用 epoch 时间戳去重），
 *    包围盒只用作上传区间，不再决定"要不要全图重建"。
 * 2. 法线只对 `DirtyWindow.geom`（这一帧真的改了高度的格）外扩 1 圈的那批顶点重算——
 *    一个顶点的法线只取决于它作为角点参与的那些格，所以"外扩 1 圈"是完备的。
 *    累加与 three 的 `computeVertexNormals` 等价（同索引序、同样累加未归一化的面法线、
 *    最后统一归一化），所以局部结果与全量重建一致，不会在重算区边缘留下折光缝。
 * 3. 缓冲上传走 `addUpdateRange`（按行给连续段），不再整块重传。
 *
 * 法线缓冲由本类自持（构造时一次性分配）：`geometry.computeVertexNormals()` 每次调用
 * 都新建一个 1MB 的 BufferAttribute，火山期每帧一个 → GC 抖动同样是掉帧来源。
 */

const COL_SEA = new THREE.Color("#1e5a88");
const COL_GRASS = new THREE.Color("#4e8d3b");
const COL_HILL = new THREE.Color("#8a8a4a");
const COL_ROCK = new THREE.Color("#9a8a6a");
const COL_SNOW = new THREE.Color("#e8e6de");
const COL_SCORCH = new THREE.Color("#3a2a1c");
// v0.18 焦土三档灰褐（Agent V 建议）：按 scorch 强度从浅灰褐 → 中灰褐 → 炭黑渐进。
const COL_SCORCH_MID = new THREE.Color("#57463a");
const COL_SCORCH_LIGHT = new THREE.Color("#6a5745");
const COL_LAVA = new THREE.Color("#e85d04");

/** 高度分带 + 岩浆/焦土混合（v0.25 拉开动态范围后这四档色带才真正都见得到）。 */
export function heightColor(h: number, lava: number, scorch: number, out: THREE.Color): void {
  if (lava > 8) {
    out.copy(COL_LAVA);
    return;
  }
  // v0.18b 薄浆渐变：流动前沿（lava 0.5~8）从地面色向亮橙过渡，物理流动的舌状边界肉眼可见。
  const lavaMix = lava > 0.5 ? Math.min(1, (lava - 0.5) / 7.5) * 0.92 : 0;
  if (scorch > 0.4) {
    // v0.18 焦土渐变：强焦（>1.6）炭黑 → 中焦灰褐 → 弱焦浅灰褐，干涸后地面呈灰褐色带。
    if (scorch > 1.6) out.copy(COL_SCORCH);
    else if (scorch > 0.9) out.copy(COL_SCORCH_MID);
    else out.copy(COL_SCORCH_LIGHT);
  } else if (h <= WATER) out.copy(COL_SEA);
  else if (h < 1.4) out.copy(COL_GRASS);
  else if (h < 2.6) out.copy(COL_HILL);
  else if (h < 4.2) out.copy(COL_ROCK);
  else out.copy(COL_SNOW);
  if (lavaMix > 0) out.lerp(COL_LAVA, lavaMix);
}

const N = SAMPLES * SAMPLES;
/** 每行顶点的 float 数（position/color 都是 3×SAMPLES）。 */
const ROW = SAMPLES * 3;
/** 格网一行有几个格。 */
const CS = SAMPLES - 1;

export class TerrainMesh {
  readonly geo: THREE.BufferGeometry;

  /** 只读视图，供检查脚本比对（见 terrain-mesh-check.ts）。 */
  get posArray(): Float32Array {
    return this.pos.array as Float32Array;
  }
  get colArray(): Float32Array {
    return this.col.array as Float32Array;
  }
  get norArray(): Float32Array {
    return this.nor.array as Float32Array;
  }

  private world: World;
  private pos: THREE.BufferAttribute;
  private col: THREE.BufferAttribute;
  private nor: THREE.BufferAttribute;
  private tmp = new THREE.Color();

  /** 本轮要重算法线的顶点集（epoch 去重，清单复用同一块 backing）。 */
  private vMark = new Uint32Array(N);
  private vList: number[] = [];
  /** 本轮参与累加的格（一格两个三角形）。 */
  private cMark = new Uint32Array(CS * CS);
  private cList: number[] = [];
  private epoch = 1;

  constructor(world: World) {
    this.world = world;
    const pos = new Float32Array(N * 3);
    const col = new Float32Array(N * 3);
    const idx: number[] = [];
    for (let iz = 0; iz < SAMPLES; iz++) {
      for (let ix = 0; ix < SAMPLES; ix++) {
        const i = iz * SAMPLES + ix;
        pos[i * 3] = ix * STEP;
        pos[i * 3 + 1] = 0;
        pos[i * 3 + 2] = iz * STEP;
      }
    }
    // 索引序固定为 (a,c,b) 与 (b,c,d)：下面的法线累加必须沿用同一顺序，
    // 否则与 three 的 computeVertexNormals 不等价（重算区边缘会出现可见折光缝）。
    for (let iz = 0; iz < CS; iz++) {
      for (let ix = 0; ix < CS; ix++) {
        const a = iz * SAMPLES + ix;
        const b = a + 1;
        const c = a + SAMPLES;
        const d = c + 1;
        idx.push(a, c, b, b, c, d);
      }
    }
    const geo = new THREE.BufferGeometry();
    this.pos = new THREE.BufferAttribute(pos, 3);
    this.col = new THREE.BufferAttribute(col, 3);
    this.nor = new THREE.BufferAttribute(new Float32Array(N * 3), 3);
    geo.setAttribute("position", this.pos);
    geo.setAttribute("color", this.col);
    geo.setAttribute("normal", this.nor);
    geo.setIndex(idx);
    this.geo = geo;
  }

  /** 整图重建：开局 / 换 seed / 导演切场景时调。 */
  rebuild(): void {
    for (let i = 0; i < N; i++) this.paint(i);
    // 整图重建走"无 range = 全量上传"，先把上一步可能残留的局部区间清掉。
    this.pos.clearUpdateRanges();
    this.col.clearUpdateRanges();
    this.nor.clearUpdateRanges();
    this.pos.needsUpdate = true;
    this.col.needsUpdate = true;
    this.recomputeNormalsAll();
    this.nor.needsUpdate = true;
    this.geo.computeBoundingSphere();
  }

  /**
   * 消费一帧的脏区窗口（`World.takeDirtyWindow()` 的返回值）。
   * @returns 本帧是否真的动了顶点缓冲。
   */
  syncWindow(win: DirtyWindow | null): boolean {
    if (!win) return false;
    if (win.all) {
      this.rebuild();
      return true;
    }
    if (win.paint.length === 0) return false;
    this.paintCells(win.paint);
    if (win.geom.length > 0) this.recomputeNormalsLocal(win.geom);
    return true;
  }

  /** 单个顶点：写高度 + 顶点色。 */
  private paint(i: number): void {
    const h = this.world.h[i]!;
    this.pos.setY(i, h);
    heightColor(h, this.world.lava[i]!, this.world.scorch[i]!, this.tmp);
    this.col.setXYZ(i, this.tmp.r, this.tmp.g, this.tmp.b);
  }

  /** 重绘清单里的顶点，并按行合并出上传区间。 */
  private paintCells(cells: number[]): void {
    let minRow = SAMPLES;
    let maxRow = -1;
    let minCol = SAMPLES;
    let maxCol = -1;
    for (const i of cells) {
      this.paint(i);
      const iz = (i / SAMPLES) | 0;
      const ix = i - iz * SAMPLES;
      if (iz < minRow) minRow = iz;
      if (iz > maxRow) maxRow = iz;
      if (ix < minCol) minCol = ix;
      if (ix > maxCol) maxCol = ix;
    }
    for (let iz = minRow; iz <= maxRow; iz++) {
      const start = iz * ROW + minCol * 3;
      const count = (maxCol - minCol + 1) * 3;
      this.pos.addUpdateRange(start, count);
      this.col.addUpdateRange(start, count);
    }
    this.pos.needsUpdate = true;
    this.col.needsUpdate = true;
  }

  /** 全量法线（与 three 的 computeVertexNormals 等价），只在整图重建时用。 */
  private recomputeNormalsAll(): void {
    const na = this.nor.array as Float32Array;
    na.fill(0);
    const hh = this.world.h;
    for (let cz = 0; cz < CS; cz++) {
      for (let cx = 0; cx < CS; cx++) {
        this.accumulateCell(cz * SAMPLES + cx, cx, cz, hh, na, -1);
      }
    }
    for (let i = 0; i < N; i++) this.normalizeVertex(i, na);
  }

  /**
   * 局部法线：`geom` = 这一帧改了高度的格号清单。
   * 重算顶点集 = 这些格的外扩 1 圈角点；累加三角形 = 这些顶点参与的全部格。
   */
  private recomputeNormalsLocal(geom: number[]): void {
    const na = this.nor.array as Float32Array;
    const ep = this.epoch;
    this.epoch = ep > 0xfffffffe ? ((this.vMark.fill(0), this.cMark.fill(0)), 1) : ep + 1;
    this.vList.length = 0;
    this.cList.length = 0;
    // 1) 要重算的顶点：改动格外扩 1 圈（顶点法线只看它参与的格 → 1 圈即完备）。
    for (const i of geom) {
      const iz = (i / SAMPLES) | 0;
      const ix = i - iz * SAMPLES;
      for (let dz = -1; dz <= 1; dz++) {
        const jz = iz + dz;
        if (jz < 0 || jz >= SAMPLES) continue;
        const row = jz * SAMPLES;
        for (let dx = -1; dx <= 1; dx++) {
          const jx = ix + dx;
          if (jx < 0 || jx >= SAMPLES) continue;
          const v = row + jx;
          if (this.vMark[v] === ep) continue;
          this.vMark[v] = ep;
          this.vList.push(v);
        }
      }
    }
    for (const v of this.vList) {
      const o = v * 3;
      na[o] = 0;
      na[o + 1] = 0;
      na[o + 2] = 0;
    }
    // 2) 这些顶点作为角点参与的格（每顶点至多 4 格），去重。
    for (const v of this.vList) {
      const vz = (v / SAMPLES) | 0;
      const vx = v - vz * SAMPLES;
      for (let dz = -1; dz <= 0; dz++) {
        const cz = vz + dz;
        if (cz < 0 || cz >= CS) continue;
        for (let dx = -1; dx <= 0; dx++) {
          const cx = vx + dx;
          if (cx < 0 || cx >= CS) continue;
          const c = cz * CS + cx;
          if (this.cMark[c] === ep) continue;
          this.cMark[c] = ep;
          this.cList.push(c);
        }
      }
    }
    const hh = this.world.h;
    for (const c of this.cList) {
      const cz = (c / CS) | 0;
      const cx = c - cz * CS;
      // gate=ep：只累加进本轮顶点集，范围外顶点的法线一律不动。
      this.accumulateCell(cz * SAMPLES + cx, cx, cz, hh, na, ep);
    }
    for (const v of this.vList) this.normalizeVertex(v, na);
    // 上传：按行给连续段（重算区可能不连通，逐行取本轮顶点的最小/最大列）。
    this.nor.clearUpdateRanges();
    let minRow = SAMPLES;
    let maxRow = -1;
    for (const v of this.vList) {
      const iz = (v / SAMPLES) | 0;
      if (iz < minRow) minRow = iz;
      if (iz > maxRow) maxRow = iz;
    }
    for (let iz = minRow; iz <= maxRow; iz++) {
      let lo = SAMPLES;
      let hi = -1;
      const row = iz * SAMPLES;
      for (let ix = 0; ix < SAMPLES; ix++) {
        if (this.vMark[row + ix] === ep) {
          if (ix < lo) lo = ix;
          hi = ix;
        }
      }
      if (hi < lo) continue;
      this.nor.addUpdateRange(row * 3 + lo * 3, (hi - lo + 1) * 3);
    }
    this.nor.needsUpdate = true;
  }

  /**
   * 一个格的两个三角形把各自未归一化的面法线累加到 4 个角点上。
   * `gate >= 0` 时只累加 `vMark[v] === gate` 的顶点（局部模式的边界保护）。
   */
  private accumulateCell(
    a: number,
    ix: number,
    iz: number,
    hh: Float32Array,
    na: Float32Array,
    gate: number,
  ): void {
    const b = a + 1;
    const c = a + SAMPLES;
    const d = c + 1;
    const ax = ix * STEP;
    const az = iz * STEP;
    const bx = ax + STEP;
    const bz = az;
    const cx = ax;
    const cz = az + STEP;
    const dx = bx;
    const dz = cz;
    const ay = hh[a]!;
    const by = hh[b]!;
    const cy = hh[c]!;
    const dy = hh[d]!;
    // 索引序 (a, c, b)
    this.addFace(a, ax, ay, az, c, cx, cy, cz, b, bx, by, bz, na, gate);
    // 索引序 (b, c, d)
    this.addFace(b, bx, by, bz, c, cx, cy, cz, d, dx, dy, dz, na, gate);
  }

  /** 面法线 = (v1-v0) × (v2-v0)，累加到三个角点（与 three 完全一致，含"不除以面积"）。 */
  private addFace(
    i0: number,
    x0: number,
    y0: number,
    z0: number,
    i1: number,
    x1: number,
    y1: number,
    z1: number,
    i2: number,
    x2: number,
    y2: number,
    z2: number,
    na: Float32Array,
    gate: number,
  ): void {
    const abx = x1 - x0;
    const aby = y1 - y0;
    const abz = z1 - z0;
    const acx = x2 - x0;
    const acy = y2 - y0;
    const acz = z2 - z0;
    const nx = aby * acz - abz * acy;
    const ny = abz * acx - abx * acz;
    const nz = abx * acy - aby * acx;
    this.addN(i0, nx, ny, nz, na, gate);
    this.addN(i1, nx, ny, nz, na, gate);
    this.addN(i2, nx, ny, nz, na, gate);
  }

  private addN(i: number, x: number, y: number, z: number, na: Float32Array, gate: number): void {
    if (gate >= 0) {
      if (this.vMark[i] !== gate) return;
    }
    const o = i * 3;
    na[o] += x;
    na[o + 1] += y;
    na[o + 2] += z;
  }

  private normalizeVertex(v: number, na: Float32Array): void {
    const o = v * 3;
    const x = na[o]!;
    const y = na[o + 1]!;
    const z = na[o + 2]!;
    const l = Math.sqrt(x * x + y * y + z * z) || 1;
    na[o] = x / l;
    na[o + 1] = y / l;
    na[o + 2] = z / l;
  }
}
