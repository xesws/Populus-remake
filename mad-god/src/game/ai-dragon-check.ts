// v0.37 敌方 AI 测试（feature=ai-dragon：大龙计划——建厂 / 征召牛战士 / 生产空降 / 出动 / 跨海开关）。
// 背景（用户实测口径）："它也不知道去出别的兵种（比如火武士），更不知道拿火武士去训练大龙。"
// 旧实现 AI 侧零 dragonFactory 逻辑：永远不建厂、不征召，也就永远见不到敌方大龙。
//
// 本文件覆盖 v0.37 的三段接线：
//   ① 人口达标 → 营地愿望单里的 dragonFactory 由既有建营链路（落基/运木/完工）落地；
//   ② 空闲牛战士被逐批征召进厂（targetId 指厂 + 走到厂边，thinkUnits.tryEnterFactory 自动进驻），
//      满 DRAGON_GARRISON_MAX 名由 DragonSystem 开工，60s 后空降大龙；
//   ③ 出厂大龙按 dragonOrderSec 节拍压向敌方密集点，dragonCrossSea 决定分岛图是否跨海。
// 纯 node 可跑（npx tsx src/game/ai-dragon-check.ts）。

import { AIProfile, ArmyPolicy, DragonDirector, RosterPolicy, Targeting, type RosterSnapshot } from "./ai";
import { AIDirector } from "./ai/ai-director";
import { Sim } from "./sim";
import { Building, BuildingKind, DRAGON_GARRISON_MAX, DRAGON_HP, inMap, RED, Team } from "./types";
import { World } from "./world";

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

function redHut(sim: Sim): Building {
  const hut = sim.buildings.find((b) => b.team === RED && b.kind === "hut" && b.level >= 1 && b.hp > 0);
  assert(hut !== undefined, "红方开局应有茅屋");
  return hut!;
}

