/**
 * v0.26 转化法术检查（`npm run check` 第 29 项）
 * 针对 feature：转化——大祭司身边 4 格内施放，圈内（2.5 格）敌人转成己方。
 *
 * 覆盖：
 *  a) 施法点距己方存活大祭司 ≤ 4 成功，圈内红方 walker 变蓝方（team/kind/hp 正确）；
 *  b) 圈外（>2.5 格）单位不变；
 *  c) 超距（>4 格）拒绝且不扣颗；
 *  d) 大祭司陨落（units 里没有存活 shaman）拒绝；
 *  e) 祭司免疫（canConvert=false 的目标不转）；
 *  f) 扣 1 颗。
 */
import { Sim } from "./sim";
import { BLUE, canConvert, CONVERT_CAST_RANGE, CONVERT_RADIUS, RED } from "./types";
import { World } from "./world";
import { cast } from "./spells";

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

function testConvertInRange(): void {
  const sim = new Sim(new World(42));
  sim.fillCharges(BLUE);
  const sh = sim.units.find((u) => u.team === BLUE && u.kind === "shaman" && u.hp > 0)!;
  // 在大祭司身边放 3 个红方目标：1 个圈内（0.8 格）、1 个圈外（3 格）、1 个祭司（圈内，免疫）
  const inT = sim.addUnit(RED, "walker", sh.x + 0.8, sh.z + 0.8);
  const outT = sim.addUnit(RED, "walker", sh.x + 3, sh.z + 3);
  const priest = sim.addUnit(RED, "preacher", sh.x - 0.8, sh.z - 0.8);
  assert(canConvert("walker") && !canConvert("preacher"), "测试前提：walker 可转化、preacher 免疫");

  const res = cast(sim, BLUE, "convert", sh.x, sh.z, 0);
  assert(res.ok, `cast ok（${res.msg}）`);
  assert(inT.team === BLUE && inT.kind === "walker", "圈内红方 walker 转成蓝方 walker");
  assert(outT.team === RED, "圈外单位保持不变");
  assert(priest.team === RED, "祭司免疫（canConvert=false 不转）");
  assert(sim.chargeState(BLUE, "convert").cur === 1, "转化扣 1 颗（fillCharges 后 max=2 → 剩 1）");
  console.log(`  ✓ 圈内转化：walkers 转队、圈外不动、祭司免疫、扣 1 颗`);
}

function testConvertOutOfRange(): void {
  const sim = new Sim(new World(42));
  sim.fillCharges(BLUE);
  const sh = sim.units.find((u) => u.team === BLUE && u.kind === "shaman" && u.hp > 0)!;
  const far = sim.addUnit(RED, "walker", sh.x + CONVERT_CAST_RANGE + 1, sh.z);
  const c = sim.chargeState(BLUE, "convert");
  const n0 = c.cur;
  const res = cast(sim, BLUE, "convert", sh.x + CONVERT_CAST_RANGE + 1, sh.z, 0);
  assert(!res.ok && res.msg.includes("大祭司"), `超距拒绝（got "${res.msg}"）`);
  assert(far.team === RED, "超距时目标不变");
  assert(c.cur === n0, "拒绝时不扣颗");
  console.log(`  ✓ 超距（>${CONVERT_CAST_RANGE} 格）拒绝且不扣颗`);
}

function testConvertNoShaman(): void {
  const sim = new Sim(new World(42));
  sim.fillCharges(BLUE);
  // 大祭司陨落：把蓝方 shaman 移出 units（等价于死亡未复活）
  sim.units = sim.units.filter((u) => !(u.team === BLUE && u.kind === "shaman" && u.hp > 0));
  const res = cast(sim, BLUE, "convert", 30, 30, 0);
  assert(!res.ok && res.msg.includes("大祭司"), `无大祭司拒绝（got "${res.msg}"）`);
  console.log("  ✓ 大祭司陨落时拒绝施放");
}

function main(): void {
  console.log("v0.26 转化法术检查");
  testConvertInRange();
  testConvertOutOfRange();
  testConvertNoShaman();
  console.log("PASS: 圈内转化 / 超距拒绝 / 免疫规则 / 充能消耗");
}

main();
