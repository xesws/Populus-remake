// v0.19 战斗机制与守卫命令测试：
// 自动战斗：武士 10 步索敌（含敌方大祭司）且不主动打建筑 / 牛头人自动拆建筑 / 间谍小范围索敌。
// 诏令：聚集散布 / 守卫全链路（篝火建于质心 → 跳舞回血 → 遇敌退出转 fight → 不自动回圈 → 重下令回圈）。
import { Sim } from "./sim";
import { BLUE, RED, Unit, UnitKind } from "./types";
import { World } from "./world";

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

/**
 * 找一块距红方单位 clearR 格外的可走空地——自动索敌只锁敌队（野人 NEUTRAL 不算），
 * 但红方老家单位会干扰断言，必须避开；野人/蓝方单位游荡无碍。
 */
function findClear(sim: Sim, x: number, z: number, clearR = 6): { x: number; z: number } {
  for (let r = 0; r < 26; r++) {
    for (let a = 0; a < 12; a++) {
      const cx = x + Math.cos((a / 12) * Math.PI * 2) * r * 1.4;
      const cz = z + Math.sin((a / 12) * Math.PI * 2) * r * 1.4;
      if (!sim.world.walkableAt(cx, cz)) continue;
      const clearOfRed = sim.units.every(
        (o) => o.team !== RED || (o.x - cx) ** 2 + (o.z - cz) ** 2 > clearR * clearR,
      );
      if (clearOfRed) return { x: cx, z: cz };
    }
  }
  return { x, z };
}

function testWarriorSight10(): void {
  for (const foeKind of ["walker", "shaman"] as UnitKind[]) {
    const sim = new Sim(new World(42));
    const at = findClear(sim, 20, 20);
    const warrior = sim.addUnit(BLUE, "warrior", at.x, at.z);
    const foe = sim.addUnit(RED, foeKind, at.x + 8, at.z); // 旧 sight 3.5 外、新 10 步内
    for (let i = 0; i < 100 && warrior.atkId === 0; i++) sim.tick(0.05);
    assert(warrior.atkId === foe.id, `武士 10 步内自动锁定敌方${foeKind === "shaman" ? "大祭司" : "村民"}`);
  }
  console.log("testWarriorSight10 ok");
}

function testWarriorIgnoresBuildings(): void {
  const sim = new Sim(new World(42));
  const at = findClear(sim, 24, 24, 13); // 13 格净空：确保 sight 内除测试建筑外无任何单位
  const warrior = sim.addUnit(BLUE, "warrior", at.x, at.z);
  // 敌方茅屋 4 格内（placeComplete 带地基——直接挪坐标会被 refreshHouses 判无地基而摧毁）、无敌方单位：
  const hut = sim.placeComplete(RED, at.x + 4, at.z, 0, "hut", 1)!;
  for (let i = 0; i < 100; i++) sim.tick(0.05);
  assert(warrior.atkId !== hut.id, "武士不主动攻击建筑");
  assert(warrior.atkId === 0, "无敌方单位时武士保持无目标");
  console.log("testWarriorIgnoresBuildings ok");
}

function testFirewarriorAutoAttacksBuildings(): void {
  const sim = new Sim(new World(42));
  const at = findClear(sim, 24, 24, 13); // 13 格净空：firewarrior sight 5.5，确保只看得见测试建筑
  const fire = sim.addUnit(BLUE, "firewarrior", at.x, at.z);
  const hut = sim.placeComplete(RED, at.x + 4.5, at.z, 0, "hut", 1)!; // sight 5.5 内、无敌方单位
  for (let i = 0; i < 100 && fire.atkId === 0; i++) sim.tick(0.05);
  assert(fire.atkId === hut.id, "牛头人自动锁定射程内敌方建筑（自动拆家）");
  console.log("testFirewarriorAutoAttacksBuildings ok");
}

function testSpyAutoAttacks(): void {
  const sim = new Sim(new World(42));
  const at = findClear(sim, 20, 20);
  const spy = sim.addUnit(BLUE, "spy", at.x, at.z);
  const foe = sim.addUnit(RED, "walker", at.x + 3, at.z); // sight 4 内
  for (let i = 0; i < 100 && spy.atkId === 0; i++) sim.tick(0.05);
  assert(spy.atkId === foe.id, "间谍 4 步内自动索敌");
  console.log("testSpyAutoAttacks ok");
}

