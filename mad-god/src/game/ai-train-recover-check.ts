// v0.34 敌方 AI 测试（feature：独立 TrainingDirector + 并行常备配额 + 雷电拆营后重建）。
// v0.35 村民保底：补编制不得把入住/建营村民训光，否则茅屋停产、再也盖不了营。
// 背景：旧链路把建营挂在失败的 train() 副作用上——村民不足静默跳过、火战士被 2 武士+1 传教士
// 阶梯锁死、雷电拆营后 trainCd 空转。本文件验证：武士营 L1 即开训火战士营、无武士仍训牛战士、
// 村民不足仍从茅屋拉人重建、重建到 L1 后立刻复训、武士营与火战士营独立恢复。
// 纯 node 可跑（npx tsx src/game/ai-train-recover-check.ts）。

import { AIDirector, AIProfile, RosterPolicy, type RosterSnapshot } from "./ai";
import { Sim } from "./sim";
import { BLUE, BuildingKind, RED } from "./types";
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

function redHut(sim: Sim) {
  const hut = sim.buildings.find((b) => b.team === RED && b.kind === "hut" && b.level >= 1 && b.hp > 0);
  assert(hut !== undefined, "红方开局应有茅屋");
  return hut!;
}

function placeCamp(sim: Sim, kind: BuildingKind, x: number, z: number) {
  const made = sim.foundSite(RED, x, z, 0, kind);
  assert(made !== null, `${kind} 地基应能落下 @(${x.toFixed(1)},${z.toFixed(1)})`);
  sim.upgradeBuilding(made!, 1);
  return made!;
}

function wipeBuilding(sim: Sim, x: number, z: number): void {
  sim.strikeLightning(x, z);
  sim.strikeLightning(x, z);
  sim.tick(0.05);
}

function hasCamp(sim: Sim, kind: BuildingKind, needL1 = false): boolean {
  return sim.buildings.some((b) => b.team === RED && b.kind === kind && b.hp > 0 && (!needL1 || b.level >= 1));
}

function fireFounderOrCamp(sim: Sim): boolean {
  if (hasCamp(sim, "fireHut")) return true;
  return sim.units.some((u) => u.team === RED && u.kind === "walker" && u.foundKind === "fireHut");
}

function warriorFounderOrCamp(sim: Sim): boolean {
  if (hasCamp(sim, "warriorHut")) return true;
  return sim.units.some((u) => u.team === RED && u.kind === "walker" && u.foundKind === "warriorHut");
}

function emptyRoster(): RosterSnapshot {
  return {
    warrior: 0,
    firewarrior: 0,
    preacher: 0,
    spy: 0,
    foeWalk: 3,
    warriorHutL1: false,
    fireHutL1: false,
    fireHutAny: false,
    templeL1: false,
    templeAny: false,
    spyHutL1: false,
    spyHutAny: false,
  };
}

/** T0：配额表纯函数——武士营 L1 即要火战士营；下限未达标不要神庙；缺口独立、不平手时大口先补。 */
function testRosterPolicyParallel(): void {
  const p = new RosterPolicy(AIProfile.normal());
  const s = { ...emptyRoster(), warriorHutL1: true };
  const wanted = p.wantedCamps(s);
  assert(wanted.includes("warriorHut") && wanted.includes("fireHut"), "L1 武士营即要火战士营（不等 2 名活武士）");
  assert(!wanted.includes("temple"), "常备下限未达标不要神庙");
  const bothL1 = { ...s, fireHutL1: true };
  assert(p.nextTrainKind(bothL1) === "warrior", "武士缺口 2 > 牛战士缺口 1，先补武士");
  const warFloor = { ...bothL1, warrior: 2 };
  assert(p.nextTrainKind(warFloor) === "firewarrior", "武士满员后并行补牛战士，不要求传教士");
  const floors = { ...warFloor, firewarrior: 1 };
  assert(p.floorsMet(floors), "2 武士 + 1 牛战士即达标");
  assert(p.wantedCamps(floors).includes("temple"), "下限达标后神庙作为溢出");
  assert(p.walkerReserve(4) === 5, "入住 4 + founderSlack 1 = 保底 5");
  assert(!p.canAffordTrain(4, 4), "4 村民不够保底，禁止开训（含补编制）");
  assert(!p.canAffordTrain(5, 4), "刚好保底仍禁止开训");
  assert(p.canAffordTrain(6, 4), "6 村民可训 1 人并留下保底");
  assert(p.trainBatch(6, 4) === 1 && p.trainBatch(5, 4) === 0, "每次只训 1 人，保底下 batch=0");
  console.log("testRosterPolicyParallel ok");
}

