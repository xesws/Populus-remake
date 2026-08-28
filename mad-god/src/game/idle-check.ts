import { Sim } from "./sim";
import { BLUE, RED, Tree } from "./types";
import { World } from "./world";

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

function tickFor(sim: Sim, seconds: number, dt = 0.05): void {
  const n = Math.round(seconds / dt);
  for (let i = 0; i < n; i++) sim.tick(dt);
}

// v0.10 玩家单位待机：蓝方无指令原地站立（站立≠不还手/不索敌），指令/建工/谕令全部恢复行动，红方照旧自主。

function testBlueIdleStandStill(): void {
  const sim = new Sim(new World(42));
  sim.units = sim.units.filter((u) => u.team !== RED); // 移除红方，避免索敌干扰观察
  const warrior = sim.addUnit(BLUE, "warrior", 20, 20);
  const walker = sim.addUnit(BLUE, "walker", 24, 20);

  const w0 = { x: warrior.x, z: warrior.z };
  const k0 = { x: walker.x, z: walker.z };
  tickFor(sim, 6);

  assert(Math.hypot(warrior.x - w0.x, warrior.z - w0.z) < 0.5, "武士无指令原地站立（不再漫游）");
  assert(Math.hypot(walker.x - k0.x, walker.z - k0.z) < 0.5, "村民无指令原地站立（不再自动找活）");
  assert(warrior.path.length === 0, "站立武士无路径");
  assert(walker.path.length === 0, "站立村民无路径");

  console.log("testBlueIdleStandStill ok");
}

function testStandingStillAutoAcquires(): void {
  const sim = new Sim(new World(42));
  sim.units = sim.units.filter((u) => u.team !== RED);
  const warrior = sim.addUnit(BLUE, "warrior", 20, 20);
  tickFor(sim, 2);
  assert(warrior.path.length === 0, "先确认站立状态");

  // 敌人进入索敌半径：站立单位照样自动攻击（站立不打断战斗本能）
  const foe = sim.addUnit(RED, "walker", 21.5, 20);
  let died = false;
  for (let i = 0; i < 400; i++) {
    sim.tick(0.05);
    if (foe.hp <= 0) {
      died = true;
      break;
    }
  }
  assert(died, "站立武士对进入半径的敌人自动攻击");

  console.log("testStandingStillAutoAcquires ok");
}

function testOrderOverridesStanding(): void {
  const sim = new Sim(new World(42));
  sim.units = sim.units.filter((u) => u.team !== RED);
  const warrior = sim.addUnit(BLUE, "warrior", 20, 20);
  tickFor(sim, 2);
  assert(warrior.path.length === 0, "站立中");

  sim.sendMove(warrior, 26, 20);
  tickFor(sim, 8);
  assert(Math.hypot(warrior.x - 26, warrior.z - 20) < 0.5, "移动令立即恢复行动并到达");

  tickFor(sim, 4);
  assert(Math.hypot(warrior.x - 26, warrior.z - 20) < 0.8, "到达后恢复站立不游荡");

  console.log("testOrderOverridesStanding ok");
}

function testGatherOrderStillWorks(): void {
  const sim = new Sim(new World(42));
  sim.units = sim.units.filter((u) => u.team !== RED);
  const walker = sim.addUnit(BLUE, "walker", 20, 20);
  tickFor(sim, 1);
  assert(walker.path.length === 0, "站立中");

  walker.order = "gather";
  sim.teams[BLUE].magnetX = walker.x + 6;
  sim.teams[BLUE].magnetZ = walker.z;
  const before = Math.hypot(walker.x - sim.teams[BLUE].magnetX, walker.z - sim.teams[BLUE].magnetZ);
  tickFor(sim, 3);
  const after = Math.hypot(walker.x - sim.teams[BLUE].magnetX, walker.z - sim.teams[BLUE].magnetZ);
  assert(after < before - 2, `聚集谕令不受待机影响（${before.toFixed(1)} -> ${after.toFixed(1)}）`);

  console.log("testGatherOrderStillWorks ok");
}

function testBuilderExemptionE2E(): void {
  const sim = new Sim(new World(42));
  sim.units = sim.units.filter((u) => u.team !== RED);
  const walker = sim.addUnit(BLUE, "walker", 20, 20);
  walker.selected = true;

  assert(sim.tryPrepFound(23.5, 20, 0), "工地地基预备成功");
  const site = sim.foundSite(BLUE, 23.5, 20, 0, "hut");
  assert(site !== null && site!.need === 2, "L0 工地需要 2 木");

  sim.assignBuilders(BLUE, site!);
  assert(walker.buildId === site!.id, "建工指派写入 buildId");

  // 手工种两棵树保证有木材可砍（同 produce-check 手法）
  sim.trees.push(new Tree(9101, walker.x + 0.7, walker.z, sim.world.heightAt(walker.x + 0.7, walker.z), true, 0));
  sim.trees.push(new Tree(9102, walker.x, walker.z + 0.7, sim.world.heightAt(walker.x, walker.z + 0.7), true, 0));

  for (let i = 0; i < 800 && site!.level < 1; i++) sim.tick(0.05);
  assert(site!.level === 1, "被指派的建工保留自动砍树运木链，直到工地建成");
  tickFor(sim, 2); // 指派在下一次决策心跳惰性失效
  assert(walker.buildId === 0, "工地建成后指派自动失效（工成身退）");

  // 未指派的第二个村民全程站立旁观
  const bystander = sim.addUnit(BLUE, "walker", 20, 24);
  const b0 = { x: bystander.x, z: bystander.z };
  tickFor(sim, 3);
  assert(Math.hypot(bystander.x - b0.x, bystander.z - b0.z) < 0.5, "未指派村民不自动帮忙，原地站立");

  console.log("testBuilderExemptionE2E ok");
}

function testRedStillAutonomous(): void {
  const sim = new Sim(new World(42));
  const red = sim.addUnit(RED, "walker", 32, 32);
  const r0 = { x: red.x, z: red.z };
  tickFor(sim, 6);
  assert(Math.hypot(red.x - r0.x, red.z - r0.z) > 0.3, "红方单位保持自主行动（不受蓝方待机规则影响）");

  console.log("testRedStillAutonomous ok");
}

function main(): void {
  testBlueIdleStandStill();
  testStandingStillAutoAcquires();
  testOrderOverridesStanding();
  testGatherOrderStillWorks();
  testBuilderExemptionE2E();
  testRedStillAutonomous();
  console.log("idle-check ok (v0.10 玩家单位待机站立)");
}

main();
