/**
 * v0.25 阶段 4 检查：成片森林（world-gen/forests.ts + Sim.seedTrees 接线）。
 *
 * 覆盖的点（每条都对应一个"没有断言就会悄悄退化"的失效模式）：
 *   a) 成片性     —— 旧版是全图均匀散布，读不出"一片林子"。这里量两件事：
 *                    树数量级的**最近邻距离**远小于均匀散布的期望值，
 *                    且绝大多数树在 2 格内还有别的树（= 它在一片林子里，不是孤树）。
 *   b) 林线       —— v0.25 拉开高度后，均匀散布会把树留在雪顶与岩坡上（观感穿帮）。
 *                    断言零棵树长在高程 ≥2.6 或坡度 >0.55 的地方。
 *   c) 基地砍得到 —— 玩法级：所有林子都离基地太远 = 村民早期没木头。
 *                    断言双方基地到最近树的距离 ≤16 格。
 *   d) 不砸地基   —— 不许长在建筑/出生平台地基里，也不许长在水里。
 *   e) 可复现     —— 同一 World 两次构造，树位必须一致（走的是 world.rng，不许有 Math.random）。
 *
 * 运行：npm run check（本文件在链中）；单独跑 npx tsx src/game/forest-check.ts
 */
import { Sim } from "./sim";
import { World } from "./world";
import { BLUE, RED, RNG, WATER, WORLD } from "./types";
import { FOREST_DEFAULTS, ForestSeeder } from "./world-gen/forests";

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

function nearestTreeDist(sim: Sim, x: number, z: number): number {
  let best = Infinity;
  for (const t of sim.trees) best = Math.min(best, Math.hypot(t.x - x, t.z - z));
  return best;
}

/** a) 成片性：最近邻距离分布 + 有伴率。 */
function testClumped(): void {
  let total = 0;
  let withNeighbor = 0;
  let nnSum = 0;
  for (const seed of [7, 11, 42, 88]) {
    const sim = new Sim(new World(seed));
    const ts = sim.trees;
    assert(ts.length >= 20, `seed ${seed} 树数应够开局用（${ts.length}）`);
    total += ts.length;
    for (let i = 0; i < ts.length; i++) {
      let nn = Infinity;
      for (let j = 0; j < ts.length; j++) {
        if (i === j) continue;
        nn = Math.min(nn, Math.hypot(ts[i]!.x - ts[j]!.x, ts[i]!.z - ts[j]!.z));
      }
      nnSum += nn;
      if (nn <= 2.0) withNeighbor++;
    }
  }
  const meanNN = nnSum / total;
  const rate = withNeighbor / total;
  // 均匀散布在 72×72 上放 ~40 棵的期望最近邻约 5.7 格（0.5·sqrt(A/N)）；
  // 成簇后应降到 2 格量级，且绝大多数树 2 格内有伴。
  assert(meanNN < 3.0, `平均最近邻 ${meanNN.toFixed(2)} 格 <3（均匀散布约 5.7，说明没成片）`);
  // 0.7 而不是更高：簇边缘与簇之间的树天然会有几棵落单（sqrt 分布 + 林线/地基剔掉一批），
  // 实测 78%。真正要区分的对象是"均匀散布"——那时这个比率会低得多，而 0.7 仍然能把它抓住。
  assert(rate > 0.7, `2 格内有同伴的树占 ${(100 * rate).toFixed(0)}% >70%（孤树太多=还是散布）`);
  console.log(`testClumped ok（${total} 棵，平均最近邻 ${meanNN.toFixed(2)} 格，有伴率 ${(100 * rate).toFixed(0)}%）`);
}

