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
// @ts-expect-error node:fs 只在 tsx 检查脚本里用（不进浏览器 bundle），项目无 @types/node
import { readFileSync } from "node:fs";
import { Sim } from "./sim";
import { BLUE, chargePopMult } from "./types";
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
  const sw = sim.chargeState(BLUE, "swamp");
  sim.fillCharges(BLUE);
  sim.spendCharge(BLUE, "swamp", 1);
  l.cur = 0;
  l.fill = 0;
  // 充 12 秒（基础速度）：闪电回 1 颗；沼泽（recharge 18s）只走了 12/18 进度，仍差 1 颗
  sim.regenCharges(12);
  assert(l.cur === 1, `闪电 12s 回 1 颗（got ${l.cur}）`);
  assert(sw.cur === sw.max - 1, `沼泽 12s 不足以回满一颗（got ${sw.cur}/${sw.max}）`);
  sim.regenCharges(6);
  assert(sw.cur === sw.max, `沼泽 18s 后回满（got ${sw.cur}/${sw.max}）`);
  console.log("  ✓ 多槽独立：闪电 12s/颗 与沼泽 18s/颗 互不干扰");
}

/**
 * v0.26b UI 回归：每个技能按钮必须带充能徽标与进度条元素。
 * 起因：v0.26-1 的补丁脚本把正则结果写错变量，7 个旧按钮（提升/降低/闪电/地震/
 * 沼泽/火山/龙卷风）的徽标从未写进 index.html——后端扣颗正常但玩家看不到颗数，
 * 误以为"充能机制没生效"。
 */
function testUiChargeBadges(): void {
  const html = readFileSync(new URL("../../index.html", import.meta.url), "utf8");
  const btns = html.match(/<button[^>]*data-tool="[a-z]+"[^>]*>.*?<\/button>/g) ?? [];
  assert(btns.length === 11, `神迹按钮应 11 个（got ${btns.length}）`);
  for (const b of btns) {
    const tool = /data-tool="([a-z]+)"/.exec(b)![1]!;
    assert(b.includes('class="charge"'), `按钮 ${tool} 缺充能颗数徽标`);
    assert(b.includes('class="charge-fill"'), `按钮 ${tool} 缺充能进度条`);
  }
  console.log("  ✓ UI：11 个技能按钮全部带颗数徽标 + 充能进度条");
}

/** v0.26d 开局平衡：除转化 1 颗外全部 0 颗；雕刻工具保持满能量。 */
function testInitialZero(): void {
  const sim = new Sim(new World(42));
  const zero = ["lightning", "blast", "fireball", "swamp", "quake", "volcano", "tornado", "armageddon"] as const;
  for (const tool of zero) {
    assert(sim.chargeState(BLUE, tool).cur === 0, `${tool} 开局应为 0 颗`);
  }
  assert(sim.chargeState(BLUE, "convert").cur === 1, "转化开局保留 1 颗（用户拍板的唯一例外）");
  assert(sim.chargeState(BLUE, "raise").cur === 30, "雕刻是地形工具，开局满能量 30");
  console.log("  ✓ 开局：8 个法术 0 颗，转化 1 颗，雕刻满能量");
}

/** v0.26d 人口档位：<50 ×1.0；≥50 ×1.3；≥100 ×1.6；≥150 ×1.9；≥200 ×2.3；≥250 每 +50 再 +0.5。 */
function testPopChargeMult(): void {
  assert(chargePopMult(10) === 1, "10 人 ×1.0");
  assert(chargePopMult(50) === 1.3, "50 人 ×1.3");
  assert(chargePopMult(99) === 1.3, "99 人仍 ×1.3");
  assert(chargePopMult(100) === 1.6, "100 人 ×1.6");
  assert(chargePopMult(150) === 1.9, "150 人 ×1.9");
  assert(chargePopMult(200) === 2.3, "200 人 ×2.3");
  assert(chargePopMult(250) === 2.8, "250 人 ×2.8（之后每 +50 再 +0.5）");
  console.log("  ✓ 人口档位：×1/1.3/1.6/1.9/2.3/2.8 于 50 人一档");
}

/** v0.26d 大招节奏：少人时火山 240s 一颗；人口 100（×1.6）时 150s 一颗。 */
function testUltRechargeSlow(): void {
  const sim = new Sim(new World(42));
  const pop0 = sim.countPop(BLUE);
  assert(pop0 < 50, `测试前提：开局人口 <50（got ${pop0}）`);
  const v = sim.chargeState(BLUE, "volcano");
  sim.regenCharges(239);
  assert(v.cur === 0, `239s（基础速度）火山仍 0 颗（got ${v.cur}）`);
  sim.regenCharges(1);
  assert(v.cur === 1, "240s 恰好回满第 1 颗（4 分钟口径）");
  // 人口拉到 ≥100（独立 Sim，避免前半段 240s 已把 tornado 充满）：tornado（200s 档）应 125s 回一颗
  const sim2 = new Sim(new World(42));
  const spot = sim2.world.startPad(BLUE);
  for (let i = 0; i < 100; i++) sim2.addUnit(BLUE, "walker", spot.x, spot.z);
  assert(sim2.countPop(BLUE) >= 100, `测试前提：人口 ≥100（got ${sim2.countPop(BLUE)}）`);
  const t = sim2.chargeState(BLUE, "tornado");
  sim2.regenCharges(124);
  assert(t.cur === 0, `124s（×1.6）龙卷风仍 0 颗（got ${t.cur}）`);
  sim2.regenCharges(1);
  assert(t.cur === 1, "125s（200/1.6）恰好回满第 1 颗——人口显著提速");
  console.log("  ✓ 大招节奏：火山 240s/颗（人少）；龙卷风在 100 人时 125s/颗");
}

function main(): void {
  console.log("v0.26 充能槽机制检查");
  testDiscreteCharge();
  testSpendAtomic();
  testContinuousCharge();
  testSlotsIndependent();
  testUiChargeBadges();
  testInitialZero();
  testPopChargeMult();
  testUltRechargeSlow();
  console.log("PASS: 离散/连续槽、原子扣费、多槽独立、封顶");
}

main();
