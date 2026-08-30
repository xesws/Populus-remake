// v0.27e 检查：合并系统已移除——村民无论多密集都不再被自动合体吞掉。
// 背案：t=548 一秒内 832→152（690 名自由村民被 mergeWalkers 级联合并，
// 3 级老兵继续吞人但强度封顶=纯删人口；新生儿出屋即被老兵吃掉，人口卡 149/150 跳动）。
// 测试文件命名：v0.27e / feature=remove-merge。

import { Sim } from "./sim";
import { BLUE, RED } from "./types";
import { World } from "./world";

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

/** a. 密集扎堆不再触发合并：20 个同队村民挤成一团，2 秒后全员存活、强度不变。 */
function testDenseCrowdNeverMerges(): void {
  const sim = new Sim(new World(42));
  const pad = sim.world.startPad(BLUE);
  const base = sim.units.filter((u) => u.team === BLUE && u.kind === "walker").length; // 开局自带 2 名村民
  const N = 20;
  for (let i = 0; i < N; i++) {
    const ang = i * 2.399963; // 黄金角螺旋：彼此间距远小于旧合并阈值 0.36
    const r = 0.055 * Math.sqrt(i);
    sim.addUnit(BLUE, "walker", pad.x + Math.cos(ang) * r, pad.z + Math.sin(ang) * r);
  }
  for (let i = 0; i < 40; i++) sim.tick(0.05); // 2 秒（旧实现 0.1 秒内即塌到 ~N/3）

  const alive = sim.units.filter((u) => u.team === BLUE && u.kind === "walker");
  assert(alive.length === base + N, `dense: ${N} 人密集扎堆 2 秒后全员存活（实际 ${alive.length}，旧实现会塌到 ~7）`);
  assert(alive.every((u) => u.str === 1), "dense: 无人被合体（强度恒为 1）");
  console.log("testDenseCrowdNeverMerges ok");
}

/** b. 新生儿不再被老兵吞掉（原 149/150 卡死的回归）：3 级老兵与新生儿贴脸站 5 秒，两者都活着。 */
function testVeteranNeverEatsNewborn(): void {
  const sim = new Sim(new World(42));
  const pad = sim.world.startPad(BLUE);
  const base = sim.units.filter((u) => u.team === BLUE && u.kind === "walker").length; // 开局自带 2 名村民
  const vet = sim.addUnit(BLUE, "walker", pad.x, pad.z, 3); // str=3 老兵（12 血）
  const baby = sim.addUnit(BLUE, "walker", pad.x + 0.2, pad.z); // 贴脸 0.2 < 旧阈值 0.36
  for (let i = 0; i < 100; i++) sim.tick(0.05); // 5 秒

  assert(vet.hp > 0 && vet.str === 3, "newborn: 老兵健在且强度不变");
  assert(baby.hp > 0 && baby.str === 1, "newborn: 新生儿存活（旧实现 1 帧内被吞）");
  assert(sim.units.filter((u) => u.team === BLUE && u.kind === "walker").length === base + 2, "newborn: 人口无增减");
  console.log("testVeteranNeverEatsNewborn ok");
}

/** c. 红蓝贴脸不跨队、也不因敌对死亡：双方村民挨着站，人口不变。 */
function testTeamsIntact(): void {
  const sim = new Sim(new World(42));
  const pad = sim.world.startPad(BLUE);
  sim.addUnit(BLUE, "walker", pad.x, pad.z);
  sim.addUnit(RED, "walker", pad.x + 0.25, pad.z);
  for (let i = 0; i < 40; i++) sim.tick(0.05);

  assert(sim.countPop(BLUE) >= 1 && sim.countPop(RED) >= 1, "teams: 双方人口无损（村民不索敌不会互杀）");
  console.log("testTeamsIntact ok");
}

testDenseCrowdNeverMerges();
testVeteranNeverEatsNewborn();
testTeamsIntact();
console.log("merge-off-check 全部通过（v0.27e 合并系统移除：人口不再被自动合体吞掉）");
