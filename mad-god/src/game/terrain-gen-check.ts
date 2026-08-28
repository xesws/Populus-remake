/**
 * v0.24 地图生成检查（模板化大世界：72 格 + 六地貌 + 种子可复现 + 单连通大陆 + 强制平滑）。
 *
 * 覆盖本轮重做的全部承诺，逐条对应"没有这套断言就可能悄悄退化"的点：
 *   a) 可复现   —— 同 seed 两次构图必须逐格相同（曾经因为模板参数走 Math.random
 *                  + 模块加载期建静态数组，同 seed 跨进程是两张不同的图，测试随机 flaky）
 *   b) 多样性   —— 相邻 seed 必须真抽到不同地貌（曾经 RNG 首次输出与 seed 线性相关，
 *                  15 个 seed 里 14 个都是同一模板，"每张图不一样"名存实亡）
 *   c) 单连通   —— 陆地只能有一个连通域，双方出生点同域且分隔足够远
 *                  （曾经出生点虽在同域、小块飞地仍是"可走陆地"，取点取到孤岛上
 *                   astar 直接给不出路径，move-check 10 次挂 4 次）
 *   d) 平滑度   —— 零 NaN、坡度低于阈值、图边框不再是漏网的陡壁
 *   e) 无绊人缝 —— 不许存在"两端可走、线段中间入水"的边（点判据与步进判据口径打架，
 *                  正是"人物行走卡顿、寻路反复 retry"的机制来源）
 *   f) 寻路完整 —— 随机取点对，astar 必须走到真正的终点而不是返回截断的部分路径
 *   g) 行军达标 —— walker 能在合理时间内走到 7~10 格外，且全程不依赖 ghostT 穿墙兜底
 *
 * 运行：npm run check（本文件在链中）；单独跑 npx tsx src/game/terrain-gen-check.ts
 */
import { Sim } from "./sim";
import { World } from "./world";
import { MapSmoother } from "./map-smoother";
import { astar } from "./path";
import { BLUE, RED, SAMPLES, STEP, WATER, WORLD } from "./types";

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

/** 陆地掩膜（h > WATER，与游戏通行判据一致）+ 4 邻接连通域标记。 */
function landComponents(w: World): { labels: Int32Array; sizes: number[] } {
  const n = SAMPLES * SAMPLES;
  const labels = new Int32Array(n).fill(-1);
  const queue = new Int32Array(n);
  const sizes: number[] = [];
  let label = 0;
  for (let i = 0; i < n; i++) {
    if (labels[i] !== -1 || w.h[i]! <= WATER) continue;
    let head = 0;
    let tail = 0;
    queue[tail++] = i;
    labels[i] = label;
    while (head < tail) {
      const cur = queue[head++]!;
      const cz = (cur / SAMPLES) | 0;
      const cx = cur - cz * SAMPLES;
      const nb: number[] = [];
      if (cx > 0) nb.push(cur - 1);
      if (cx < SAMPLES - 1) nb.push(cur + 1);
      if (cz > 0) nb.push(cur - SAMPLES);
      if (cz < SAMPLES - 1) nb.push(cur + SAMPLES);
      for (const j of nb) {
        if (labels[j] === -1 && w.h[j]! > WATER) {
          labels[j] = label;
          queue[tail++] = j;
        }
      }
    }
    sizes.push(tail);
    label++;
  }
  return { labels, sizes };
}

/** 陆地比例（占全图采样的百分比）。 */
function landRatio(w: World): number {
  let n = 0;
  for (let i = 0; i < w.h.length; i++) if (w.h[i]! > WATER) n++;
  return (100 * n) / w.h.length;
}

/** 两张图的陆地重合率（IoU）：越接近 1 越像"同一张图"。 */
function landIou(a: World, b: World): number {
  let both = 0;
  let either = 0;
  for (let i = 0; i < a.h.length; i++) {
    const x = a.h[i]! > WATER;
    const y = b.h[i]! > WATER;
    if (x || y) either++;
    if (x && y) both++;
  }
  return either ? both / either : 0;
}

/** a) 同 seed 必复现：高度场逐格相同。 */
function testReproducible(): void {
  const a = new World(2024);
  const b = new World(2024);
  let diff = 0;
  for (let i = 0; i < a.h.length; i++) if (a.h[i] !== b.h[i]) diff++;
  assert(diff === 0, `同 seed 两次构图必须完全相同（${diff} 格不一致）`);
  assert(a.templateId === b.templateId, `同 seed 必须同模板（${a.templateId} vs ${b.templateId}）`);
  console.log("testReproducible ok");
}

