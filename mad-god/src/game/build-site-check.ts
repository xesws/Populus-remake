// v0.38 玩家建房链路测试（feature=build-site）：为什么"总有几个房屋死活建造不起来"。
//
// 背景（用户实测口径）："我这边建造房屋的时候，老是会有几个房屋它死活建造不起来。"
// 根因是工地的建造动力完全挂在村民的 buildId 上，而旧实现有四处断链：
//   ① 建房时选中里没有村民（例如选的是士兵）→ assignBuilders 静默什么都不做，工地永远没人；
//   ② 选中屋顶住户/塔上单位当建工 → homeId>0 的单位被 thinkUnits 整体跳过，永远走不到工地；
//   ③ 任何一次右键走位 / setOrder 都会经 clearOrders 把 buildId 清掉 → 建工集体辞职、工地停在半成品；
//   ④ 建工战死后没有任何机制再把工地接上 → 僵尸工地。
// 本文件逐条回归，并锁定"工地看门狗"（无建工时自动召集 2 名空闲村民）的三条自限。
// 纯 node 可跑（npx tsx src/game/build-site-check.ts）。

import { Sim } from "./sim";
import { BLUE, Building, dist2, inMap, Unit } from "./types";
import { World } from "./world";

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

function play(sim: Sim, seconds: number): void {
  for (let t = 0; t < seconds; t += 0.05) {
    sim.tick(0.05);
    sim.winner = null; // 观测量化：不让红方 AI 提前结束对局
  }
}

function bluePad(sim: Sim): { x: number; z: number } {
  return sim.world.startPad(BLUE);
}

function spawnWalkers(sim: Sim, n: number, ox: number, oz: number): Unit[] {
  const out: Unit[] = [];
  for (let i = 0; i < n; i++) {
    const ang = (i / Math.max(1, n)) * Math.PI * 2;
    const x = ox + Math.cos(ang) * (2.4 + (i % 3) * 0.5);
    const z = oz + Math.sin(ang) * (2.4 + (i % 3) * 0.5);
    out.push(sim.addUnit(BLUE, "walker", sim.world.walkableAt(x, z) ? x : ox + 2, sim.world.walkableAt(x, z) ? z : oz + 2));
  }
  return out;
}

/** 找一块可落基的茅屋点（模拟玩家在 UI 里点到合法格）。 */
function hutSpot(sim: Sim, ox: number, oz: number): { x: number; z: number } {
  for (let r = 3; r <= 14; r += 0.5) {
    for (let a = 0; a < 32; a++) {
      const ang = (a / 32) * Math.PI * 2;
      const x = Math.round((ox + Math.cos(ang) * r) * 2) / 2;
      const z = Math.round((oz + Math.sin(ang) * r) * 2) / 2;
      if (!inMap(x, z)) continue;
      if (sim.canFound(x, z, 1, 0, 0, "hut")) return { x, z };
    }
  }
  throw new Error("找不到可落基的茅屋点");
}

function selectOnly(sim: Sim, crew: Unit[]): void {
  for (const u of sim.units) u.selected = false;
  for (const u of crew) u.selected = true;
}

function crewOf(sim: Sim, site: Building): Unit[] {
  return sim.units.filter((u) => u.team === BLUE && u.buildId === site.id && u.hp > 0 && u.homeId === 0);
}

// ── T1：选中里没有村民（例如选了士兵）→ 返回 0 且工地不再变僵尸 ──────────
function testNoWalkerSelected(): void {
  const sim = new Sim(new World(42));
  const pad = bluePad(sim);
  const walkers = spawnWalkers(sim, 6, pad.x, pad.z);
  for (const u of walkers) u.job = "move"; // 全部在跑动（非空闲），且都不是被选中者
  const soldier = sim.addUnit(BLUE, "warrior", pad.x + 2, pad.z + 2);
  const spot = hutSpot(sim, pad.x, pad.z);
  const site = sim.foundSite(BLUE, spot.x, spot.z, 0, "hut")!;
  selectOnly(sim, [soldier]);
  const crew = sim.assignBuilders(BLUE, site);
  assert(crew === 0, `选中里只有士兵 → 实际指派 0 人（实际 ${crew}；旧实现无返回值、静默）`);
  assert(site.level === 0, "刚落地是 L0 工地");

  // 叫回村民（空闲下来）→ 看门狗应自动召人并建成
  for (const u of walkers) {
    u.job = "idle";
    u.path = [];
    u.pathI = 0;
  }
  play(sim, 150);
  assert(crewOf(sim, site).length === 0 || site.level >= 1, "工地不应停留在\"有建工但永不完工\"的状态");
  assert(site.level >= 1, `无建工的工地应被看门狗自动接上并完工（实际 L${site.level} wood ${site.wood}/${site.need}）`);
  console.log("testNoWalkerSelected ok");
}

