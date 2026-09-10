// v0.37 敌方 AI 测试（feature=ai-army：造兵积极性 + 兵种配比 + 集团波次 + 战损加码 + 留守池）。
// 背景（用户实测口径）："造兵特别不积极，一开始只会起一些武士，从来不知道主动把大量村民转化为
// 更多武士去发动进攻。它通常只有不到 10 个武士，也不知道去出别的兵种（比如火武士）。
// 它的进攻方式也特别单一，就是派一两个、三个武士过来骚扰一下，然后直接就被我打爆了。"
//
// 旧实现的三处结构性根因（本文件逐条回归）：
//   ① AIProfile.armyCap=8 与全局单条 trainCd：全军封顶 8 人、同一时刻只有一座营能出人；
//   ② launchWave 用 setOrder(team,"fight")——全队（含村民）任务被清空，且 finishTrain 给新兵
//      硬编码 order="fight"，新训成的武士各自冲向最近敌人逐个送命（"派一两个来骚扰"）；
//   ③ waveSize=3 且战损不记账：一波打光下一波照旧 3 人，永远是迷你骚扰。
// 纯 node 可跑（npx tsx src/game/ai-army-check.ts）。

import { AIProfile, ArmyPolicy } from "./ai";
import { AIDirector } from "./ai/ai-director";
import { Targeting } from "./ai/targeting";
import { WarDirector } from "./ai/war-director";
import { Sim } from "./sim";
import { Building, BuildingKind, dist2, DRAGON_GARRISON_MAX, inMap, POP_CAP, RED, Team, Unit } from "./types";
import { World } from "./world";

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

function play(sim: Sim, dir: AIDirector, seconds: number): void {
  for (let t = 0; t < seconds; t += 0.05) {
    sim.tick(0.05);
    dir.update(sim, 0.05);
  }
}

function redHut(sim: Sim): Building {
  const hut = sim.buildings.find((b) => b.team === RED && b.kind === "hut" && b.level >= 1 && b.hp > 0);
  assert(hut !== undefined, "红方开局应有茅屋");
  return hut!;
}

/** 找一块能落 kind 的空地：螺旋外扩，用 tryPrepFound（含预备整地）试落，保证能用。 */
function spotFor(sim: Sim, kind: BuildingKind, cx: number, cz: number): { x: number; z: number } {
  for (let r = 3; r <= 14; r += 1) {
    for (let a = 0; a < 24; a++) {
      const ang = (a / 24) * Math.PI * 2;
      const x = Math.round((cx + Math.cos(ang) * r) * 2) / 2;
      const z = Math.round((cz + Math.sin(ang) * r) * 2) / 2;
      if (!inMap(x, z)) continue;
      if (sim.tryPrepFound(x, z, 0, kind)) return { x, z };
    }
  }
  throw new Error(`找不到 ${kind} 的落点`);
}

function placeComplete(sim: Sim, kind: BuildingKind, x: number, z: number): Building {
  const made = sim.foundSite(RED, x, z, 0, kind);
  assert(made !== null, `${kind} 地基应能落下 @(${x.toFixed(1)},${z.toFixed(1)})`);
  sim.upgradeBuilding(made!, 1);
  return made!;
}

function spawnWalkers(sim: Sim, hut: Building, n: number): void {
  for (let i = 0; i < n; i++) {
    const ang = (i / 12) * Math.PI * 2;
    const r = 2.2 + Math.floor(i / 12) * 0.6;
    const x = hut.x + Math.cos(ang) * r;
    const z = hut.z + Math.sin(ang) * r;
    if (sim.world.walkableAt(x, z)) sim.addUnit(RED, "walker", x, z);
    else sim.addUnit(RED, "walker", hut.x + 2 + (i % 6) * 0.3, hut.z + 3 + Math.floor(i / 6) * 0.3);
  }
}

function fighterCount(sim: Sim, team: Team): number {
  return sim.units.filter(
    (u) => u.team === team && u.hp > 0 && (u.kind === "warrior" || u.kind === "firewarrior" || u.kind === "preacher"),
  ).length;
}

