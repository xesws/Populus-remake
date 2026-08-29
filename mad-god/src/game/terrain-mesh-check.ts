/**
 * v0.25b 地形增量重绘检查（`npm run check` 第 24 项）
 * 针对的 bug：火山魔法一开，整个前端卡死。
 *
 * 机制（两条叠加，都在这一版修掉）：
 *  A. World 的脏区包围盒被 `tickFx` 里裸的 `this.dirty = true`（不带坐标）污染：
 *     `markSample` 的"新窗口从本格重新起算"分支永远进不去，包围盒跨帧单调增长，
 *     几秒内撑满全图。火山的 `holdPadsNearVolcano` 又每帧给全图每栋建筑重铺地基，
 *     脏点本来就散落全图 —— 任何"包围盒"口径都会被撑满。
 *  B. 撑满的包围盒 → 每帧走全量 `rebuildTerrain()` + `computeVertexNormals()`
 *     （实测 15.6ms/次）+ ≈1MB 顶点缓冲整块重传，而且 computeVertexNormals 每次
 *     还新建一个 1MB 的 BufferAttribute。火山活动期实测连续 680 帧全量重建 → 假死。
 *
 * 本检查锁四件事：
 *  1) 脏区窗口是**清单**语义：每帧的 paint/geom 列表规模有界，且窗口取走后立刻归零，
 *     不会跨帧增长（A 的回归锁）。
 *  2) 增量结果与整图重建**逐位一致**：位置、颜色、法线三个数组完全相等。
 *     这一条是局部法线正确性的硬要求 —— 只要局部累加与 three 的口径有任何偏差，
 *     重算区边缘就会出现可见的折光缝。
 *  3) 只改岩浆/焦土颜色（不动高度）的那一帧，法线一个字节都不许被改写（省掉整段开销的凭据）。
 *  4) 火山全程逐帧记账：没有任何一帧走全图重建，脏格数有界。
 */
import { Sim } from "./sim";
import { World } from "./world";
import { TerrainMesh } from "./render-parts/terrain-mesh";
import { BLUE, SAMPLES } from "./types";

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

const N = SAMPLES * SAMPLES;

/** 找一块足够开阔的陆地中心，作为"改高度"的实验台。 */
function labSpot(w: World): { x: number; z: number } {
  for (let r = 4; r < 20; r += 0.5) {
    for (let k = 0; k < 8; k++) {
      const a = (k / 8) * Math.PI * 2;
      const s = w.startPad(BLUE);
      const x = s.x + Math.cos(a) * r;
      const z = s.z + Math.sin(a) * r;
      if (x < 8 || z < 8 || x > 64 || z > 64) continue;
      if (w.heightAt(x, z) > 0.6 && w.slopeAt(x, z) < 0.3) return { x, z };
    }
  }
  const s = w.startPad(BLUE);
  return { x: s.x + 6, z: s.z + 6 };
}

/** 把 World 当前待重绘的窗口喂给 TerrainMesh（模拟渲染端一帧）。 */
function pump(world: World, mesh: TerrainMesh): void {
  mesh.syncWindow(world.takeDirtyWindow());
}

/** 1) 脏区窗口是清单语义，跨帧不增长。 */
function testWindowIsBounded(): void {
  const w = new World(42);
  w.markAll(); // 开局整图
  const first = w.takeDirtyWindow();
  assert(first !== null && first.all === true, "开局窗口是整图重建");
  assert(w.takeDirtyWindow() === null, "取走后同帧再取应为空");

  // 连续 200 帧，每帧只改一格颜色：清单长度必须恒为 1（旧实现里包围盒会一路撑到全图）。
  w.clearDirtyWindow();
  for (let f = 0; f < 200; f++) {
    w.scorch[10 * SAMPLES + 10] = 1 + f * 0.001;
    w.markPaint(10, 10);
    const win = w.takeDirtyWindow();
    assert(win !== null, `第 ${f} 帧应有窗口`);
    assert(win!.all === false, `第 ${f} 帧不该走整图重建`);
    assert(win!.paint.length === 1, `清单语义：第 ${f} 帧 paint=${win!.paint.length}，应恒为 1`);
    assert(win!.geom.length === 0, `只改颜色不该登记高度变更（geom=${win!.geom.length}）`);
    assert(
      win!.minX === 10 && win!.maxX === 10 && win!.minZ === 10 && win!.maxZ === 10,
      `包围盒不该跨帧累积（got ${win!.minX},${win!.maxX},${win!.minZ},${win!.maxZ}）`,
    );
  }

  // 同一格一帧内被标记 500 次 → 去重后只算一次（火山 holdPads 每帧重铺就吃这个）。
  w.clearDirtyWindow();
  for (let k = 0; k < 500; k++) w.markPaint(20, 20);
  const dedup = w.takeDirtyWindow();
  assert(dedup !== null && dedup.paint.length === 1, `同格重复标记必须去重（got ${dedup?.paint.length}）`);
}

