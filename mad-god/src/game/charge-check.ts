/**
 * v0.26 充能槽机制检查（`npm run check` 第 27 项）
 * 针对 feature：总法力槽 → 各技能独立充能（提莫蘑菇式）。
 *
 * 覆盖：
 *  a) 离散槽：用掉 1 颗后 fill 从 0 起充，满 recharge 秒 +1 颗，封顶 max；
 *  b) 不足拒绝且不扣（spendCharge 原子性）；
 *  c) fillCharges 填满所有槽；
 *  d) 连续槽（雕刻 raise/lower）：按帧扣能量、12s 回满整槽、封顶 max；
 *  e) 多槽独立：火山的槽消耗/充能不影响闪电的槽；
 *  f) 回满的颗数在满槽后不再累积（封顶）。
 */
import { Sim } from "./sim";
import { BLUE } from "./types";
import { World } from "./world";

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

function testDiscreteCharge(): void {
  const sim = new Sim(new World(42));
  const c = sim.chargeState(BLUE, "lightning");
  assert(c.max === 5 && c.recharge === 12, `闪电槽参数：max=5 recharge=12（got ${c.max}/${c.recharge}）`);
  sim.fillCharges(BLUE);
  assert(c.cur === c.max, "fillCharges 应填满闪电槽");
  // 用掉 1 颗：cur-1、fill 归零开始充
  assert(sim.spendCharge(BLUE, "lightning"), "满槽时 spendCharge 成功");
  assert(c.cur === c.max - 1 && c.fill === 0, "用掉后 fill 从 0 起充");
  // 充 12 秒 → 回 1 颗；再 12 秒 → 又 1 颗
  sim.regenCharges(12);
  assert(c.cur === c.max, `12 秒后应回满到 max（got ${c.cur}）`);
  // 满槽继续充：不再累积
  sim.regenCharges(60);
  assert(c.cur === c.max, "满槽后充能不再累积（封顶）");
  console.log("  ✓ 离散槽：用颗→fill 起充→recharge 秒回一颗→封顶不累积");
}

function testSpendAtomic(): void {
  const sim = new Sim(new World(42));
  const c = sim.chargeState(BLUE, "volcano");
  c.cur = 0.5; // 模拟半颗状态
  const r = sim.spendCharge(BLUE, "volcano", 1);
  assert(!r && c.cur === 0.5, "不足 1 颗时拒绝且不扣（原子性）");
  sim.fillCharges(BLUE);
  assert(sim.hasCharge(BLUE, "volcano"), "fillCharges 后 hasCharge 为真");
  console.log("  ✓ spendCharge 原子性：不足拒绝、不产生部分扣费");
}

function testContinuousCharge(): void {
  const sim = new Sim(new World(42));
  const c = sim.chargeState(BLUE, "raise");
  assert(c.continuous === true && c.max === 30 && c.recharge === 12, "雕刻槽为连续槽 30 点 12s");
  // 按住 1 秒（raise 每秒 12 点）
  assert(sim.spendCharge(BLUE, "raise", 12), "能量 30 扣 12 成功");
  assert(Math.abs(c.cur - 18) < 1e-6, `扣 12 点后剩 18（got ${c.cur}）`);
  // 12 秒回满
  sim.regenCharges(12);
  assert(Math.abs(c.cur - 30) < 1e-6, `12s 应回满 30（got ${c.cur}）`);
  // 回满封顶
  sim.regenCharges(120);
  assert(c.cur === 30, "连续槽满后封顶");
  console.log("  ✓ 连续槽：按点扣、12s 回满、封顶");
}

function testSlotsIndependent(): void {
  const sim = new Sim(new World(42));
  const l = sim.chargeState(BLUE, "lightning");
  const v = sim.chargeState(BLUE, "volcano");
  sim.fillCharges(BLUE);
  sim.spendCharge(BLUE, "volcano", 1);
  l.cur = 0;
  l.fill = 0;
  // 充 12 秒：闪电回 1 颗；火山（recharge 45）只走了 12/45 进度，仍差 1 颗
  sim.regenCharges(12);
  assert(l.cur === 1, `闪电 12s 回 1 颗（got ${l.cur}）`);
  assert(v.cur === v.max - 1, `火山 12s 不足以回满一颗（got ${v.cur}/${v.max}）`);
  sim.regenCharges(33);
  assert(v.cur === v.max, `火山 45s 后回满（got ${v.cur}/${v.max}）`);
  console.log("  ✓ 多槽独立：闪电 12s/颗 与火山 45s/颗 互不干扰");
}

function main(): void {
  console.log("v0.26 充能槽机制检查");
  testDiscreteCharge();
  testSpendAtomic();
  testContinuousCharge();
  testSlotsIndependent();
  console.log("PASS: 离散/连续槽、原子扣费、多槽独立、封顶");
}

main();
