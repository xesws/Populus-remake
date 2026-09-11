/**
 * v0.40 修理与破损停机回归锁（`npm run check` 新增项）：
 *   破损停机：进骨架的茅屋/训练营/哨塔/龙厂/船屋立即停功能（生产/训练/射击/孵化/造船全冻），
 *     哨塔驻军在破损瞬间弹出，不再收新住户/驻军/驻厂员；
 *   修理：选中村民右键破损建筑＝派修（3 人上限）；没木先砍、扛木开修，
 *     1 捆木＝8 秒工时；满血清骨架、全员卸任；移动令/建筑被拆＝中断；
 *   红方：整脑运行时会派自由村民自修；
 *   重生点：可破损可修；codec 里 job repair＋atkCd 来回不断。
 */
import { Sim } from "./sim";
import { World } from "./world";
import { nearestLand } from "./path";
import { BLUE, RED, BOATHOUSE_DWELL, DRAGON_GARRISON_MAX, REPAIR_CREW_MAX } from "./types";
import { applyBuildingDamage } from "./damage";
import { AIDirector } from "./ai/ai-director";
import { AIProfile } from "./ai/ai-profile";
import { encodeSnapshot, applySnapshot, createSimMirror } from "./worker/codec";

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

/** 干地落点（v0.39 水规则后地面单位不可下水，测试落点必须纠偏）。 */
function onLand(sim: Sim, x: number, z: number): { x: number; z: number } {
  if (sim.world.walkableAt(x, z)) return { x, z };
  return nearestLand(sim.world, x, z) ?? { x, z };
}

function shellIt(sim: Sim, id: number): void {
  const b = sim.buildingById(id)!;
  applyBuildingDamage(sim, b, 99999);
  assert(b.shell && b.hp > 0, "应进骨架（hp>0 的破损态，不是摧毁）");
}

function testShellHaltsHut(): void {
  const sim = new Sim(new World(42));
  const sp = sim.world.startPad(BLUE);
  const hut = sim.placeComplete(BLUE, sp.x + 2, sp.z + 2, 0, "hut", 1);
  sim.completeStep(hut);
  hut.dwell = 2;
  hut.prod = 0.3;
  shellIt(sim, hut.id);
  const prod = hut.prod;
  const born = hut.born;
  for (let i = 0; i < 100; i++) sim.tick(0.05);
  assert(hut.prod === prod && hut.born === born, `骨架茅屋应停产（prod ${prod}→${hut.prod}）`);
  console.log("testShellHaltsHut ok");
}

function testShellHaltsCamp(): void {
  const sim = new Sim(new World(42));
  const sp = sim.world.startPad(RED);
  const camp = sim.placeComplete(RED, sp.x + 2, sp.z + 2, 0, "warriorHut", 1);
  sim.completeStep(camp);
  const p = onLand(sim, camp.x + 4, camp.z);
  const w = sim.addUnit(RED, "walker", p.x, p.z);
  assert(sim.train(RED, "warrior"), "训兵应接单");
  assert(w.job === "train", "红村民应进训练队列");
  shellIt(sim, camp.id);
  for (let i = 0; i < 20; i++) sim.tick(0.05);
  assert(w.job !== "train", "营被打成骨架后排队者应释放");
  assert(!sim.train(RED, "warrior"), "骨架营不应再接新兵");
  const founded = sim.units.some((u) => u.team === RED && u.foundKind === "warriorHut");
  assert(!founded, "只是被打烂、不应另起新营（covered 含骨架）");
  console.log("testShellHaltsCamp ok");
}

function testTowerEject(): void {
  const sim = new Sim(new World(42));
  const sp = sim.world.startPad(BLUE);
  const tower = sim.placeComplete(BLUE, sp.x + 2, sp.z + 2, 0, "tower", 1);
  sim.completeStep(tower);
  const p = onLand(sim, tower.x + 2, tower.z);
  const f = sim.addUnit(BLUE, "firewarrior", p.x, p.z);
  f.homeId = tower.id; // 已驻塔（爬塔链路 tower-garrison-check 已覆盖，这里只测弹出）
  shellIt(sim, tower.id);
  assert(f.homeId === 0, "哨塔进骨架瞬间应弹出驻军");
  console.log("testTowerEject ok");
}