/** 2) 增量 == 整图重建，逐位一致（位置 / 颜色 / 法线）。 */
function testIncrementalEqualsFull(): void {
  const w = new World(7);
  const a = new TerrainMesh(w);
  const b = new TerrainMesh(w);
  a.rebuild();
  b.rebuild();
  for (let i = 0; i < N * 3; i++) {
    assert(a.norArray[i] === b.norArray[i], `基线法线不一致 @${i}`);
  }

  const spot = labSpot(w);
  // 三次雕刻（抬 / 挖 / 再抬）：每次都只喂局部窗口给 a，b 一律整图重建。
  const dh = [1.1, -0.7, 0.45];
  for (let round = 0; round < dh.length; round++) {
    w.sculpt(spot.x, spot.z, 2.2, dh[round]!);
    w.pourLava(spot.x + 1.0, spot.z + 0.6, 0.9, 4.5); // 掺进只改颜色的格
    pump(w, a);
    b.rebuild();
    let worstN = 0;
    let worstP = 0;
    for (let i = 0; i < N * 3; i += 1) {
      const dn = Math.abs(a.norArray[i]! - b.norArray[i]!);
      const dp = Math.abs(a.posArray[i]! - b.posArray[i]!);
      if (dn > worstN) worstN = dn;
      if (dp > worstP) worstP = dp;
    }
    assert(worstP === 0, `round ${round}: 位置差异 ${worstP}`);
    assert(worstN === 0, `round ${round}: 法线最大差异 ${worstN}（局部累加必须与整图重建逐位相同）`);
  }
  console.log(`  ✓ 增量 vs 整图重建：位置/颜色/法线逐位一致（3 轮雕刻 + 铺浆）`);
}

/** 3) 只改颜色的那一帧，法线缓冲区必须一个字节都没被写。 */
function testColorOnlyFrameSkipsNormals(): void {
  const w = new World(123);
  const m = new TerrainMesh(w);
  m.rebuild();
  const before = Float32Array.from(m.norArray);
  w.pourLava(30, 30, 1.4, 6);
  w.scorch[30 * SAMPLES + 30] = 2.2;
  w.markPaint(30, 30);
  const win = w.takeDirtyWindow();
  assert(win !== null && win.geom.length === 0, "铺浆帧不应登记高度变更");
  m.syncWindow(win);
  let diff = 0;
  for (let i = 0; i < before.length; i++) diff += Math.abs(before[i]! - m.norArray[i]!);
  assert(diff === 0, `只改颜色的帧改动了法线缓冲区（累计差异 ${diff}）`);
  // 颜色确实变了
  assert(m.colArray[30 * SAMPLES * 3 + 3 * 3] !== 0, "颜色缓冲应有更新");
}

/** 4) 火山全程逐帧记账：没有一帧走整图重建，脏格数有界。 */
function testVolcanoNeverFullRebuilds(): void {
  const w = new World(42);
  const sim = new Sim(w);
  const mesh = new TerrainMesh(w);
  mesh.rebuild();
  w.clearDirtyWindow();
  sim.teams[BLUE].mana = 300;
  sim.teams[BLUE].manaCap = 300;
  const s = w.startPad(BLUE);
  const toCx = 36 - s.x;
  const toCz = 36 - s.z;
  const len = Math.hypot(toCx, toCz) || 1;
  const vx = s.x + (toCx / len) * 6;
  const vz = s.z + (toCz / len) * 6;
  const cast = sim.volcanoSpell.cast(sim, BLUE, vx, vz, 0);
  assert(cast.ok, `火山施放成功（${cast.msg}）`);

  const dt = 1 / 60;
  let frames = 0;
  let full = 0;
  let maxPaint = 0;
  let maxGeom = 0;
  let sumPaint = 0;
  let repaintFrames = 0;
  let ms = 0;
  for (let f = 0; f < 35 * 60; f++) {
    const t0 = performance.now();
    sim.tick(dt);
    const win = w.takeDirtyWindow();
    if (win) {
      if (win.all) full++;
      else {
        if (win.paint.length > maxPaint) maxPaint = win.paint.length;
        if (win.geom.length > maxGeom) maxGeom = win.geom.length;
        sumPaint += win.paint.length;
        if (win.paint.length > 0) repaintFrames++;
        mesh.syncWindow(win);
      }
    }
    ms += performance.now() - t0;
    frames++;
  }
  assert(full === 0, `火山全程出现 ${full} 帧整图重建（旧实现在这里是 ~680 帧）`);
  assert(
    maxPaint < N * 0.2,
    `单帧脏格数失控：max=${maxPaint}（全图 ${N}），说明又有全图散布式的标记没走清单`,
  );
  console.log(
    `  ✓ 火山 ${frames} 帧：0 帧整图重建，单帧脏格峰值 ${maxPaint}（geom 峰 ${maxGeom}），` +
      `重绘 ${repaintFrames} 帧、平均每帧 ${(sumPaint / Math.max(1, repaintFrames)).toFixed(0)} 格，` +
      `sim+重绘合计 ${(ms / frames).toFixed(2)}ms/帧`,
  );
}

function main(): void {
  console.log("v0.25b 地形增量重绘检查（火山卡死修复）");
  testWindowIsBounded();
  testIncrementalEqualsFull();
  testColorOnlyFrameSkipsNormals();
  testVolcanoNeverFullRebuilds();
  console.log("PASS: 脏区清单语义 / 增量=整图逐位一致 / 颜色帧跳过法线 / 火山零整图重建");
}

main();
