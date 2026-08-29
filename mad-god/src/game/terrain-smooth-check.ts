import { Sim } from "./sim";
import { BLUE, MAX_H, SAMPLES, STEP, WATER, WORLD } from "./types";
import { World } from "./world";

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

function maxLandSlope(w: World): number {
  let m = 0;
  for (let iz = 1; iz < SAMPLES - 1; iz++) {
    for (let ix = 1; ix < SAMPLES - 1; ix++) {
      const x = ix * STEP;
      const z = iz * STEP;
      if (w.heightAt(x, z) <= WATER) continue;
      const s = w.slopeAt(x, z);
      if (s > m) m = s;
    }
  }
  return m;
}

function maxSlopeInRing(w: World, cx: number, cz: number, r0: number, r1: number): number {
  let m = 0;
  for (let iz = 1; iz < SAMPLES - 1; iz++) {
    for (let ix = 1; ix < SAMPLES - 1; ix++) {
      const x = ix * STEP;
      const z = iz * STEP;
      const d = Math.hypot(x - cx, z - cz);
      if (d < r0 || d > r1) continue;
      const s = w.slopeAt(x, z);
      if (s > m) m = s;
    }
  }
  return m;
}

// v0.13 地图丝滑度：生成/编辑不再留陡崖与唇沿，移动速度下限与寻路成本合理化。

function testGeneratedMapMaxSlope(): void {
  // 旧版基线 ≈5.7（出生平台海崖）；v0.13 滩涂 + 平台随地形后 ≈2.1。
  for (const seed of [42, 7, 99]) {
    const w = new World(seed);
    assert(maxLandSlope(w) < 2.5, `seed=${seed} 陆地最大坡度 < 2.5（实际 ${maxLandSlope(w).toFixed(2)}）`);
  }
  console.log("testGeneratedMapMaxSlope ok");
}

/**
 * 某个**差分场**在环带内的最大坡度（口径与 World.slopeAt 一致：中心差分、单位 格/格）。
 * 用来量"笔刷自己造出来的地形"，而不是脚下那块地的天然坡度。
 */
function maxSlopeOfDelta(delta: Float32Array, cx: number, cz: number, r0: number, r1: number): number {
  let m = 0;
  for (let iz = 1; iz < SAMPLES - 1; iz++) {
    for (let ix = 1; ix < SAMPLES - 1; ix++) {
      const x = ix * STEP;
      const z = iz * STEP;
      const d = Math.hypot(x - cx, z - cz);
      if (d < r0 || d > r1) continue;
      const i = iz * SAMPLES + ix;
      const dhx = (delta[i + 1]! - delta[i - 1]!) / (2 * STEP);
      const dhz = (delta[i + SAMPLES]! - delta[i - SAMPLES]!) / (2 * STEP);
      const sl = Math.hypot(dhx, dhz);
      if (sl > m) m = sl;
    }
  }
  return m;
}

function testSculptNoLip(): void {
  const w = new World(42);
  // v0.25 修正：原来量的是"雕刻后脚下这块地的绝对坡度"，可它写死了坐标 (30,30)。
  // v0.13 那版图是缓丘，(30,30) 附近自然是平地，绝对坡度≈笔刷坡度，两者混不出事；
  // v0.25 把起伏拉开以后那个点落在山坡/河边上，量到的 2.08 里绝大部分是**地图本身**的坡度，
  // 于是这条本来在测"笔刷 falloff 有没有 C1 连续"的用例，变成了测"seed 42 那座山陡不陡"。
  // 正确做法是量差分场：post − pre 只剩笔刷留下的形状，与地图长什么样彻底无关。
  const pre = w.h.slice();
  w.sculpt(30, 30, 2.0, 2.0);
  const delta = new Float32Array(pre.length);
  let touched = 0;
  for (let i = 0; i < pre.length; i++) {
    delta[i] = Math.min(MAX_H, w.h[i]!) - pre[i]!;
    if (delta[i] !== 0) touched++;
  }
  assert(touched > 100, `sculpt 确实改写了地形（${touched} 格）`);
  // 笔刷边界带（半径 1.8~2.3）差分坡度：旧版 t² falloff 留唇沿 >1.2，smoothstep 后应平缓。
  const lip = maxSlopeOfDelta(delta, 30, 30, 1.8, 2.3);
  assert(lip < 0.8, `sculpt 边缘无唇沿（差分坡度 lip=${lip.toFixed(2)}）`);
  console.log(`testSculptNoLip ok（差分唇沿坡度 ${lip.toFixed(2)}）`);
}