function testGuardFullCycle(): void {
  const sim = new Sim(new World(42));
  sim.lockWin = true;
  // 清空红方单位（idle-check 同款手法）：红方村民的自主扩张/游荡会随机闯进守卫圈触发打断——
  // 那是守卫令的正确行为，但本用例的敌人必须由测试自己投放才可控。
  sim.units = sim.units.filter((u) => u.team !== RED);
  const at = findClear(sim, 24, 24, 13);
  const warrior = sim.addUnit(BLUE, "warrior", at.x, at.z);
  const villager = sim.addUnit(BLUE, "walker", at.x + 1.2, at.z);
  warrior.selected = true;
  villager.selected = true;

  // 下守卫令：篝火建于选中组质心，全员 order=guard。
  sim.setOrder(BLUE, "guard");
  assert(sim.guardFires.length === 1 && sim.guardFires[0]!.team === BLUE, "守卫令创建篝火");
  const fire = sim.guardFires[0]!;
  const cx = (warrior.x + villager.x) / 2;
  const cz = (warrior.z + villager.z) / 2;
  assert(Math.hypot(fire.x - cx, fire.z - cz) < 0.6, "篝火位于选中组质心");
  assert(warrior.order === "guard" && villager.order === "guard", "武士与村民都进入守卫（诏令对士兵生效）");

  // 跳舞回血：打残后圈内回血（村民同样受益）。
  warrior.hp = 5;
  villager.hp = 2;
  for (let i = 0; i < 80; i++) sim.tick(0.05); // 4s
  assert(warrior.hp > 5 + 1.5, `武士篝火回血（hp ${warrior.hp.toFixed(1)} > 6.5）`);
  assert(villager.hp > 2 + 1.5, `村民篝火同样回血（hp ${villager.hp.toFixed(1)} > 3.5）`);
  const danceR = Math.hypot(warrior.x - fire.x, warrior.z - fire.z);
  assert(danceR < 5, `武士留在篝火圈内跳舞（距篝火 ${danceR.toFixed(1)}）`);

  // 遇敌退出：敌人进入武士 10 步索敌 → guard 打断为 fight、停止自动回血。
  const foe = sim.addUnit(RED, "walker", fire.x + 8, fire.z);
  for (let i = 0; i < 120 && warrior.order === "guard"; i++) sim.tick(0.05);
  assert(warrior.order === "fight", "遇敌后守卫被打断转为战斗");
  assert(warrior.atkId === foe.id, "打断后锁定敌人");
  const hpAtBreak = warrior.hp;
  warrior.hp = Math.min(warrior.maxHp, warrior.hp - 3);
  for (let i = 0; i < 40; i++) sim.tick(0.05); // 2s：不再自动回血
  assert(warrior.hp < hpAtBreak + 0.5, "退出篝火后不再回血");

  // 敌灭后不自动回圈（仍 fight；观察窗短——fight 分支会持续把士兵压向远处敌营，跑远了重下令就测不到了）。
  foe.hp = 0;
  for (let i = 0; i < 30; i++) sim.tick(0.05);
  assert(warrior.order !== "guard", "战后不自动回篝火（需重新下令）");

  // 重新框选下令 → 回圈继续跳舞（红方已清场，无游荡干扰，绕圈稳定达成）。
  warrior.selected = true;
  sim.setOrder(BLUE, "guard");
  assert(warrior.order === "guard", "重新下令恢复守卫");
  for (let i = 0; i < 120; i++) sim.tick(0.05);
  const backR = Math.hypot(warrior.x - fire.x, warrior.z - fire.z);
  assert(backR < 5, `重新下令后武士回到篝火圈（距 ${backR.toFixed(1)}）`);

  console.log("testGuardFullCycle ok");
}

function testGatherFormation(): void {
  const sim = new Sim(new World(42));
  sim.lockWin = true;
  // 清红方与野人：只测聚集本身——武士 sight=10 会锁定游荡进范围的红方村民转去追击（正确行为，但干扰断言）。
  sim.units = sim.units.filter((u) => u.team === BLUE);
  const at = findClear(sim, 24, 24);
  const units: Unit[] = [];
  for (let i = 0; i < 4; i++) {
    const u = sim.addUnit(BLUE, i === 0 ? "warrior" : "walker", at.x + i * 2.5, at.z + (i % 2) * 2);
    u.selected = true;
    units.push(u);
  }
  sim.setMagnet(BLUE, at.x, at.z);
  sim.setOrder(BLUE, "gather");
  for (let i = 0; i < 300; i++) sim.tick(0.05); // 15s 行军集结（窗口放宽：野人游荡偶发挡路会拖慢单个单位）
  for (const u of units) {
    const d = Math.hypot(u.x - at.x, u.z - at.z);
    assert(d < 3.2, `聚集令：单位散布在 magnet 3 格内（实际 ${d.toFixed(1)}）`);
  }
  console.log("testGatherFormation ok");
}

testWarriorSight10();
testWarriorIgnoresBuildings();
testFirewarriorAutoAttacksBuildings();
testSpyAutoAttacks();
testGuardFullCycle();
testGatherFormation();
console.log("guard-check ok (v0.19 自动战斗扩展 / 守卫篝火 / 聚集散布)");