// ── T2：选中屋顶住户当建工 → 必须先被叫出屋子（否则被 thinkUnits 整体跳过）──
function testDwellingCrewComesOut(): void {
  const sim = new Sim(new World(42));
  const pad = bluePad(sim);
  const hut = sim.buildings.find((b) => b.team === BLUE && b.kind === "hut" && b.level >= 1)!;
  const extra = spawnWalkers(sim, 6, pad.x, pad.z);
  let inside = 0;
  for (const u of extra) {
    if (inside >= 2) break;
    if (sim.occupy(u, hut)) inside++;
  }
  sim.tick(0.05);
  const dwellers = sim.units.filter((u) => u.team === BLUE && u.kind === "walker" && u.homeId > 0 && u.hp > 0);
  assert(dwellers.length >= 2, `至少 2 名住户（实际 ${dwellers.length}）`);
  const spot = hutSpot(sim, pad.x + 6, pad.z + 6);
  const site = sim.foundSite(BLUE, spot.x, spot.z, 0, "hut")!;
  selectOnly(sim, dwellers);
  const crew = sim.assignBuilders(BLUE, site);
  assert(crew === dwellers.length, `住户也应被指派（实际 ${crew}/${dwellers.length}）`);
  assert(
    dwellers.every((u) => u.homeId === 0),
    `被指派的住户必须被叫出屋子（否则 homeId>0 会被 thinkUnits 整体跳过，永远走不到工地）`,
  );
  play(sim, 150);
  assert(site.level >= 1, `住户建工应把工地建成（实际 L${site.level} wood ${site.wood}/${site.need}）`);
  console.log("testDwellingCrewComesOut ok");
}

// ── T3：指派后再右键走位，不得让建工集体辞职（buildId 粘性）────────────
function testMoveOrderKeepsBuildId(): void {
  const sim = new Sim(new World(42));
  const pad = bluePad(sim);
  const walkers = spawnWalkers(sim, 6, pad.x, pad.z);
  const spot = hutSpot(sim, pad.x, pad.z);
  const site = sim.foundSite(BLUE, spot.x, spot.z, 0, "hut")!;
  const crew = walkers.slice(0, 2);
  selectOnly(sim, crew);
  sim.assignBuilders(BLUE, site);
  assert(crewOf(sim, site).length === 2, "两名建工已挂上 buildId");
  // 模拟玩家右键走位（sendMove 会走 clearOrders）
  sim.sendMove(crew[0]!, pad.x + 6, pad.z - 6);
  assert(
    crew[0]!.buildId === site.id,
    `右键走位不得清掉 buildId（实际 ${crew[0]!.buildId}）——旧实现在这里让建工集体辞职、工地永远停在半成品`,
  );
  play(sim, 150);
  assert(site.level >= 1, `走位过的建工仍应把工地建成（实际 L${site.level} wood ${site.wood}/${site.need}）`);
  console.log("testMoveOrderKeepsBuildId ok");
}

// ── T4：建工战死 → 看门狗补人 ────────────────────────────────────────────
function testCrewWipedIsReplaced(): void {
  const sim = new Sim(new World(42));
  const pad = bluePad(sim);
  const walkers = spawnWalkers(sim, 8, pad.x, pad.z);
  const spot = hutSpot(sim, pad.x + 5, pad.z);
  const site = sim.foundSite(BLUE, spot.x, spot.z, 0, "hut")!;
  const crew = walkers.slice(0, 2);
  selectOnly(sim, crew);
  sim.assignBuilders(BLUE, site);
  play(sim, 1);
  for (const u of crew) u.hp = 0; // 建工战死
  play(sim, 1);
  assert(crewOf(sim, site).length === 0, "建工已全灭，工地一度无人");
  play(sim, 150);
  assert(site.level >= 1, `建工战死后工地应被自动接上并完工（实际 L${site.level} wood ${site.wood}/${site.need}）`);
  console.log("testCrewWipedIsReplaced ok");
}

// ── T5：只剩一名空闲村民时不抢人（看门狗自限）──────────────────────────
function testWatchdogKeepsLastLaborer(): void {
  const sim = new Sim(new World(42));
  const pad = bluePad(sim);
  // 把开局两名村民住进茅屋（住户 homeId>0，看门狗候选池排除）；户外先只剩 1 名空闲村民
  const hut = sim.buildings.find((b) => b.team === BLUE && b.kind === "hut" && b.level >= 1)!;
  const starters = sim.units.filter((u) => u.team === BLUE && u.kind === "walker" && u.hp > 0);
  let inside = 0;
  for (const u of starters) {
    if (sim.occupy(u, hut)) inside++;
  }
  assert(inside >= 2, `开局村民应都住进茅屋（实际 ${inside}）`);
  sim.tick(0.05);
  const lonely = spawnWalkers(sim, 1, pad.x + 4, pad.z + 4)[0]!;
  const spot = hutSpot(sim, pad.x, pad.z);
  const site = sim.foundSite(BLUE, spot.x, spot.z, 0, "hut")!;
  // 单拍调用看门狗（不用 play：茅屋会在这段时间里生出新的空闲村民，前提就不成立了）
  const prod = sim.productionSystem as unknown as { lastSiteWatchdog: number; watchdogSites(s: Sim): void };
  prod.lastSiteWatchdog = -1e9;
  prod.watchdogSites(sim);
  assert(
    crewOf(sim, site).length === 0,
    `只有 1 名空闲村民时不得抽人（实际建工 ${crewOf(sim, site).length}）——只留最后一名劳力的村子会连砍柴的人都没有`,
  );
  assert(lonely.buildId === 0, "那名唯一的空闲村民应保持空闲");
  // 正面侧：补到 3 名空闲村民后看门狗应正常召人（证明它不是"永远不干活"）
  spawnWalkers(sim, 2, pad.x - 4, pad.z - 4);
  prod.lastSiteWatchdog = -1e9;
  prod.watchdogSites(sim);
  assert(crewOf(sim, site).length >= 1, "人手充足时看门狗应自动召人（自限不能变成彻底罢工）");
  console.log("testWatchdogKeepsLastLaborer ok");
}

