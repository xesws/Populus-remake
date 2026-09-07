// v0.31 敌方 AI 测试（feature：AI 哨塔防御与受袭感知全覆盖）。
// 背景：旧实现 onTeamHurt 只有火球命中一处触发（近战/法术拆家 AI 完全无感），
// 且 AI 没有任何造塔/驻塔决策。本文件验证：受袭上报全覆盖 + 1s 节流、
// AI 自主建塔（cap/冷却）、自动驻塔、塔射击、塔毁弹出、近战驰援。
// 纯 node 可跑（npx tsx src/game/ai-defense-check.ts）。

import { AIDirector, AIProfile, TribeBrain } from "./ai";
import { WarDirector } from "./ai/war-director";
import { applyBuildingDamage, applyUnitDamage } from "./damage";
import { Sim } from "./sim";
import { BLUE, dist2, RED, Unit } from "./types";
import { World } from "./world";

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

function play(sim: Sim, dir: AIDirector, simTime: number): void {
  for (let t = 0; t < simTime; t += 0.05) {
    sim.tick(0.05);
    dir.update(sim, 0.05);
  }
}

/** 在 (cx,cz) 附近找一块可走地（螺旋外扩）。 */
function walkableNear(sim: Sim, cx: number, cz: number): { x: number; z: number } {
  for (let r = 0; r < 12; r++) {
    for (let a = 0; a < 12; a++) {
      const x = cx + Math.cos((a / 12) * Math.PI * 2) * r * 1.1;
      const z = cz + Math.sin((a / 12) * Math.PI * 2) * r * 1.1;
      if (sim.world.walkableAt(x, z)) return { x, z };
    }
  }
  throw new Error("找不到可走点");
}

/** test 1（D）：近战伤害（applyUnitDamage 传 sim）必须触发防御响应——reactSec 后派兵驰援。 */
function testMeleeHurtDispatchesDefenders(): void {
  const sim = new Sim(new World(42));
  const dir = new AIDirector([[RED, AIProfile.normal()]]);
  dir.attach(sim);
  const redPad = sim.world.startPad(RED);
  const post = walkableNear(sim, redPad.x + 14, redPad.z + 4); // 离基地足够远，排除漫游误判
  const victim: Unit = sim.addUnit(RED, "walker", post.x, post.z);
  for (let i = 0; i < 3; i++) sim.addUnit(RED, "warrior", redPad.x + 1.5 + i * 0.5, redPad.z + 1.5);
  const hp0 = victim.hp;
  applyUnitDamage(victim, "warrior", 1, sim); // 近战一刀 + 上报
  assert(victim.hp < hp0, "近战伤害应生效");
  play(sim, dir, 3.5); // reactSec=1.5s + 决策节流余量
  const responders = sim.units.filter(
    (u) => u.team === RED && u.kind === "warrior" && u.job === "move" && dist2(u.moveX, u.moveZ, post.x, post.z) < 16,
  );
  assert(responders.length >= 1, `受袭后应派兵驰援事发点（实际 ${responders.length} 名在路上）`);
  console.log("testMeleeHurtDispatchesDefenders ok");
}

/** test 2（D）：onHurt 1s 节流——DoT 逐帧上报只入队一条；冷却过后恢复入队。 */
function testHurtThrottle(): void {
  const sim = new Sim(new World(42));
  const brain = new TribeBrain(RED, AIProfile.normal());
  const war = brain.war as any;
  for (let i = 0; i < 5; i++) brain.war.onHurt(sim, 10 + i * 0.1, 10);
  assert(war.hurtQueue.length === 1, `1s 内连续上报应节流为 1 条（实际 ${war.hurtQueue.length}）`);
  for (let t = 0; t < 1.2; t += 0.05) sim.tick(0.05); // 推进 1.2s 越过节流窗
  brain.war.onHurt(sim, 12, 12);
  assert(war.hurtQueue.length === 2, "节流窗过后应恢复入队");
  console.log("testHurtThrottle ok");
}

/** test 3（D）：建筑伤害（applyBuildingDamage）也上报——旧实现只有火球会叫醒 AI。 */
function testBuildingDamageReports(): void {
  const sim = new Sim(new World(42));
  const dir = new AIDirector([[RED, AIProfile.normal()]]);
  dir.attach(sim);
  const hut = sim.buildings.find((b) => b.team === RED && b.kind === "hut")!;
  applyBuildingDamage(sim, hut, 3);
  const war = (dir as any).brains[0].war;
  assert(war.hurtQueue.length === 1, "建筑被打应入队受袭事件");
  applyBuildingDamage(sim, hut, 3);
  assert(war.hurtQueue.length === 1, "1s 节流窗内的重复上报不重复入队");
  console.log("testBuildingDamageReports ok");
}

