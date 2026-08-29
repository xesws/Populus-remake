// sculpt-check.ts — v0.18 升降雕刻测试（法力消耗 + 半径 3.0 大范围）
// 覆盖：
//  a) 消耗链路：cast → spend 必须真扣费（蓝方 mana=50 按住 1 秒 → mana 减少，
//     且地形确实抬升）；mana=0.03（低于最小计价 0.04）时 cast 拒绝施法
//     （ok:false、msg 含"法力"）且世界高度完全不变。
//  b) 生效范围：半径 3.0 —— 距中心 2.0 格内抬升明显（smoothstep falloff 衰减），
//     5.0 格（超出 3.0 半径）高度纹丝不动。
import { Sim } from "./sim";
import { BLUE } from "./types";
import { World } from "./world";
import { cast } from "./spells";

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

// 与 game.ts 的按住雕刻同链路：每帧 cast(tool, x, z, dt=0.05)，累计 1 秒
function castOneSecond(sim: Sim, tool: "raise" | "lower", x: number, z: number): void {
  for (let i = 0; i < 20; i++) cast(sim, BLUE, tool, x, z, 0.05);
}

// a) 费用：cast→spendCharge 链路必须真扣雕刻能量；能量不足时拒绝施法且不动地形
function testManaCost(): void {
  const sim = new Sim(new World(42));
  const w = sim.world;
  sim.fillCharges(BLUE);

  // 选蓝方出生平台中心：平地、高度约 1.3，抬 1 秒不会撞 8 格上限
  const s = w.startPad(BLUE);
  const x = s.x;
  const z = s.z;
  const h0 = w.heightAt(x, z);
  const e0 = sim.chargeState(BLUE, "raise").cur;

  castOneSecond(sim, "raise", x, z);

  assert(sim.chargeState(BLUE, "raise").cur < e0, `cast 1 秒后雕刻能量必须减少（剩 ${sim.chargeState(BLUE, "raise").cur.toFixed(3)}）`);
  assert(w.heightAt(x, z) > h0, "扣费成功的同时地形确实抬升（spendCharge 在 sculpt 之前）");

  // 能量压到 0.01：低于最小计价 0.04，spendCharge 必拒，且不得触碰地形
  const c = sim.chargeState(BLUE, "raise");
  c.cur = 0.01;
  const h1 = w.heightAt(x, z);
  const r = cast(sim, BLUE, "raise", x, z, 0.05);
  assert(!r.ok, "能量=0.01 时 cast 必须返回 ok:false");
  assert(r.msg.includes("法力"), `拒绝信息须含『法力』（got "${r.msg}"）`);
  assert(w.heightAt(x, z) === h1, "拒绝施法时世界高度不变（未雕刻）");

  console.log("testManaCost ok");
}

// b) 范围：半径 3.0 —— 2.0 格内明显抬升、5.0 格外纹丝不动
function testSculptRadius(): void {
  const sim = new Sim(new World(42));
  const w = sim.world;
  sim.fillCharges(BLUE);

  // 世界中心附近整平一块 12×12 场地（目标高 1.0），排除程序地形的起伏干扰
  const cx = 26;
  const cz = 26;
  w.flattenPad(cx, cz, 12, 12, 0, 1.0);

  const hCenter0 = w.heightAt(cx, cz);
  const hNear0 = w.heightAt(cx + 2.0, cz);
  const hFar0 = w.heightAt(cx + 5.0, cz);
  assert(Math.abs(hCenter0 - 1.0) < 1e-6, "场地中心已是平地 1.0");

  castOneSecond(sim, "raise", cx, cz);

  assert(
    w.heightAt(cx, cz) - hCenter0 > 0.5,
    `中心 1 秒累计抬升 >0.5（got ${(w.heightAt(cx, cz) - hCenter0).toFixed(3)}，期望约 1.1）`,
  );
  assert(
    w.heightAt(cx + 2.0, cz) - hNear0 > 0.05,
    `距中心 2.0 格内抬升 >0.05（got ${(w.heightAt(cx + 2.0, cz) - hNear0).toFixed(3)}，falloff 边缘内）`,
  );
  assert(
    Math.abs(w.heightAt(cx + 5.0, cz) - hFar0) < 1e-6,
    "距中心 5.0 格外高度完全不变（3.0 半径够不到）",
  );

  console.log("testSculptRadius ok");
}

function main(): void {
  testManaCost();
  testSculptRadius();
  console.log("sculpt-check ok (v0.18 升降雕刻：法力消耗链路 + 半径 3.0 大范围)");
}

main();