/** T1：只有 L1 武士营、0 武士 → 数秒内派火战士营建营者或落下地基。 */
function testL1WarriorHutWantsFireHut(): void {
  const sim = new Sim(new World(42));
  const hut = redHut(sim);
  placeCamp(sim, "warriorHut", hut.x + 6, hut.z);
  for (let i = 0; i < 6; i++) sim.addUnit(RED, "walker", hut.x + 2 + i * 0.4, hut.z + 3);
  const dir = new AIDirector([[RED, AIProfile.normal()]]);
  dir.attach(sim);
  play(sim, dir, 12);
  assert(fireFounderOrCamp(sim), "武士营 L1 后应并行派建火战士营（不等 2 名活武士）");
  console.log("testL1WarriorHutWantsFireHut ok");
}

/** T2：0 武士 + L1 火战士营仍训出牛战士（不再被 2 武士 + 1 传教士阶梯锁死）。 */
function testZeroWarriorsStillTrainFirewarrior(): void {
  const sim = new Sim(new World(42));
  const hut = redHut(sim);
  placeCamp(sim, "warriorHut", hut.x + 6, hut.z);
  placeCamp(sim, "fireHut", hut.x + 9, hut.z);
  for (const u of sim.units.filter((u) => u.team === RED && u.kind === "warrior")) u.hp = 0;
  sim.tick(0.05);
  for (let i = 0; i < 14; i++) sim.addUnit(RED, "walker", hut.x + 2 + i * 0.4, hut.z + 3);
  const dir = new AIDirector([[RED, AIProfile.normal()]]);
  dir.attach(sim);
  let everFire = false;
  for (let t = 0; t < 40 * 20; t++) {
    sim.tick(0.05);
    dir.update(sim, 0.05);
    if (sim.units.some((u) => u.team === RED && u.kind === "firewarrior" && u.hp > 0)) everFire = true;
  }
  assert(everFire, "0 名武士起步仍应训出过牛战士（并行配额，非阶梯记忆）");
  console.log("testZeroWarriorsStillTrainFirewarrior ok");
}

/** T3：雷电拆掉火战士营、户外村民 < armyCap+2 且全入住 → 仍从茅屋拉人重建。 */
function testLightningCullFoundsFromDweller(): void {
  const sim = new Sim(new World(42));
  const hut = redHut(sim);
  placeCamp(sim, "warriorHut", hut.x + 6, hut.z);
  const fire = placeCamp(sim, "fireHut", hut.x + 10, hut.z);
  for (const u of sim.units.filter((u) => u.team === RED && u.kind === "walker" && u.homeId === 0)) {
    if (!sim.occupy(u, hut)) u.hp = 0;
  }
  sim.tick(0.05);
  const dwellers = sim.units.filter((u) => u.team === RED && u.kind === "walker" && u.homeId > 0 && u.hp > 0);
  assert(dwellers.length >= 1, "拆营前至少留 1 名茅屋住户");
  const outdoor = sim.units.filter((u) => u.team === RED && u.kind === "walker" && u.homeId === 0 && u.hp > 0);
  assert(outdoor.length === 0, "户外村民必须清空，才能验证 leaveBuilding 征召");
  const walkers = sim.countKind(RED, "walker");
  assert(walkers < AIProfile.normal().armyCap + 2, `村民 ${walkers} 应 < armyCap+2，旧实现会静默跳过建营`);
  wipeBuilding(sim, fire.x, fire.z);
  assert(!hasCamp(sim, "fireHut"), "两记雷电后火战士营应被拆没");
  const dir = new AIDirector([[RED, AIProfile.normal()]]);
  dir.attach(sim);
  play(sim, dir, 16);
  assert(fireFounderOrCamp(sim), "村民不足时仍应从茅屋拉人重建火战士营");
  console.log("testLightningCullFoundsFromDweller ok");
}