/** test 4（C）：AI 自主建塔——有火战士 + 空闲村民时落塔地基并完工；塔 cap 生效。 */
function testAITowerBuiltWithCap(): void {
  const sim = new Sim(new World(42));
  const war = new WarDirector(RED, AIProfile.normal());
  const hut = sim.buildings.find((b) => b.team === RED && b.kind === "hut")!;
  sim.addUnit(RED, "firewarrior", hut.x + 1, hut.z + 1); // 塔要有弹药才建
  const founder: Unit = sim.addUnit(RED, "walker", hut.x + 2, hut.z + 2);

  (war as any).tryBuildTower(sim);
  let tower = sim.buildings.find((b) => b.team === RED && b.kind === "tower" && b.hp > 0);
  if (!tower) {
    assert(founder.foundKind === "tower", "未立即落基则村民应领到建塔任务");
    for (let t = 0; t < 600 && !tower; t++) {
      sim.tick(0.05);
      tower = sim.buildings.find((b) => b.team === RED && b.kind === "tower" && b.hp > 0);
    }
  }
  assert(tower !== undefined, "30s 内应出现哨塔建筑（含 L0 地基）");
  assert(founder.foundKind === null || tower!.level === 0, "营者任务随落基完成卸任");

  // 直接完工到 L1（绕过运木：无经济子脑的裸环境没人砍树）
  sim.completeStep(tower!);
  assert(tower!.level === 1, "哨塔应完工至 L1");

  // cap：normal towerCap=2，但冷却未过（lastTowerTime 刚记录）不得再建
  (war as any).tryBuildTower(sim);
  const towersNow = sim.buildings.filter((b) => b.team === RED && b.kind === "tower" && b.hp > 0);
  assert(towersNow.length === 1, `冷却期内不得再落塔（实际 ${towersNow.length}）`);
  (war as any).lastTowerTime = -1e9; // 越过冷却，验证 cap 本身
  (war as any).tryBuildTower(sim);
  const towersCapped = sim.buildings.filter((b) => b.team === RED && b.kind === "tower" && b.hp > 0);
  assert(towersCapped.length === 2, `cap=2 应允许第二座（实际 ${towersCapped.length}）`);
  (war as any).lastTowerTime = -1e9;
  (war as any).tryBuildTower(sim);
  const towersOver = sim.buildings.filter((b) => b.team === RED && b.kind === "tower" && b.hp > 0);
  assert(towersOver.length === 2, `超过 cap=2 不得再建（实际 ${towersOver.length}）`);
  console.log("testAITowerBuiltWithCap ok");
}

/** test 5（C）：空闲牛战士自动驻塔并真正爬上去；塔在射程内开火；塔毁弹出驻军。
 *  塔与靶位用 placeComplete + losBlocked 扫描（同 tower-garrison-check 的确定性几何）。 */
function testGarrisonFireEject(): void {
  const sim = new Sim(new World(42));
  const war = new WarDirector(RED, AIProfile.normal());
  const pad = sim.world.startPad(RED);
  // 先试 AI 自主建塔一次（覆盖 tryGarrisonTowers 的真实入口），再补 placeComplete 保证确定性。
  sim.addUnit(RED, "firewarrior", pad.x + 1, pad.z + 1);
  const founder: Unit = sim.addUnit(RED, "walker", pad.x + 2, pad.z + 2);
  (war as any).tryBuildTower(sim);
  let tower = sim.buildings.find((b) => b.team === RED && b.kind === "tower");
  for (let t = 0; t < 600 && !tower; t++) {
    sim.tick(0.05);
    tower = sim.buildings.find((b) => b.team === RED && b.kind === "tower");
  }
  assert(tower !== undefined, "AI 应派出建塔营者/落塔地基");
  sim.placeComplete(RED, tower!.x, tower!.z, tower!.yaw, "tower", 1); // 直接落成，绕过裸环境运木
  tower = sim.buildings.filter((b) => b.team === RED && b.kind === "tower" && b.level >= 1).pop()!;
  assert(tower.level === 1, "哨塔 L1 就位");

  const g: Unit = sim.addUnit(RED, "firewarrior", tower.x + 1.2, tower.z + 1.2); // 2.6 格内
  (war as any).tryGarrisonTowers(sim);
  assert(g.targetId === tower.id, "空闲牛战士应被指派驻塔");
  for (let t = 0; t < 200 && g.homeId === 0; t++) sim.tick(0.05);
  assert(g.homeId === tower.id, "牛战士应爬上哨塔（thinkUnits.tryGarrison 自动执行）");

  // 可射靶位：距塔 9 格、可走且弹道无地形遮挡（程序化扫描，同 v0.27-3 测试）
  let fx = tower.x + 9;
  let fz = tower.z;
  for (let a = 0; a < 16; a++) {
    const ang = (a / 16) * Math.PI * 2;
    const x = tower.x + Math.cos(ang) * 9;
    const z = tower.z + Math.sin(ang) * 9;
    if (sim.world.walkableAt(x, z) && !sim.world.losBlocked(tower.x, tower.z, x, z)) {
      fx = x;
      fz = z;
      break;
    }
  }
  const foe: Unit = sim.addUnit(BLUE, "walker", fx, fz);
  foe.hp = 999;
  const foeX = foe.x;
  const foeZ = foe.z;
  let hit = false;
  for (let i = 0; i < 200; i++) {
    sim.tick(0.05);
    foe.x = foeX; // 钉桩：击退/移动不影响弹着点
    foe.z = foeZ;
    foe.path = [];
    foe.pathI = 0;
    if (foe.hp < 999 || foe.downT > 0 || foe.flyVy !== 0) hit = true;
    if (hit) break;
  }
  assert(hit, "驻军哨塔应对射程内敌军开火命中");

  // 塔毁弹出：外壳一击 + 拆毁一击（ejectRuinedTowers 在 production tick 里扫）
  applyBuildingDamage(sim, tower, 9999);
  applyBuildingDamage(sim, tower, 9999);
  for (let t = 0; t < 100 && g.homeId !== 0; t++) sim.tick(0.05);
  assert(g.homeId === 0, "哨塔被毁后驻军应被弹出");
  console.log("testGarrisonFireEject ok");
}

testMeleeHurtDispatchesDefenders();
testHurtThrottle();
testBuildingDamageReports();
testAITowerBuiltWithCap();
testGarrisonFireEject();
console.log("ai-defense-check ok (v0.31 受袭感知全覆盖 + 节流 + AI 建塔/驻塔/塔击/弹出)");