function testFactoryBoatHalt(): void {
  const sim = new Sim(new World(42));
  const sp = sim.world.startPad(BLUE);
  const f = sim.placeComplete(BLUE, sp.x + 2, sp.z + 2, 0, "dragonFactory", 1);
  sim.completeStep(f);
  f.dwell = DRAGON_GARRISON_MAX;
  f.prod = 0.5;
  shellIt(sim, f.id);
  for (let i = 0; i < 60; i++) sim.tick(0.05);
  assert(f.prod === 0.5, "骨架工厂应停孵（进度冻结）");
  const p = onLand(sim, f.x + 4, f.z);
  const fw = sim.addUnit(BLUE, "firewarrior", p.x, p.z);
  fw.targetId = f.id;
  assert(!sim.dragonSystem.tryEnterFactory(sim, fw), "骨架工厂不应收新驻员");
  const bh = sim.placeComplete(BLUE, sp.x - 4, sp.z, 0, "boathouse", 1);
  sim.completeStep(bh);
  bh.dwell = BOATHOUSE_DWELL;
  bh.prod = 0.5;
  shellIt(sim, bh.id);
  for (let i = 0; i < 60; i++) sim.tick(0.05);
  assert(bh.prod === 0.5, "骨架船屋应停产（进度冻结）");
  console.log("testFactoryBoatHalt ok");
}

function testRepairOrder(): void {
  const sim = new Sim(new World(42));
  const sp = sim.world.startPad(BLUE);
  const hut = sim.placeComplete(BLUE, sp.x + 2, sp.z + 2, 0, "hut", 1);
  sim.completeStep(hut);
  shellIt(sim, hut.id);
  const crew: number[] = [];
  for (let i = 0; i < 5; i++) {
    const p = onLand(sim, hut.x + 3 + i * 0.5, hut.z + 1);
    const u = sim.addUnit(BLUE, "walker", p.x, p.z);
    u.selected = true;
    crew.push(u.id);
  }
  const n = sim.orderRepair(BLUE, hut.id);
  assert(n === REPAIR_CREW_MAX, `派修应卡 3 人上限（得 ${n}）`);
  const repairing = sim.units.filter((u) => crew.includes(u.id) && u.job === "repair");
  assert(repairing.length === 3, "3 人应挂修理工身份");
  assert(repairing.every((u) => u.repairId === hut.id && u.targetId === hut.id), "身份应对准破损建筑");
  // 右键链路：orderMove 点破损建筑＝派修（game.ts secondary 经此进入）。
  for (const u of sim.units) {
    u.selected = false;
    if (u.job === "repair") {
      u.job = "idle";
      u.targetId = 0;
      u.repairId = 0;
    }
  }
  const solo = sim.units.find((u) => crew.includes(u.id))!;
  solo.selected = true;
  sim.orderMove(BLUE, hut.x, hut.z);
  assert(solo.job === "repair" && solo.repairId === hut.id, "右键破损建筑应派修而非入住");
  console.log("testRepairOrder ok");
}

function testRepairLoop(): void {
  const sim = new Sim(new World(42));
  const sp = sim.world.startPad(BLUE);
  const hut = sim.placeComplete(BLUE, sp.x + 2, sp.z + 2, 0, "hut", 1);
  sim.completeStep(hut);
  shellIt(sim, hut.id);
  const hp0 = hut.hp;
  const p1 = onLand(sim, hut.x + 3, hut.z);
  const p2 = onLand(sim, hut.x - 3, hut.z);
  const w1 = sim.addUnit(BLUE, "walker", p1.x, p1.z); // 空手：先砍后修
  const w2 = sim.addUnit(BLUE, "walker", p2.x, p2.z);
  w2.carry = 1; // 扛木：直接开修
  // 阶段一：只派空手的 w1——应先砍一捆木（不等别人修完，隔离断言）。
  sim.assignRepairers(BLUE, hut, [w1]);
  let chopped = false;
  for (let i = 0; i < 1200 && !chopped; i++) {
    sim.tick(0.05);
    if (w1.carry === 1) chopped = true;
  }
  assert(chopped, "空手修理工应先去砍一捆木");
  // 阶段二：再派扛木的 w2——两人合修至满血清骨架。
  sim.assignRepairers(BLUE, hut, [w2]);
  for (let i = 0; i < 2400 && hut.shell; i++) sim.tick(0.05);
  assert(!hut.shell && hut.hp >= hut.maxHp, `应修满清骨架（hp ${hp0}→${hut.hp}/${hut.maxHp}）`);
  assert(w1.job === "idle" && w2.job === "idle", "修完应全员卸任");
  console.log("testRepairLoop ok");
}