/** b) 林线与坡度：树不许长在岩带以上或陡坡上。 */
function testTreeline(): void {
  let above = 0;
  let steep = 0;
  let inWater = 0;
  for (const seed of [1, 7, 11, 19, 42, 88, 99]) {
    const w = new World(seed);
    const sim = new Sim(w);
    for (const t of sim.trees) {
      if (w.heightAt(t.x, t.z) >= FOREST_DEFAULTS.treelineH) above++;
      if (w.slopeAt(t.x, t.z) > FOREST_DEFAULTS.maxSlope) steep++;
      if (w.heightAt(t.x, t.z) <= WATER) inWater++;
    }
  }
  assert(above === 0, `${above} 棵树长在林线（h≥2.6 岩带）以上`);
  assert(steep === 0, `${steep} 棵树长在坡度 >0.55 的陡坡上`);
  assert(inWater === 0, `${inWater} 棵树长在水里`);
  console.log("testTreeline ok");
}

/** c) 基地砍得到木头 + d) 不砸地基。 */
function testBaseAccess(): void {
  for (const seed of [1, 7, 11, 19, 42, 88, 99]) {
    const sim = new Sim(new World(seed));
    for (const team of [BLUE, RED]) {
      const pad = sim.world.startPad(team);
      const d = nearestTreeDist(sim, pad.x, pad.z);
      assert(d <= 16, `seed ${seed} ${team === BLUE ? "蓝" : "红"}方基地到最近树 ${d.toFixed(1)} 格 ≤16（否则早期没木头）`);
    }
    for (const t of sim.trees) {
      assert(t.x > 2 && t.z > 2 && t.x < WORLD - 2 && t.z < WORLD - 2, `seed ${seed} 树贴图边`);
      for (const b of sim.buildings) {
        const p = sim.buildingPad(b);
        assert(Math.hypot(t.x - p.x, t.z - p.z) > 1.2, `seed ${seed} 树长在建筑地基里`);
      }
    }
  }
  console.log("testBaseAccess ok");
}

/** e) 可复现：同一 seed 两次构造，树位逐棵相同。 */
function testReproducible(): void {
  const a = new Sim(new World(23)).trees.map((t) => `${t.x.toFixed(4)},${t.z.toFixed(4)}`).join("|");
  const b = new Sim(new World(23)).trees.map((t) => `${t.x.toFixed(4)},${t.z.toFixed(4)}`).join("|");
  assert(a === b, "同 seed 两次构造的树位必须完全相同");
  assert(a.length > 100, `确有树被种下（${a.split("|").length} 棵）`);
  console.log("testReproducible ok");
}

/** 脱离 World 的单测：合成地形（一半平原一半高山），验证林线判据本身。 */
function testSyntheticRidge(): void {
  const S = 120;
  const step = 0.5;
  const h = new Float32Array(S * S);
  for (let iz = 0; iz < S; iz++) {
    for (let ix = 0; ix < S; ix++) {
      const x = ix * step;
      h[iz * S + ix] = 0.5 + (x / (S * step)) * 5; // 西低东高，东坡进岩带
    }
  }
  const ground = {
    heightAt: (x: number, z: number) => h[((z / step) | 0) * S + ((x / step) | 0)]!,
    slopeAt: (_x: number, _z: number) => 0.2,
    walkableAt: (_x: number, _z: number) => true,
  };
  const spots = ForestSeeder.place(ground, new RNG(7), S * step, [], [{ x: 3, z: 3 }], {
    ...FOREST_DEFAULTS,
    clusters: [6, 6],
    perCluster: [10, 10],
    minStartDist: 1,
    tries: 400,
  });
  assert(spots.length > 0, `合成地形上应放下树（${spots.length}）`);
  const west = spots.filter((p) => ground.heightAt(p.x, p.z) < 2.6).length;
  assert(west === spots.length, `全部 ${spots.length} 棵都应在林线以下（有 ${spots.length - west} 棵跑到岩带上）`);
  assert(spots.some((p) => p.x < S * step * 0.5), "应有树落在西侧低地");
  console.log(`testSyntheticRidge ok（${spots.length} 棵全在林线以下）`);
}

function main(): void {
  testClumped();
  testTreeline();
  testBaseAccess();
  testReproducible();
  testSyntheticRidge();
  console.log("forest-check ok (v0.25 阶段4 成片森林：成簇 / 林线与坡度 / 基地砍得到 / 不砸地基 / 可复现)");
}

main();
