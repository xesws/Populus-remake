// v0.16 传教士感化测试（feature：preach 接线——一段写了从未被调用的死代码，本版接入战斗主循环）。
// 覆盖：贴脸野人 1.35 秒被感化 / 超出 1.25 格不感化不追击 / 玩家移动指令优先 /
// 敌方传教士对称感化 / 祭司免疫 / 全链路 sim.tick 集成。
// 纯 node 可跑，不依赖浏览器。

import { Sim } from "./sim";
import { BLUE, NEUTRAL, PREACH_TIME, PREACH_REACH, RED } from "./types";
import { World } from "./world";

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

/** 找一块 3 格内没有任何单位的空地（固定种子地图上有野人游荡，测试选址须避开抢客）。 */
function findClear(sim: Sim, x: number, z: number): { x: number; z: number } {
  for (let r = 0; r < 8; r++) {
    for (let a = 0; a < 8; a++) {
      const cx = x + Math.cos((a / 8) * Math.PI * 2) * r * 1.5;
      const cz = z + Math.sin((a / 8) * Math.PI * 2) * r * 1.5;
      if (!sim.world.walkableAt(cx, cz)) continue;
      if (sim.units.every((o) => (o.x - cx) ** 2 + (o.z - cz) ** 2 > 9)) return { x: cx, z: cz };
    }
  }
  return { x, z };
}

/** 单元式驱动：不跑全 sim.tick，野人不动，隔离测感化本身。 */
function drive(sim: Sim, preacher: ReturnType<Sim["addUnit"]>, frames: number): void {
  for (let i = 0; i < frames; i++) sim.combatSystem.autoPreach(sim, preacher, 0.05);
}

function testPreachConvertsWildman(): void {
  const sim = new Sim(new World(42));
  const at = findClear(sim, 20, 20);
  const p = sim.addUnit(BLUE, "preacher", at.x, at.z);
  const wild = sim.addUnit(NEUTRAL, "wildman", at.x + 0.6, at.z);
  const pop0 = sim.countPop(BLUE);

  drive(sim, p, 10);
  assert(wild.team === NEUTRAL, "1.35 秒引导未满不转化（0.5 秒）");
  drive(sim, p, 30); // 累计 2.0 秒 > PREACH_TIME
  assert(wild.team === BLUE, "野人被感化为蓝方");
  assert(wild.kind === "walker", "被感化后成为村民");
  assert(wild.homeId === 0, "被感化村民是自由单位（可被选中）");
  assert(sim.countPop(BLUE) === pop0 + 1, "感化计入人口");

  console.log("testPreachConvertsWildman ok");
}

function testPreachNeedsRange(): void {
  const sim = new Sim(new World(42));
  const at = findClear(sim, 20, 20);
  const p = sim.addUnit(BLUE, "preacher", at.x, at.z);
  const wild = sim.addUnit(NEUTRAL, "wildman", at.x + PREACH_REACH + 1.5, at.z); // 射程外
  const px = p.x;
  const pz = p.z;

  drive(sim, p, 100); // 5 秒
  assert(wild.team === NEUTRAL, "射程外野人不被感化");
  assert(p.x === px && p.z === pz, "传教士站桩不追击（v0.10 待机语义）");

  console.log("testPreachNeedsRange ok");
}

function testMoveOrderBlocksPreach(): void {
  const sim = new Sim(new World(42));
  const at = findClear(sim, 20, 20);
  const p = sim.addUnit(BLUE, "preacher", at.x, at.z);
  const wild = sim.addUnit(NEUTRAL, "wildman", at.x + 0.5, at.z);
  p.job = "move"; // 玩家选中下令移动

  drive(sim, p, 100);
  assert(wild.team === NEUTRAL, "玩家移动指令优先，感化让位");

  p.job = "idle";
  drive(sim, p, Math.ceil(PREACH_TIME / 0.05) + 2);
  assert(wild.team === BLUE, "指令结束后恢复感化");

  console.log("testMoveOrderBlocksPreach ok");
}

function testEnemyPreacherConvertsVillager(): void {
  const sim = new Sim(new World(42));
  const at = findClear(sim, 26, 26);
  const p = sim.addUnit(RED, "preacher", at.x, at.z);
  const villager = sim.addUnit(BLUE, "walker", at.x + 0.5, at.z);

  drive(sim, p, Math.ceil(PREACH_TIME / 0.05) + 2);
  assert(villager.team === RED, "敌方传教士对称感化蓝方村民");

  console.log("testEnemyPreacherConvertsVillager ok");
}

function testShamanImmuneToConvert(): void {
  const sim = new Sim(new World(42));
  const at = findClear(sim, 20, 20);
  const p = sim.addUnit(BLUE, "preacher", at.x, at.z);
  const foeShaman = sim.addUnit(RED, "shaman", at.x + 0.4, at.z); // 祭司不可感化

  drive(sim, p, 100);
  assert(foeShaman.team === RED, "祭司免疫感化");
  assert(p.channel === 0, "无有效目标时不进入引导");

  console.log("testShamanImmuneToConvert ok");
}

function testPreachViaFullTick(): void {
  const sim = new Sim(new World(42));
  const at = findClear(sim, 24, 26);
  const p = sim.addUnit(BLUE, "preacher", at.x, at.z);
  const wild = sim.addUnit(NEUTRAL, "wildman", at.x + 0.4, at.z); // 贴脸，降低游荡出圈概率

  let converted = false;
  for (let i = 0; i < 200 && !converted; i++) {
    sim.tick(0.05);
    // 野人钉在传教士身旁：本用例验证"sim.tick → combat → autoPreach"全链路，
    // 野人自主游荡出 1.25 格引导圈是无关随机量（曾致 ~1/6 flake），钉位消除。
    wild.x = at.x + 0.4;
    wild.z = at.z;
    converted = wild.team === BLUE;
  }
  assert(converted, "全链路（sim.tick → combat → autoPreach）完成感化");

  console.log("testPreachViaFullTick ok");
}

testPreachConvertsWildman();
testPreachNeedsRange();
testMoveOrderBlocksPreach();
testEnemyPreacherConvertsVillager();
testShamanImmuneToConvert();
testPreachViaFullTick();
console.log("convert-check ok (v0.16 传教士感化接线)");