// ── T1：编制配额随人口滚动（纯策略）────────────────────────────────────────
function testArmyPolicyScalesWithPop(): void {
  const profile = AIProfile.normal();
  const sim = new Sim(new World(42));
  const pol = new ArmyPolicy(profile);
  const hut = redHut(sim);
  assert(
    pol.armyTarget(sim, RED) === profile.armyFloor,
    `人口 ${sim.countPop(RED)} 只吃保底下限 ${profile.armyFloor}（实际 ${pol.armyTarget(sim, RED)}）`,
  );

  // 补到 ~46 人：目标 = 人口 × armyRatio（未触上限）
  spawnWalkers(sim, hut, 40);
  const pop = sim.countPop(RED);
  const want = Math.max(profile.armyFloor, Math.min(profile.armyMax, Math.round(pop * profile.armyRatio)));
  assert(want > profile.armyFloor && want < profile.armyMax, `本用例人口 ${pop} 应落在上限内（目标 ${want}）`);
  assert(pol.armyTarget(sim, RED) === want, `常备军目标 = 人口 ${pop} × ${profile.armyRatio} = ${want}`);
  const comp = pol.compositionTarget(sim, RED);
  assert(comp.warrior + comp.firewarrior === want, "编成目标之和 = 常备军目标");
  assert(comp.firewarrior === Math.round(want * profile.fireRatio), "牛战士占比 = fireRatio");
  assert(comp.firewarrior >= 1 && comp.warrior >= 1, "两条兵种线都有位置（不再只出武士）");

  // 上限封顶：人口爆到 300+ 也只到 armyMax
  spawnWalkers(sim, hut, 300 - pop);
  assert(
    pol.armyTarget(sim, RED) === profile.armyMax,
    `人口 ${sim.countPop(RED)} 应封顶在 armyMax=${profile.armyMax}`,
  );

  // 按目标编成补齐 → 两条线缺口归零（满编不再空转训兵）
  const target = pol.compositionTarget(sim, RED);
  for (let i = 0; i < target.warrior; i++) sim.addUnit(RED, "warrior", hut.x + 2 + i * 0.12, hut.z + 3);
  for (let i = 0; i < target.firewarrior; i++) sim.addUnit(RED, "firewarrior", hut.x - 2 - i * 0.12, hut.z + 3);
  assert(pol.fieldForce(sim, RED) === pol.armyTarget(sim, RED), "野战军达到目标编成");
  assert(pol.warriorGap(sim, RED) === 0 && pol.firewarriorGap(sim, RED) === 0, "满编后两条线缺口都归零");

  // 在途驻防（targetId>0）不算野战军：兵在塔上/在赶往工厂的路上就要重新补编
  const fw = sim.units.find((u) => u.team === RED && u.kind === "firewarrior")!;
  fw.targetId = 999;
  assert(pol.firewarriorGap(sim, RED) === 1, "在途牛战士不计入野战军 → 缺口回到 1");
  fw.targetId = 0;
  console.log("testArmyPolicyScalesWithPop ok");
}

