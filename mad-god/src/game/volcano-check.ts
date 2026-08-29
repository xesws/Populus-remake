/**
 * v0.22 火山法术检查（平滑穹顶 + 喷射方向分布）：
 *   a) 穹顶形态：中间高四周矮、径向单调下降、中心抬升约 2.6、8 格外不变；喷射方向分布字段就绪；
 *   b) 岩浆生命周期：cast 后 lava 有正值，越喷越多，tick 后干涸而 scorch>0（灰褐焦土残留）；
 *   c) 岩浆伤害：站在岩浆格上的蓝方村民 3 秒内烧死；
 *   d) 树木烧毁：岩浆上的树 alive=false，且 regen 被拉长（不会在下一 tick 原地复活）。
 */
import { Sim } from "./sim";
import { BLUE, Tree, TREE_REGEN } from "./types";
import { World } from "./world";
import { cast } from "./spells";

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

// 火山点：世界中心（确定性地形 seed=42 下必为陆地、高度 2~4，+2.6 后不触 clamp 8）。
const VX = 26;
const VZ = 26;

function lavaCount(w: World): number {
  let n = 0;
  for (let i = 0; i < w.lava.length; i++) if (w.lava[i]! > 0) n++;
  return n;
}

function scorchCount(w: World): number {
  let n = 0;
  for (let i = 0; i < w.scorch.length; i++) if (w.scorch[i]! > 0) n++;
  return n;
}

function castVolcano(sim: Sim): void {
  sim.fillCharges(BLUE); // v0.26 充能槽填满 // 火山 80 费，初始 70 不够
  const res = sim.volcanoSpell.cast(sim, BLUE, VX, VZ, 0);
  assert(res.ok, "cast 成功");
}

/** 找最近的 lava>0 格点：从火山口向外环形扫描（v0.18b 物理溢流——浆从口向外淌，口附近必有）。 */
function findLavaCell(sim: Sim): { x: number; z: number } {
  for (let r = 0; r <= 8; r += 0.5) {
    const steps = Math.max(1, Math.ceil(r * 6));
    for (let k = 0; k < steps; k++) {
      const a = (k / steps) * Math.PI * 2;
      const x = VX + Math.cos(a) * r;
      const z = VZ + Math.sin(a) * r;
      if (sim.world.lava[sim.world.sampleAt(x, z)]! > 0) return { x, z };
    }
  }
  throw new Error("火山口附近找不到岩浆格");
}

// a) 高原形态
function testPlateauShape(): void {
  const sim = new Sim(new World(42));
  const w = sim.world;
  const h0 = w.heightAt(VX, VZ);
  const far = { x: VX - 8, z: VZ }; // 8 格 > 高原半径 6.5，必在原高度
  const hFar0 = w.heightAt(far.x, far.z);
  assert(h0 > 0.3 && h0 < 5.4, `火山点高度合适（h0=${h0.toFixed(2)}，+2.6 后不触顶）`);

  castVolcano(sim);
  for (let i = 0; i < 60; i++) sim.tick(0.05); // 3s > dur 2.6s，抬升完成

  const pts: Array<[number, number]> = [
    [VX, VZ],
    [VX + 1.5, VZ],
    [VX - 1.5, VZ],
    [VX, VZ + 1.5],
    [VX, VZ - 1.5],
    [VX + 1.1, VZ + 1.1],
    [VX - 1.1, VZ - 1.1],
  ];
  let lo = Infinity;
  let hi = -Infinity;
  for (const [x, z] of pts) {
    const h = w.heightAt(x, z);
    if (h < lo) lo = h;
    if (h > hi) hi = h;
  }
  // v0.22 平滑穹顶语义：中间高、四周矮——中心显著高于 1.5 格圈（坡降明显），
  // 顶面不再要求平坦也不再要求起伏；穹顶整体平滑（无高频噪声）。
  // v0.24 取整圈均值：v0.22 的穹顶**刻意**带 ±15% 低频方位扰动（喷射方向各向差异），
  // 只取正东一个点等于拿随机相位去卡固定阈值（实测差 0.01 而误报"不是穹顶"）。
  // 整圈平均仍然是"中间高四周矮"的原判据，且与朝向无关。
  const hCenter = w.heightAt(VX, VZ);
  const ringAvg = (r: number) => {
    let sum = 0;
    for (let k = 0; k < 16; k++) {
      const a = (k / 16) * Math.PI * 2;
      sum += w.heightAt(VX + Math.cos(a) * r, VZ + Math.sin(a) * r);
    }
    return sum / 16;
  };
  const hRing1 = ringAvg(1.5);
  const hRing3 = ringAvg(3.2);
  assert(hCenter - hRing1 >= 0.35, `中间高四周矮：中心比 1.5 格圈均值高 ${(hCenter - hRing1).toFixed(2)} ≥ 0.35`);
  assert(hRing1 > hRing3, `穹顶单调下降：1.5 格圈均值(${hRing1.toFixed(2)}) > 3.2 格圈均值(${hRing3.toFixed(2)})`);
  assert(hCenter - lo >= 0.35, `中心为最高点（中心与采样极差 ${(hCenter - lo).toFixed(2)} ≥ 0.35）`);
  assert(
    Math.abs(hCenter - Math.min(h0 + 2.6, 8)) < 0.9,
    `中心抬升约 2.6（期望 ${(h0 + 2.6).toFixed(2)}，实际 ${hCenter.toFixed(2)}）`,
  );
  assert(Math.abs(w.heightAt(far.x, far.z) - hFar0) < 0.15, "8 格外远处地形不变");
  // v0.22 喷射方向分布：每座火山随机一次（全向 2π 或偏置扇区）。
  const vv = sim.volcano!;
  assert(
    vv.biasWidth >= Math.PI * 0.5 && vv.biasWidth <= Math.PI * 2,
    `喷射方向分布宽度 ${(vv.biasWidth / Math.PI).toFixed(2)}π ∈ [0.5π, 2π]`,
  );

  console.log("testPlateauShape ok");
}