/** T4：拆营后落下 L0、升到 L1，应立刻复训牛战士（trainCd 不因缺营空转）。 */
function testRebuildThenRetrainFirewarrior(): void {
  const sim = new Sim(new World(42));
  const hut = redHut(sim);
  placeCamp(sim, "warriorHut", hut.x + 6, hut.z);
  const fire = placeCamp(sim, "fireHut", hut.x + 10, hut.z);
  for (let i = 0; i < 14; i++) sim.addUnit(RED, "walker", hut.x + 2 + i * 0.4, hut.z + 3);
  wipeBuilding(sim, fire.x, fire.z);
  const dir = new AIDirector([[RED, AIProfile.normal()]]);
  dir.attach(sim);
  play(sim, dir, 16);
  let rebuilt = sim.buildings.find((b) => b.team === RED && b.kind === "fireHut" && b.hp > 0);
  if (!rebuilt) {
    const founder = sim.units.find((u) => u.team === RED && u.kind === "walker" && u.foundKind === "fireHut");
    assert(founder !== undefined, "拆营后应派出火战士营建营者");
    play(sim, dir, 20);
    rebuilt = sim.buildings.find((b) => b.team === RED && b.kind === "fireHut" && b.hp > 0);
  }
  assert(rebuilt !== undefined, "拆营后应落下火战士营地基");
  if (rebuilt!.level < 1) sim.upgradeBuilding(rebuilt!, 1);
  let everFire = false;
  for (let t = 0; t < 40 * 20; t++) {
    sim.tick(0.05);
    dir.update(sim, 0.05);
    if (sim.units.some((u) => u.team === RED && u.kind === "firewarrior" && u.hp > 0)) everFire = true;
  }
  assert(everFire, "重建到 L1 后应立刻复训牛战士");
  console.log("testRebuildThenRetrainFirewarrior ok");
}

/** T5：雷电拆武士营、火战士营仍在 → 独立重建武士营，不拆火战士营。 */
function testWarriorHutRebuildIndependent(): void {
  const sim = new Sim(new World(42));
  const hut = redHut(sim);
  const war = placeCamp(sim, "warriorHut", hut.x + 6, hut.z);
  placeCamp(sim, "fireHut", hut.x + 10, hut.z);
  for (let i = 0; i < 6; i++) sim.addUnit(RED, "walker", hut.x + 2 + i * 0.4, hut.z + 3);
  wipeBuilding(sim, war.x, war.z);
  assert(!hasCamp(sim, "warriorHut"), "两记雷电后武士营应被拆没");
  assert(hasCamp(sim, "fireHut"), "火战士营应仍在");
  const dir = new AIDirector([[RED, AIProfile.normal()]]);
  dir.attach(sim);
  play(sim, dir, 16);
  assert(warriorFounderOrCamp(sim), "武士营应独立重建（不依赖火战士营是否还在）");
  assert(hasCamp(sim, "fireHut"), "重建武士营不得拆掉仍活着的火战士营");
  console.log("testWarriorHutRebuildIndependent ok");
}

/** T6：开局村民 + L1 武士营，不得在 90s 内把村民训光——茅屋要继续入住并生产。 */
function testDoesNotDrainStartingVillagers(): void {
  const sim = new Sim(new World(42));
  const hut = redHut(sim);
  placeCamp(sim, "warriorHut", hut.x + 6, hut.z);
  for (const u of sim.units) {
    if (u.team === BLUE && u.kind === "shaman") u.hp = 0;
  }
  sim.tick(0.05);
  const walkers0 = sim.countKind(RED, "walker");
  const dir = new AIDirector([[RED, AIProfile.normal()]]);
  dir.attach(sim);
  play(sim, dir, 90);
  const walkers = sim.countKind(RED, "walker");
  const warriors = sim.countKind(RED, "warrior");
  const dwell = sim.buildings
    .filter((b) => b.team === RED && b.kind === "hut" && b.hp > 0)
    .reduce((n, b) => n + b.dwell, 0);
  const born = sim.buildings
    .filter((b) => b.team === RED && b.kind === "hut")
    .reduce((n, b) => n + b.born, 0);
  assert(walkers >= 1, `90s 后应仍有村民（${walkers0} → ${walkers}，武士 ${warriors}），否则无法建营/生产`);
  assert(dwell >= 1, `茅屋应仍有入住（dwell=${dwell}），训兵不得抽空生产`);
  assert(born > 0, `茅屋应继续生产（born=${born}）`);
  console.log("testDoesNotDrainStartingVillagers ok");
}

testRosterPolicyParallel();
testL1WarriorHutWantsFireHut();
testZeroWarriorsStillTrainFirewarrior();
testLightningCullFoundsFromDweller();
testRebuildThenRetrainFirewarrior();
testWarriorHutRebuildIndependent();
testDoesNotDrainStartingVillagers();
console.log("ai-train-recover-check ok (v0.34 TrainingDirector：并行配额 + 雷电拆营重建 + 复训；v0.35 村民保底)");