// ── T2：大龙计划门槛与征召名额（纯策略）──────────────────────────────────
function testDragonProgramGate(): void {
  const profile = AIProfile.normal();
  const sim = new Sim(new World(42));
  const pol = new ArmyPolicy(profile);
  const hut = redHut(sim);
  assert(!pol.dragonProgramActive(sim, RED), `人口 ${sim.countPop(RED)} < ${profile.dragonPopMin}：不启动`);
  assert(pol.dragonConscriptNeed(sim, RED) === 0, "未启动 → 不征召牛战士");

  spawnWalkers(sim, hut, profile.dragonPopMin + 6);
  assert(pol.dragonProgramActive(sim, RED), "人口达标 → 大龙计划启动");
  assert(pol.dragonConscriptNeed(sim, RED) === 0, "工厂还没落成 → 先建厂，不征召");

  const spot = spotFor(sim, "dragonFactory", hut.x + 8, hut.z + 8);
  const f = placeComplete(sim, "dragonFactory", spot.x, spot.z);
  assert(
    pol.dragonConscriptNeed(sim, RED) === DRAGON_GARRISON_MAX,
    `L1 工厂就位 → 缺 ${DRAGON_GARRISON_MAX} 名牛战士（实际 ${pol.dragonConscriptNeed(sim, RED)}）`,
  );
  assert(
    pol.armyCeiling(sim, RED) === profile.armyMax + DRAGON_GARRISON_MAX,
    `征召名额抬高展示口径：${profile.armyMax} + ${DRAGON_GARRISON_MAX}`,
  );
  assert(pol.armyCommitted(sim, RED) === 0, "无兵时编制口径为 0");
  assert(!pol.atArmyCeiling(sim, RED), "未达硬顶");

  // 已进驻 8 + 在途 3 → 还缺 9（在途者由 targetId 指厂计数，防超派堵门）
  f.dwell = 8;
  for (let i = 0; i < 3; i++) {
    const u = sim.addUnit(RED, "firewarrior", f.x + 3 + i * 0.2, f.z + 3);
    u.targetId = f.id;
  }
  assert(
    pol.dragonConscriptNeed(sim, RED) === DRAGON_GARRISON_MAX - 11,
    `扣除已进驻与在途后还缺 ${DRAGON_GARRISON_MAX - 11}（实际 ${pol.dragonConscriptNeed(sim, RED)}）`,
  );
  // v0.37 回归锁（探针实测死锁）：大龙计划的牛战士（已进厂 + 在途）**不计入编制硬顶**，
  // 否则征召名额缩小时硬顶反而低于现有兵力，训练永久停摆、工厂卡在 17/20 出不了龙。
  assert(pol.armyCommitted(sim, RED) === 0, "厂家牛战士（含在途）不计入 armyCommitted");
  assert(!pol.atArmyCeiling(sim, RED), "工厂里囤 11 人也不该碰硬顶（它们不是野战军）");
  // 满员（= 60s 生产中）→ 名额归零、条数算 1、计划关闭（不叠加第二条）
  f.dwell = DRAGON_GARRISON_MAX;
  assert(pol.dragonConscriptNeed(sim, RED) === 0, "满员后不再征召");
  assert(pol.dragonCount(sim, RED) === 1, "满员生产中算 1 条大龙（避免叠加第二条计划）");
  assert(!pol.dragonProgramActive(sim, RED), "名额已满 → 计划关闭");

  // 不追龙的档位（easy：dragonCap=0）永远不征召
  const easy = new ArmyPolicy(AIProfile.easy());
  assert(!easy.dragonProgramActive(sim, RED) && easy.dragonConscriptNeed(sim, RED) === 0, "easy 档不追龙");
  console.log("testDragonProgramGate ok");
}

// ── T3：双营并行 + 常备军突破旧 armyCap=8（行为）────────────────────────
function testParallelCampsGrowArmy(): void {
  const sim = new Sim(new World(42));
  const profile = AIProfile.normal();
  const hut = redHut(sim);
  const warSpot = spotFor(sim, "warriorHut", hut.x + 6, hut.z);
  placeComplete(sim, "warriorHut", warSpot.x, warSpot.z);
  const fireSpot = spotFor(sim, "fireHut", hut.x - 6, hut.z);
  placeComplete(sim, "fireHut", fireSpot.x, fireSpot.z);
  spawnWalkers(sim, hut, 44);
  const dir = new AIDirector([[RED, profile]]);
  dir.attach(sim);
  play(sim, dir, 100);
  const warriors = sim.countKind(RED, "warrior");
  const fires = sim.countKind(RED, "firewarrior");
  assert(
    fighterCount(sim, RED) >= 10,
    `100s 内常备军应突破旧 armyCap=8（实际 武士${warriors} 牛战士${fires} 合计${fighterCount(sim, RED)}）`,
  );
  assert(warriors >= 3 && fires >= 3, `两条产线都应出人（武士${warriors} 牛战士${fires}）`);
  console.log(`testParallelCampsGrowArmy ok（武士${warriors} 牛战士${fires}）`);
}

// ── T4：集团波次 = 同一点出发 + 焦点集火，且不动村民任务 ─────────────────
function testWaveFocusFireAndCivilianSafety(): void {
  const sim = new Sim(new World(42));
  const profile = AIProfile.normal();
  const war = new WarDirector(RED, profile);
  const hut = redHut(sim);
  // 10 名武士在家；村民带建营/入住任务（进攻不得清空它们）
  const founder: Unit = sim.addUnit(RED, "walker", hut.x + 3, hut.z + 3);
  founder.foundKind = "warriorHut";
  const occ: Unit = sim.addUnit(RED, "walker", hut.x + 2, hut.z + 2);
  occ.targetId = hut.id;
  for (let i = 0; i < 10; i++) sim.addUnit(RED, "warrior", hut.x + 1 + i * 0.2, hut.z + 2);
  assert(war.readyForce(sim) === 10, `可出击兵力 10（实际 ${war.readyForce(sim)}）`);
  assert(war.waveReady(sim), `兵力 10 ≥ 门槛 ${war.waveThreshold} 且冷却未起`);
  assert(war.launchWave(sim), "发波成功");
  const focus = Targeting.assaultFocus(sim, RED)!;
  const marchers = sim.units.filter((u) => u.team === RED && u.kind === "warrior");
  assert(marchers.length === 10, "全波 10 人一起出发（不是 1~3 人迷你队）");
  for (const m of marchers) {
    assert(m.atkId === focus.targetId, `全波集火同一目标（#${m.id} → ${m.atkId}，焦点 ${focus.targetId}）`);
    assert(dist2(m.moveX, m.moveZ, focus.x, focus.z) <= 16, `行军目标落在同一焦点附近（#${m.id}）`);
  }
  assert(sim.teams[RED].order === "settle", "军队姿态不改 teams[RED].order（新生村民仍按村民逻辑走）");
  assert(founder.foundKind === "warriorHut", "进攻不得清空村民的建营任务（旧实现 setOrder 全清）");
  assert(occ.targetId === hut.id, "进攻不得清空村民的入住指派");
  console.log("testWaveFocusFireAndCivilianSafety ok");
}