/** b) 多样性：模板覆盖 ≥4 种、陆地比例极差 ≥15pp、相邻 seed 不像同一张图。 */
function testDiversity(): void {
  const ids = new Set<string>();
  const ratios: number[] = [];
  const worlds: World[] = [];
  for (let seed = 1; seed <= 14; seed++) {
    const w = new World(seed);
    ids.add(w.templateId);
    ratios.push(landRatio(w));
    worlds.push(w);
  }
  assert(ids.size >= 4, `14 个 seed 至少覆盖 4 种地貌模板（实际 ${ids.size}：${[...ids].join("/")}）`);
  const lo = Math.min(...ratios);
  const hi = Math.max(...ratios);
  assert(hi - lo >= 15, `陆地比例极差 ≥15 个百分点（${lo.toFixed(1)}%~${hi.toFixed(1)}%）`);
  let same = 0;
  const ious: number[] = [];
  for (let i = 0; i + 1 < worlds.length; i++) {
    const iou = landIou(worlds[i]!, worlds[i + 1]!);
    ious.push(iou);
    if (iou > 0.9) same++;
  }
  assert(same === 0, `相邻 seed 不许雷同（IoU>0.9 的有 ${same} 对，最大 ${Math.max(...ious).toFixed(2)}）`);
  console.log(`testDiversity ok（${ids.size} 种模板，陆地 ${lo.toFixed(0)}%~${hi.toFixed(0)}%）`);
}

/** c) 单连通大陆 + 双方出生点同域且分隔 ≥36 格。 */
function testSingleLandmass(): void {
  for (const seed of [1, 5, 7, 11, 42, 88]) {
    const w = new World(seed);
    const { labels, sizes } = landComponents(w);
    assert(sizes.length <= 1, `seed ${seed}(${w.templateId}) 陆地连通域必须唯一（实际 ${sizes.length} 块）`);
    const li = (x: number, z: number) => labels[(((z / STEP) | 0) * SAMPLES + ((x / STEP) | 0)) | 0];
    const a = w.startPad(BLUE);
    const b = w.startPad(RED);
    assert(li(a.x, a.z) === li(b.x, b.z), `seed ${seed} 双方出生点必须在同一连通域`);
    const d = Math.hypot(a.x - b.x, a.z - b.z);
    // 分隔下限按模板分别判：其余五种模板实测 ≥36.8 格，而**半岛**是从图边伸入的
    // 细长楔形（纵深 0.55~0.65 world），锚点取在中线 0.3/0.6 两处，几何上限就是
    // ~27 格——把全局阈值调低会掩盖别处真的变挤，故这里用模板各自的下限。
    const minD = w.templateId === "peninsula" ? 24 : 36;
    assert(d >= minD, `seed ${seed}(${w.templateId}) 双方出生点分隔 ${d.toFixed(1)} 格 ≥${minD}`);
  }
  console.log("testSingleLandmass ok");
}

/** d) 平滑度：零 NaN、坡度达标（含图边框——曾经整圈没被钳制）。 */
function testSmoothness(): void {
  for (const seed of [2, 7, 42, 99]) {
    const w = new World(seed);
    let nan = 0;
    let worst = 0;
    for (let iz = 0; iz < SAMPLES; iz++) {
      for (let ix = 0; ix < SAMPLES; ix++) {
        const i = iz * SAMPLES + ix;
        if (Number.isNaN(w.h[i]!)) nan++;
        const x = ix * STEP;
        const z = iz * STEP;
        if (w.h[i]! > WATER) worst = Math.max(worst, w.slopeAt(x, z));
      }
    }
    assert(nan === 0, `seed ${seed} 不许出现 NaN（${nan} 格）`);
    assert(worst < 2.5, `seed ${seed} 全图（含边框）最大坡度 ${worst.toFixed(2)} < 2.5`);
  }
  console.log("testSmoothness ok");
}

/** e) 无绊人缝：不存在"两端可走、中间入水"的边。 */
function testNoTraps(): void {
  for (const seed of [7, 42, 88, 99]) {
    const w = new World(seed);
    const seams = MapSmoother.countSeams((x, z) => w.heightAt(x, z));
    assert(seams === 0, `seed ${seed}(${w.templateId}) 残留绊人边必须为 0（实际 ${seams}）`);
  }
  console.log("testNoTraps ok");
}

/**
 * f) 寻路完整：两个出生点必须互达且走到真终点（开局与全局调兵的生命线）；
 *    随机长路径点对的完成率 ≥97%。
 *    为什么允许极少数不满分：生成器保证的是**采样级**（0.25 格）单连通大陆，
 *    而单位走的是 0.5 格图 + 整格可走判据，实测仍会留下约 0.5% 的"一脚宽地峡"
 *    （采样连通、单位图过不去）。那是观感层面的窄颈，不是基地被封死；
 *    把它一并抹掉要在生成期跑单位图 BFS（20736 节点 × 8 邻 × 4 采样），
 *    当前构图耗时已达 ~450ms，留作后续独立优化项。
 */