// ── T6：工地完工/被拆后建工自动卸任（buildId 粘性不得变成永久纠缠）────────
function testCrewReleasedAfterFinish(): void {
  const sim = new Sim(new World(42));
  const pad = bluePad(sim);
  const walkers = spawnWalkers(sim, 6, pad.x, pad.z);
  const spot = hutSpot(sim, pad.x, pad.z);
  const site = sim.foundSite(BLUE, spot.x, spot.z, 0, "hut")!;
  const crew = walkers.slice(0, 2);
  selectOnly(sim, crew);
  sim.assignBuilders(BLUE, site);
  play(sim, 150);
  assert(site.level >= 1, "工地应完工");
  play(sim, 5); // 让卸任检查跑几拍
  assert(
    crew.every((u) => u.buildId === 0),
    `完工后建工应自动卸任（实际 ${crew.map((u) => u.buildId).join(",")}）`,
  );
  const released = crew.filter((u) => u.hp > 0 && u.homeId === 0);
  assert(
    released.every((u) => u.job !== "chop" || u.carry === 0),
    "卸任后不再为已完工的工地砍木",
  );
  console.log("testCrewReleasedAfterFinish ok");
}

// ── T7：木料不被别的工地抢走（“远处的工地永远收不到料”的核心 bug）───────
// 旧实现在 repathSettle 的扛木分支里一律改投 nearestNeedSite：只要附近另有缺木工地，
// 建工肩上的木头就会被近处的工地吸走，远处工地停在半成品。实测后果：玩家“房子死活建不起来”；
// AI 首个兵营 0/4 木头、整局训不出一个兵（6 次开平循环里有 1 次这种卡死）。
function testWoodNotStolenByNearerSite(): void {
  const sim = new Sim(new World(42));
  const pad = bluePad(sim);
  const walkers = spawnWalkers(sim, 6, pad.x, pad.z);
  // 远处工地 A（在森林那侧）与家门口的工地 B（更近、也在缺木）
  const near = hutSpot(sim, pad.x, pad.z);
  const siteB = sim.foundSite(BLUE, near.x, near.z, 0, "hut")!;
  const farSpot = hutSpot(sim, pad.x + 14, pad.z + 14);
  const siteA = sim.foundSite(BLUE, farSpot.x, farSpot.z, 0, "hut")!;
  const builder = walkers[0]!;
  selectOnly(sim, [builder]);
  sim.assignBuilders(BLUE, siteA);
  assert(builder.buildId === siteA.id, "建工挂到远处工地 A");
  // 让他在家门口伐木（这里离工地 B 更近）
  sim.sendMove(builder, siteB.x + 2, siteB.z + 2);
  builder.carry = 1; // 模拟“刚砍到一捆木”
  builder.job = "haul";
  builder.targetId = 0; // 刚砍完时 targetId 会被清空（这是吸走料的窗口）
  sim.tick(0.05);
  const drop = (sim as unknown as { woodDropSite(u: Unit): Building | null }).woodDropSite(builder);
  assert(drop !== null, "应能找到交付工地");
  assert(
    drop!.id === siteA.id,
    `手上有建工任务时必须交给自己那座工地 A#${siteA.id}，而不是更近的 B#${siteB.id}（实际交到 #${drop!.id}）`,
  );
  // 交付完成后 A 拿到木料并推进/完工（关键是不再被 B 抢料而永远停在 0）
  play(sim, 60);
  assert(
    siteA.level >= 1 || siteA.wood > 0,
    `远处工地 A 应拿到木料并推进（实际 L${siteA.level} wood ${siteA.wood}/${siteA.need}）`,
  );
  console.log("testWoodNotStolenByNearerSite ok");
}

testNoWalkerSelected();
testDwellingCrewComesOut();
testMoveOrderKeepsBuildId();
testCrewWipedIsReplaced();
testWatchdogKeepsLastLaborer();
testCrewReleasedAfterFinish();
testWoodNotStolenByNearerSite();
console.log("build-site-check ok (v0.38 建房链路：无建工不再僵尸/住户被叫出/走位不辞职/战死自动补人/保底不抢劳力/木料不被抢)");