function testRepairInterrupt(): void {
  const sim = new Sim(new World(42));
  const sp = sim.world.startPad(BLUE);
  const hut = sim.placeComplete(BLUE, sp.x + 2, sp.z + 2, 0, "hut", 1);
  sim.completeStep(hut);
  shellIt(sim, hut.id);
  const p = onLand(sim, hut.x + 3, hut.z);
  const w = sim.addUnit(BLUE, "walker", p.x, p.z);
  w.carry = 1;
  sim.assignRepairers(BLUE, hut, [w]);
  assert(w.job === "repair", "应先挂上修理");
  const q = onLand(sim, hut.x + 8, hut.z + 5);
  sim.sendMove(w, q.x, q.z); // 移动令中断
  assert(w.job !== "repair" && w.repairId === 0, "移动令应卸任修理工");
  // 建筑被拆中断
  sim.assignRepairers(BLUE, hut, [w]);
  hut.hp = 0;
  for (let i = 0; i < 10; i++) sim.tick(0.05);
  assert(w.job !== "repair", "建筑没了应卸任");
  console.log("testRepairInterrupt ok");
}

function testRedRepairs(): void {
  const sim = new Sim(new World(42));
  const dir = new AIDirector([[RED, AIProfile.normal()]]);
  dir.attach(sim);
  const sp = sim.world.startPad(RED);
  const camp = sim.placeComplete(RED, sp.x + 2, sp.z + 2, 0, "warriorHut", 1);
  sim.completeStep(camp);
  shellIt(sim, camp.id);
  // 塞 3 个确定空闲的红村民（绕开 AI 经济指派的不确定性，只测派修本身）
  for (let i = 0; i < 3; i++) {
    const p = onLand(sim, camp.x + 4 + i, camp.z + 1);
    sim.addUnit(RED, "walker", p.x, p.z);
  }
  for (let i = 0; i < 600; i++) {
    sim.tick(0.05);
    sim.winner = null;
    dir.update(sim, 0.05);
    if (sim.units.some((u) => u.team === RED && u.job === "repair" && u.repairId === camp.id)) break;
  }
  assert(
    sim.units.some((u) => u.team === RED && u.job === "repair" && u.repairId === camp.id),
    "红方应派自由村民修理自家破损营",
  );
  console.log("testRedRepairs ok");
}

function testRebirthShellRepair(): void {
  const sim = new Sim(new World(42));
  const rb = sim.buildings.find((b) => b.team === BLUE && b.kind === "rebirth" && b.hp > 0);
  assert(rb, "开局应有蓝方再生点");
  applyBuildingDamage(sim, rb!, 99999);
  assert(rb!.shell, "再生点应可进骨架");
  const p = onLand(sim, rb!.x + 3, rb!.z);
  const w = sim.addUnit(BLUE, "walker", p.x, p.z);
  w.carry = 1;
  sim.assignRepairers(BLUE, rb!, [w]);
  for (let i = 0; i < 1200 && rb!.shell; i++) sim.tick(0.05);
  assert(!rb!.shell && rb!.hp >= rb!.maxHp, "再生点应可修满");
  console.log("testRebirthShellRepair ok");
}

function testCodecRepair(): void {
  const sim = new Sim(new World(42));
  const sp = sim.world.startPad(BLUE);
  const hut = sim.placeComplete(BLUE, sp.x + 2, sp.z + 2, 0, "hut", 1);
  sim.completeStep(hut);
  shellIt(sim, hut.id);
  const p = onLand(sim, hut.x + 3, hut.z);
  const w = sim.addUnit(BLUE, "walker", p.x, p.z);
  w.carry = 1;
  sim.assignRepairers(BLUE, hut, [w]);
  w.atkCd = 0.7;
  const mirror = createSimMirror();
  applySnapshot(mirror, encodeSnapshot(sim));
  const mw = mirror.units.find((u) => u.id === w.id)!;
  assert(mw.job === "repair", `镜像 job 应保留 repair（得 ${mw.job}）`);
  assert(Math.abs(mw.atkCd - 0.7) < 0.01, `镜像 atkCd 应保留（得 ${mw.atkCd}，挥砍/蓄力动画靠它）`);
  console.log("testCodecRepair ok");
}

testShellHaltsHut();
testShellHaltsCamp();
testTowerEject();
testFactoryBoatHalt();
testRepairOrder();
testRepairLoop();
testRepairInterrupt();
testRedRepairs();
testRebirthShellRepair();
testCodecRepair();
console.log("repair-check ok (v0.40 破损停机/修理/红方自修/重生点/codec)");