// ── T5：惨败加码——下一波门槛上调、打得好回落 ────────────────────────────
function testLossEscalatesThreshold(): void {
  const sim = new Sim(new World(42));
  const profile = AIProfile.normal();
  const war = new WarDirector(RED, profile);
  const hut = redHut(sim);
  for (let i = 0; i < 10; i++) sim.addUnit(RED, "warrior", hut.x + 1 + i * 0.2, hut.z + 2);
  assert(war.launchWave(sim), "首波出发");
  const threshold0 = war.waveThreshold;
  // 打掉 6/10（60% 战损 ≥ waveRetreatRatio=0.5）→ 判定收兵
  let killed = 0;
  for (const u of sim.units) {
    if (u.team !== RED || u.kind !== "warrior") continue;
    if (killed >= 6) break;
    u.hp = 0;
    killed++;
  }
  sim.tick(0.05); // cull 清场，让 readyForce 反映战损
  assert(war.shouldRecall(sim), "战损 60% 应判定收兵");
  war.recall(sim);
  assert(
    war.waveThreshold === threshold0 + profile.waveForceStep,
    `惨败后门槛加码 ${threshold0}→${war.waveThreshold}（期望 +${profile.waveForceStep}）`,
  );
  // 打得不错（战损 < 撤退线）→ 门槛回落，且不低于首波门槛
  war.waveThreshold = profile.waveForceMax;
  war.recall(sim);
  assert(war.waveThreshold < profile.waveForceMax, "低战损则门槛回落");
  war.waveThreshold = profile.waveForce;
  war.recall(sim);
  assert(war.waveThreshold === profile.waveForce, "门槛不会低于首波门槛");
  console.log("testLossEscalatesThreshold ok");
}

// ── T6：波次在外时老家告急 → 整波回防，且波次里的兵不被改道 ───────────────
function testDefenseKeepsAssaultIntact(): void {
  const sim = new Sim(new World(42));
  const profile = AIProfile.normal();
  const war = new WarDirector(RED, profile);
  const hut = redHut(sim);
  for (let i = 0; i < 14; i++) sim.addUnit(RED, "warrior", hut.x + 1 + i * 0.2, hut.z + 2);
  assert(war.launchWave(sim), "波次出发（全员野战军一起走）");
  const marchers = sim.units.filter((u) => u.team === RED && u.kind === "warrior" && u.hp > 0);
  const before = marchers.map((u) => ({ id: u.id, x: u.moveX, z: u.moveZ }));
  war.onHurt(sim, hut.x + 1, hut.z + 1); // 老家挨打
  for (let t = 0; t < 3; t += 0.05) sim.tick(0.05);
  war.update(sim, profile.tickSec);
  for (const b of before) {
    const u = sim.units.find((o) => o.id === b.id && o.hp > 0);
    if (!u) continue; // 战死的不算改道
    assert(u.moveX === b.x && u.moveZ === b.z, `波次里的兵#${u.id} 不得被受袭事件改道回老家`);
  }
  assert(war.shouldRecall(sim), "老家告急（homeThreatR 内）→ 整波回防");
  war.recall(sim);
  assert(!war.shouldRecall(sim), "收兵后老家告警清零");
  console.log("testDefenseKeepsAssaultIntact ok");
}