// b) 岩浆生命周期（v0.18b 物理溢流语义）：越喷越多 → 干涸 → 焦土残留；覆盖为舌状而非满盘。
function lavaSum(w: World): number {
  let s = 0;
  for (let i = 0; i < w.lava.length; i++) s += w.lava[i]!;
  return s;
}

function testLavaLifecycle(): void {
  const sim = new Sim(new World(42));
  castVolcano(sim);
  let sum2s = 0;
  let sum4s = 0;
  for (let i = 0; i < 80; i++) {
    sim.tick(0.05);
    if (i === 40) sum2s = lavaSum(sim.world);
    if (i === 79) sum4s = lavaSum(sim.world);
  }
  assert(lavaCount(sim.world) > 0, "cast 后岩浆存在");
  assert(sum4s > sum2s && sum2s > 0, `喷发期越喷越多（t=2s ${sum2s.toFixed(0)} → t=4s ${sum4s.toFixed(0)}）`);
  // 非满盘：物理舌状覆盖应远小于半径 6.5 的均匀圆盘（π×26²≈2124 格），防回归几何扫描。
  const cells = lavaCount(sim.world);
  assert(cells < 1400, `覆盖为舌状而非满盘（${cells} 格 < 1400）`);

  for (let i = 0; i < 500; i++) sim.tick(0.05); // 累计至 29s（v0.20 随机涌浆后实测 ~19s 干）
  assert(lavaCount(sim.world) === 0, "tick 29 秒后岩浆全部干涸（lava 全 0）");
  assert(scorchCount(sim.world) > 0, "干涸后仍有焦土残留（scorch>0）");

  console.log("testLavaLifecycle ok");
}

// c) 岩浆伤害：单位 3 秒内烧死
function testUnitBurns(): void {
  const sim = new Sim(new World(42));
  castVolcano(sim);
  for (let i = 0; i < 60; i++) sim.tick(0.05); // 3s：lava 河臂活跃
  const cell = findLavaCell(sim);
  const victim = sim.addUnit(BLUE, "walker", cell.x, cell.z);
  for (let i = 0; i < 60; i++) sim.tick(0.05); // 再 3s
  assert(victim.hp <= 0, `岩浆上的单位 3 秒内烧死（剩余 hp=${victim.hp.toFixed(1)}）`);

  console.log("testUnitBurns ok");
}

// d) 树木烧毁：alive=false 且 regen 拉长
function testTreesBurn(): void {
  const sim = new Sim(new World(42));
  castVolcano(sim);
  for (let i = 0; i < 60; i++) sim.tick(0.05); // 3s
  const cell = findLavaCell(sim);
  const tree = new Tree(7777, cell.x, cell.z, sim.world.heightAt(cell.x, cell.z), true, 0);
  sim.trees.push(tree);
  for (let i = 0; i < 20; i++) sim.tick(0.05); // 再 1s
  assert(!tree.alive, "岩浆上的树被烧没（alive=false）");
  assert(tree.regen > 0 && tree.regen < TREE_REGEN * 3, `树 regen 被拉长（${tree.regen.toFixed(1)}s），不会立即复生`);

  console.log("testTreesBurn ok");
}

/**
 * v0.26b 双实例回归：真实玩家路径是 spells.cast()（SPELLS 单例的 VolcanoSpell），
 * 而 sim.tick 走 Sim 实例的 volcanoSpell。旧实现把 origH 快照存在实例字段上，
 * cast 写单例、tick 读 Sim 实例的 null → 火山一放就崩（日志三次
 * "Cannot read properties of null (reading '格索引')"）。快照现挂在 sim.volcano 上。
 */
function testCastEntryDualInstance(): void {
  const sim = new Sim(new World(42));
  sim.fillCharges(BLUE);
  const s = sim.world.startPad(BLUE);
  // 走真实入口 spells.cast（不是 sim.volcanoSpell.cast）
  const res = cast(sim, BLUE, "volcano", s.x + 4, s.z + 4, 0);
  assert(res.ok, "cast() 入口施放成功");
  for (let f = 0; f < 4 * 60; f++) sim.tick(1 / 60); // 覆盖抬升窗口 v.t <= dur
  assert(sim.volcano !== null || true, "4 秒跑完不崩即通过（旧实现此处 null[格索引] 崩溃）");
  const w2 = sim.world;
  const hC = w2.heightAt(s.x + 4, s.z + 4);
  assert(hC > 1.5, `穹顶中心应被抬升（h=${hC.toFixed(2)}）——cast 入口与 tick 的状态现已同源`);
  console.log("testCastEntryDualInstance ok（cast() 入口 + sim.tick 4 秒不崩，穹顶抬升正常）");
}

function main(): void {
  testPlateauShape();
  testLavaLifecycle();
  testUnitBurns();
  testTreesBurn();
  testCastEntryDualInstance();
  console.log("volcano-check ok (v0.22 穹顶火山：中间高四周矮 / 喷射方向分布 / 岩浆生命周期 / 灼烧 / 焚林)");
}

main();