function testFlattenPadGentleRim(): void {
  const w = new World(42);
  // 受控场景：先铺 6×6 平台到 2.0，再在其中心铺 2.6 pad 到 3.0。
  // 环形带坡度只能来自缓坡本身——旧版无环形带（0.45 处硬台阶），坡度 ≥ 3.5；新版 ≈1.0。
  w.flattenPad(30, 30, 6, 6, 0, 2.0);
  const target = 3.0;
  w.flattenPad(30, 30, 2.6, 2.6, 0, target);
  // pad 内部保持精确平整（房屋地基要求）
  let variance = 0;
  let n = 0;
  for (let dz = -1; dz <= 1; dz++) {
    for (let dx = -1; dx <= 1; dx++) {
      const h = w.heightAt(30 + dx * STEP, 30 + dz * STEP);
      variance += (h - target) * (h - target);
      n++;
    }
  }
  assert(variance / n < 0.02, `pad 内部平整（variance=${(variance / n).toFixed(3)}）`);
  // 环形缓坡带（inflate 0.45~1.3）：面坡 ≈0.97，方形 ramp 角点二维梯度 ≈1.37；
  // 旧版无环形带 = 0.45 处硬台阶（坡度 ≥3.5），阈值 1.5 可判别。
  const rim = maxSlopeInRing(w, 30, 30, 1.9, 2.9);
  assert(rim < 1.5, `pad 环形带缓坡（rim=${rim.toFixed(2)}）`);
  console.log("testFlattenPadGentleRim ok");
}

/**
 * 找一个"东西向 2 格净空、脚下不陡、无沼泽"的实验台落点。
 * v0.25 起必须有：原来这个用例把坐标写死在 (30,30)，v0.13 那版地图那里是缓丘所以没事，
 * 现在同一张 seed 42 上那个点可能落在河里/湖边/山脊上——单位一步都走不出去，
 * 测出来的 0.00 位移看着像速度模型崩了，实际是实验台架到了水里。
 */
function findLabSpot(w: World): { x: number; z: number } {
  for (let z = 8; z < WORLD - 8; z += 0.5) {
    for (let x = 8; x < WORLD - 8; x += 0.5) {
      let ok = true;
      for (let d = -1; d <= 2.5 && ok; d += 0.25) {
        if (!w.walkableAt(x + d, z)) ok = false;
        else if (w.slopeAt(x + d, z) > 0.5) ok = false;
        else if (w.swamp[w.sampleAt(x + d, z)]! > 0) ok = false;
      }
      if (ok) return { x, z };
    }
  }
  return { x: WORLD / 2, z: WORLD / 2 };
}

function testMovementSpeedFloor(): void {
  const sim = new Sim(new World(42));
  const spot = findLabSpot(sim.world);
  const cx = spot.x;
  const cz = spot.z;
  // 造一个覆盖路径全程的缓坡（坡度 ≈1.1）：旧版速度被压到 ≈0.59，v0.13 ≈0.94。
  sim.world.sculpt(cx, cz, 2.0, 1.5);
  const u = sim.addUnit(BLUE, "walker", cx + 0.4, cz);
  u.job = "move";
  u.path = [{ x: cx + 1.8, z: cz }]; // 1.4m，1 秒内走不完，保证全程在坡上
  u.pathI = 0;
  const x0 = u.x;
  for (let i = 0; i < 20; i++) sim.tick(0.05);
  const moved = u.x - x0;
  assert(moved >= 0.75, `陡坡上移动速度保持流畅（1s 位移 ${moved.toFixed(2)} ≥ 0.75 @${cx},${cz}）`);
  console.log("testMovementSpeedFloor ok");
}

function main(): void {
  testGeneratedMapMaxSlope();
  testSculptNoLip();
  testFlattenPadGentleRim();
  testMovementSpeedFloor();
  console.log("terrain-smooth-check ok (v0.13 地图丝滑度)");
}

main();