function spotFor(sim: Sim, kind: BuildingKind, cx: number, cz: number, _team: Team = RED): { x: number; z: number } {
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

function placeComplete(sim: Sim, kind: BuildingKind, x: number, z: number, team: Team = RED): Building {
  const made = sim.foundSite(team, x, z, 0, kind);
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

function snapshot(over: Partial<RosterSnapshot> = {}): RosterSnapshot {
  return {
    warrior: 4,
    firewarrior: 2,
    preacher: 0,
    spy: 0,
    foeWalk: 3,
    warriorHutL1: true,
    fireHutL1: true,
    fireHutAny: true,
    templeL1: false,
    templeAny: false,
    spyHutL1: false,
    spyHutAny: false,
    pop: 10,
    dragonFactoryAny: false,
    dragonFactoryL1: false,
    dragonProgram: false,
    ...over,
  };
}

// ── T1：愿望单——人口达标即要大龙训练营（纯策略）────────────────────────
function testWantedCamps(): void {
  const p = new RosterPolicy(AIProfile.normal());
  assert(!p.wantedCamps(snapshot()).includes("dragonFactory"), "人口未达标：不要大龙训练营");
  const active = snapshot({ pop: 30, dragonProgram: true });
  assert(p.wantedCamps(active).includes("dragonFactory"), "人口达标（大龙计划启动）→ 愿望单加入大龙训练营");
  const built = snapshot({ pop: 30, dragonProgram: false, dragonFactoryAny: true, dragonFactoryL1: true });
  assert(p.wantedCamps(built).includes("dragonFactory"), "已建成的大龙训练营仍在维护名单里（被拆会被重建）");
  console.log("testWantedCamps ok");
}

// ── T2：AI 自主落大龙训练营地基（行为，走真实建营链路）──────────────────
function testAiFoundsFactory(): void {
  const sim = new Sim(new World(42));
  const profile = AIProfile.normal();
  const hut = redHut(sim);
  spawnWalkers(sim, hut, profile.dragonPopMin + 8);
  const dir = new AIDirector([[RED, profile]]);
  dir.attach(sim);
  let l0: Building | undefined;
  for (let t = 0; t < 60 && !l0; t += 0.05) {
    sim.tick(0.05);
    dir.update(sim, 0.05);
    l0 = sim.buildings.find((b) => b.team === RED && b.kind === "dragonFactory" && b.hp > 0);
  }
  assert(l0 !== undefined, "人口达标后 60s 内应派出建营者并落下大龙训练营地基");
  // 木料链路：6 捆木头由村民砍运（hasNeedSite），这里只补足剩余木料把工期收尾，
  // 避免用例时长被砍树往返撑到几分钟；建营链路本身已由 ai-founder-check 覆盖。
  for (let i = l0!.wood; i < l0!.need; i++) sim.deliverWood(l0!);
  for (let t = 0; t < 30 && l0!.level < 1; t += 0.05) sim.tick(0.05);
  assert(l0!.level >= 1, `补足 ${l0!.need} 捆木头后应完工为 L1（实际 L${l0!.level}）`);
  console.log("testAiFoundsFactory ok");
}

// ── T3：征召 20 名牛战士 → 60s 生产 → 大龙空降 → 出动压向敌方密集点 ──────
function testConscriptProduceAndDeploy(): void {
  const sim = new Sim(new World(42));
  const profile = AIProfile.normal();
  const army = new ArmyPolicy(profile);
  const hut = redHut(sim);
  spawnWalkers(sim, hut, profile.dragonPopMin + 6);
  const spot = spotFor(sim, "dragonFactory", hut.x + 9, hut.z + 9);
  const f = placeComplete(sim, "dragonFactory", spot.x, spot.z);
  assert(army.dragonProgramActive(sim, RED), "人口达标 + 工厂落成 → 大龙计划推进中");
  assert(
    army.dragonConscriptNeed(sim, RED) === DRAGON_GARRISON_MAX,
    `开局缺 ${DRAGON_GARRISON_MAX} 名牛战士`,
  );

  // 场上有 22 名空闲牛战士（比名额多 2 名，多出来的不许被吞）
  for (let i = 0; i < 22; i++) {
    const ang = (i / 22) * Math.PI * 2;
    sim.addUnit(RED, "firewarrior", f.x + Math.cos(ang) * 4.5, f.z + Math.sin(ang) * 4.5);
  }
  const dragon = new DragonDirector(RED, profile);
  let sawFull = false;
  for (let t = 0; t < 40; t += 0.05) {
    sim.tick(0.05);
    dragon.update(sim, 0.05);
    if (f.dwell >= DRAGON_GARRISON_MAX) sawFull = true;
  }
  assert(sawFull, `40s 内 20 名牛战士应全部进驻（dwell=${f.dwell}/${DRAGON_GARRISON_MAX}）`);
  assert(army.dragonConscriptNeed(sim, RED) === 0, "满员后停止征召");
  assert(dragon.dragonCount(sim) === 1, "满员生产中即算 1 条大龙（不叠加第二条计划）");
  const left = sim.units.filter((u) => u.team === RED && u.kind === "firewarrior" && u.homeId === 0).length;
  assert(left === 2, `超编的 2 名牛战士应留在场外（实际 ${left}；进驻的 20 名 homeId 已挂厂）`);

  // 60s 生产 → 大龙空降（20 名进驻者化为龙）
  let born = false;
  for (let t = 0; t < 70 && !born; t += 0.05) {
    sim.tick(0.05);
    dragon.update(sim, 0.05);
    born = sim.units.some((u) => u.team === RED && u.kind === "dragon" && u.hp > 0);
  }
  assert(born, "满员 60s 后应空降大龙");
  const d = sim.units.find((u) => u.team === RED && u.kind === "dragon" && u.hp > 0)!;
  assert(d.hp === DRAGON_HP, "大龙血量 = DRAGON_HP");
  assert(f.dwell === 0 && f.prod === 0, "出厂后工厂计数清零");

  // 出动：无目标时压向**软目标**（v0.38：不再扑敌方密集点——那是玩家主力与塔群顶上）
  dragon.lastOrderAt = -1e9;
  dragon.update(sim, profile.tickSec);
  const focus = Targeting.softFocus(sim, RED, { x: d.x, z: d.z }, profile.dragonSoftRadius)!;
  assert(
    d.moveX >= 0 && Math.hypot(d.moveX - focus.x, d.moveZ - focus.z) < 2,
    `大龙应被派往软目标 (${focus.x.toFixed(1)},${focus.z.toFixed(1)})（实际 ${d.moveX.toFixed(1)},${d.moveZ.toFixed(1)}）`,
  );

  // 低血撤离：掉到 dragonRetreatHp 以下应被召回自家聚落（龙不回血，硬拼到底就是白送）
  d.hp = d.maxHp * (profile.dragonRetreatHp - 0.1);
  dragon.lastOrderAt = -1e9;
  dragon.update(sim, profile.tickSec);
  const home = Targeting.homePoint(sim, RED);
  assert(
    Math.hypot(d.moveX - home.x, d.moveZ - home.z) < 2,
    `低血大龙应撤回自家聚落 (${home.x.toFixed(1)},${home.z.toFixed(1)})（实际 ${d.moveX.toFixed(1)},${d.moveZ.toFixed(1)}）`,
  );
  console.log("testConscriptProduceAndDeploy ok");
}

// ── T3b：软目标选择——龙的靶子必须避开敌方主力（"一过来就被集火"的战术修正）─────
function testSoftFocusAvoidsArmy(): void {
  const sim = new Sim(new World(42));
  // 蓝方：一座被 8 名火武士守着的茅屋（主场）vs 远处无人守的孤立茅屋
  const guarded = sim.buildings.find((b) => b.team === 0 && b.kind === "hut")!;
  for (let i = 0; i < 8; i++) sim.addUnit(0, "firewarrior", guarded.x + 2 + i * 0.3, guarded.z + 2);
  const spot = spotFor(sim, "hut", guarded.x + 20, guarded.z + 20, 0);
  const lonely = placeComplete(sim, "hut", spot.x, spot.z, 0);
  const focus = Targeting.softFocus(sim, RED, { x: lonely.x - 12, z: lonely.z - 12 }, 12)!;
  assert(focus !== null, "应选出软目标");
  assert(
    focus.targetId === lonely.id,
    `应选无人驻守的孤立茅屋#${lonely.id}，而不是被 8 名火武士守着的#${guarded.id}（实际选了 #${focus.targetId}）`,
  );
  console.log("testSoftFocusAvoidsArmy ok");
}

// ── T4：dragonCrossSea 开关——分岛图大龙是否跨海 ────────────────────────
function testCrossSeaSwitch(): void {
  let splitSeed = 0;
  for (let s = 1; s <= 40 && !splitSeed; s++) {
    const w = new World(s);
    const a = w.islandAt(w.starts[0].x, w.starts[0].z);
    const b = w.islandAt(w.starts[1].x, w.starts[1].z);
    if (a >= 0 && b >= 0 && a !== b) splitSeed = s;
  }
  if (!splitSeed) {
    console.log("testCrossSeaSwitch skipped（1..40 无分岛种子）");
    return;
  }
  const sim = new Sim(new World(splitSeed));
  const profile = AIProfile.normal();
  const hut = redHut(sim);
  const redPad = sim.world.startPad(RED);
  const dragon = sim.addUnit(RED, "dragon", redPad.x, redPad.z);
  dragon.hp = DRAGON_HP;
  const focus = Targeting.softFocus(sim, RED, { x: redPad.x, z: redPad.z }, profile.dragonSoftRadius)!;
  assert(
    sim.world.islandAt(redPad.x, redPad.z) !== sim.world.islandAt(focus.x, focus.z),
    `分岛图（seed=${splitSeed}）：敌方软目标确实在对岸`,
  );

  const off = new DragonDirector(RED, Object.assign(AIProfile.normal(), { dragonCrossSea: false }));
  off.lastOrderAt = -1e9;
  off.update(sim, profile.tickSec);
  assert(dragon.moveX < 0, "dragonCrossSea=false：大龙不得被派去隔海目标");

  const on = new DragonDirector(RED, profile);
  on.lastOrderAt = -1e9;
  on.update(sim, profile.tickSec);
  assert(dragon.moveX >= 0, "dragonCrossSea=true：大龙跨海出击（分岛图红方唯一的远程手段）");
  console.log(`testCrossSeaSwitch ok（seed=${splitSeed}）`);
}

testWantedCamps();
testAiFoundsFactory();
testConscriptProduceAndDeploy();
testSoftFocusAvoidsArmy();
testCrossSeaSwitch();
console.log("ai-dragon-check ok (v0.38 大龙计划：愿望单建厂 + 牛战士征召 + 生产空降 + 软目标出动 + 低血撤离 + 跨海开关)");