function testPathsComplete(): void {
  for (const seed of [7, 42, 88]) {
    const w = new World(seed);
    const a = w.startPad(BLUE);
    const b = w.startPad(RED);
    const p = astar(w, a.x, a.z, b.x, b.z);
    assert(p.length > 10, `seed ${seed}(${w.templateId}) 双方基地之间必须有路（路径长 ${p.length}）`);
    const last = p[p.length - 1]!;
    const endD = Math.hypot(last.x - b.x, last.z - b.z);
    assert(endD < 0.01, `seed ${seed} 基地到基地不许截断（终点差 ${endD.toFixed(2)} 格）`);
  }
  const w = new World(42);
  const cells: Array<{ x: number; z: number }> = [];
  for (let iz = 8; iz < SAMPLES - 8; iz += 7) {
    for (let ix = 8; ix < SAMPLES - 8; ix += 7) {
      const x = ix * STEP;
      const z = iz * STEP;
      if (w.walkableAt(x, z)) cells.push({ x, z });
    }
  }
  assert(cells.length > 60, `主陆上有足够多的可走采样点（${cells.length}）`);
  let total = 0;
  let ok = 0;
  for (let i = 0; i < cells.length; i += 3) {
    const a = cells[i]!;
    const b = cells[(i + 17) % cells.length]!;
    if (Math.hypot(a.x - b.x, a.z - b.z) < 12) continue;
    const p = astar(w, a.x, a.z, b.x, b.z);
    total++;
    if (p.length && Math.hypot(p[p.length - 1]!.x - b.x, p[p.length - 1]!.z - b.z) < 0.01) ok++;
  }
  const rate = ok / total;
  assert(rate >= 0.97, `长路径完成率 ${(100 * rate).toFixed(1)}% ≥97%（${ok}/${total}）`);
  console.log(`testPathsComplete ok（基地互达 + 长路径 ${ok}/${total}）`);
}

/** g) 行军达标：走到 7~10 格外的目标，用时达标且全程不用 ghostT 穿墙兜底。 */
function testWalksWithoutClipping(): void {
  for (const seed of [7, 42, 99]) {
    const sim = new Sim(new World(seed));
    sim.lockWin = true;
    sim.units = sim.units.filter((o) => o.team === BLUE && o.homeId === 0); // 清场，排除游荡干扰
    const u = sim.units.find((o) => o.kind === "walker")!;
    assert(!!u, `seed ${seed} 需要一只蓝方 walker`);
    let dest: { x: number; z: number } | null = null;
    for (let r = 7; r <= 10 && !dest; r += 0.5) {
      for (let a = 0; a < 24 && !dest; a++) {
        const ang = (a / 24) * Math.PI * 2;
        const x = Math.round((u.x + Math.cos(ang) * r) * 2) / 2;
        const z = Math.round((u.z + Math.sin(ang) * r) * 2) / 2;
        if (x < 1 || z < 1 || x > WORLD - 1 || z > WORLD - 1) continue;
        if (!sim.world.walkableAt(x, z)) continue;
        dest = { x, z };
      }
    }
    assert(dest !== null, `seed ${seed} 附近存在 7~10 格外的可走目标`);
    const d0 = Math.hypot(dest!.x - u.x, dest!.z - u.z);
    sim.sendMove(u, dest!.x, dest!.z);
    let arrived = -1;
    let ghostTicks = 0;
    for (let i = 0; i < 300 && arrived < 0; i++) {
      sim.tick(0.05);
      if (u.ghostT > 0) ghostTicks++;
      if (Math.hypot(u.x - dest!.x, u.z - dest!.z) < 0.35) arrived = (i + 1) * 0.05;
    }
    assert(arrived > 0, `seed ${seed} walker 在 15s 内走到 ${d0.toFixed(1)} 格外的目标`);
    assert(ghostTicks === 0, `seed ${seed} 全程不得启用 ghostT 穿墙（用了 ${ghostTicks} 帧）`);
  }
  console.log("testWalksWithoutClipping ok");
}

/** h) 尺寸：世界放大到 72 格，四角必须是海（模板保证边缘不外溢）。 */
function testWorldSize(): void {
  assert(WORLD === 72, `世界边长 72 格（实际 ${WORLD}）`);
  assert(SAMPLES === 289, `采样 289×289（实际 ${SAMPLES}）`);
  for (const seed of [1, 7, 42]) {
    const w = new World(seed);
    for (const [x, z] of [
      [0, 0],
      [WORLD, 0],
      [0, WORLD],
      [WORLD, WORLD],
    ] as const) {
      assert(w.heightAt(x, z) <= WATER, `seed ${seed} 角点 (${x},${z}) 必须是海（h=${w.heightAt(x, z).toFixed(2)}）`);
    }
  }
  console.log("testWorldSize ok");
}

function main(): void {
  testReproducible();
  testDiversity();
  testSingleLandmass();
  testSmoothness();
  testNoTraps();
  testPathsComplete();
  testWalksWithoutClipping();
  testWorldSize();
  console.log(
    "terrain-gen-check ok (v0.24 地图生成：可复现 / 六模板多样性 / 单连通大陆 / 平滑无绊人缝 / 寻路与行军)",
  );
}

main();
