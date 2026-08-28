import { Sim } from "./sim";
import { BLUE, SAMPLES, STEP, WATER } from "./types";
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

function testSculptNoLip(): void {
  const w = new World(42);
  w.sculpt(30, 30, 2.0, 2.0);
  // 笔刷边界带（半径 1.8~2.3）坡度：旧版 t² falloff 留唇沿 >1.2，smoothstep 后应平缓。
  const lip = maxSlopeInRing(w, 30, 30, 1.8, 2.3);
  assert(lip < 0.8, `sculpt 边缘无唇沿（lip=${lip.toFixed(2)}）`);
  console.log("testSculptNoLip ok");
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

function testMovementSpeedFloor(): void {
  const sim = new Sim(new World(42));
  // 造一个覆盖路径全程的缓坡（坡度 ≈1.1）：旧版速度被压到 ≈0.59，v0.13 ≈0.94。
  sim.world.sculpt(30, 30, 2.0, 1.5);
  const u = sim.addUnit(BLUE, "walker", 30.4, 30);
  u.job = "move";
  u.path = [{ x: 31.8, z: 30 }]; // 1.4m，1 秒内走不完，保证全程在坡上
  u.pathI = 0;
  const x0 = u.x;
  for (let i = 0; i < 20; i++) sim.tick(0.05);
  const moved = u.x - x0;
  assert(moved >= 0.75, `陡坡上移动速度保持流畅（1s 位移 ${moved.toFixed(2)} ≥ 0.75）`);
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