// ── T7：发展期受袭只派 defenseSize 名留守兵（不再整队扑出去）──────────────
function testDefensePoolCapped(): void {
  const sim = new Sim(new World(42));
  const profile = AIProfile.normal();
  const war = new WarDirector(RED, profile);
  const hut = redHut(sim);
  for (let i = 0; i < 12; i++) sim.addUnit(RED, "warrior", hut.x + 1 + i * 0.2, hut.z + 2);
  const target = { x: hut.x + 16, z: hut.z + 8 };
  war.onHurt(sim, target.x, target.z);
  for (let t = 0; t < profile.reactSec + 1; t += 0.05) sim.tick(0.05);
  war.update(sim, profile.tickSec);
  const responders = sim.units.filter(
    (u) => u.team === RED && u.kind === "warrior" && u.job === "move" && dist2(u.moveX, u.moveZ, target.x, target.z) < 9,
  );
  assert(
    responders.length === profile.defenseSize,
    `受袭只派留守池 ${profile.defenseSize} 人（实际 ${responders.length}）`,
  );
  assert(responders.every((u) => u.atkId !== 0), "驰援者应挂上就近敌人，到达即接战");
  console.log("testDefensePoolCapped ok");
}

// ── T8（探针实测死锁回归）：人口打满 + 户外村民全在干活时不得"兵源假饿死"─────
// 实测背景：旧写法“空闲村民 − batch ≥ laborFloor”会把“全队都在砍树搬运”误判成没人可征——
// 探针里大龙训练营卡在 12/20 再也不动，而当时户外还有 20 名村民在干活。
// 新口径：保底看**户外村民总数**，人口到顶时从茅屋动员住户入伍。
function testWartimeConscriptionAtPopCap(): void {
  const sim = new Sim(new World(42));
  const profile = AIProfile.normal();
  const hut = redHut(sim);
  const warSpot = spotFor(sim, "warriorHut", hut.x + 6, hut.z);
  placeComplete(sim, "warriorHut", warSpot.x, warSpot.z);
  const fireSpot = spotFor(sim, "fireHut", hut.x - 6, hut.z);
  placeComplete(sim, "fireHut", fireSpot.x, fireSpot.z);
  // 住户：占满开局两座茅屋的容量（每座 L1 屋 2 人）；其余村民全部标上建营任务（foundKind），
  // 这样他们在 sim.train 的征兵池里被排除，也不会因为一两个 tick 就自动空闲下来。
  const huts = sim.buildings.filter((b) => b.team === RED && b.kind === "hut" && b.level >= 1 && b.hp > 0);
  spawnWalkers(sim, hut, 8);
  let inside = 0;
  for (const h of huts) {
    for (const u of sim.units) {
      if (u.team !== RED || u.kind !== "walker" || u.homeId > 0) continue;
      if (h.dwell >= 2) break;
      if (sim.occupy(u, h)) inside++;
    }
  }
  assert(inside >= 4, `至少 4 名住户进茅屋（实际 ${inside}）`);
  spawnWalkers(sim, hut, POP_CAP[RED] - sim.countPop(RED));
  for (const u of sim.units) {
    if (u.team !== RED || u.kind !== "walker" || u.homeId > 0) continue;
    u.foundKind = "hut";
  }
  sim.tick(0.05);
  const army = new ArmyPolicy(profile);
  assert(sim.countPop(RED) >= POP_CAP[RED] - 2, `人口应已打满（实际 ${sim.countPop(RED)}/${POP_CAP[RED]}）`);
  assert(sim.draftableWalkers(RED).length === 0, "前提：此刻没有任何空闲村民可征");
  assert(army.surplusDwellers(sim, RED) > 0, "前提：人口到顶 → 有可动员的住户");
  const before = fighterCount(sim, RED);
  const dir = new AIDirector([[RED, profile]]);
  dir.attach(sim);
  play(sim, dir, 40);
  assert(
    fighterCount(sim, RED) > before,
    `40s 内应从住户里动员出人入伍（战前 ${before} → 战后 ${fighterCount(sim, RED)}）`,
  );
  console.log("testWartimeConscriptionAtPopCap ok");
}

testArmyPolicyScalesWithPop();
testDragonProgramGate();
testParallelCampsGrowArmy();
testWaveFocusFireAndCivilianSafety();
testLossEscalatesThreshold();
testDefenseKeepsAssaultIntact();
testDefensePoolCapped();
testWartimeConscriptionAtPopCap();
console.log("ai-army-check ok (v0.37 编制配额 + 双营并行 + 集团焦点集火 + 战损加码 + 留守池 + 战争经济动员)");
