import { Sim } from "./sim";
import { BLUE, damageAfterArmor, houseHp, RED } from "./types";
import { World } from "./world";

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

function stubRandom(v: number): () => number {
  const orig = Math.random;
  Math.random = () => v;
  return orig;
}

// v0.9 火球机制：射程内发射、地形遮挡（发射端 LOS + 飞行撞地）、命中概率击退/原地击飞、击飞落地伤害。

function fireAndHit(sim: Sim, dt = 0.05): void {
  sim.combat(dt);
  assert(sim.shots.length === 1, "火球已发射");
  for (let i = 0; i < 100 && sim.shots.length; i++) sim.projectiles(dt);
  assert(sim.shots.length === 0, "火球已结算消失");
}

function testLaunchAndPlainHit(): void {
  const sim = new Sim(new World(42));
  const fire = sim.addUnit(BLUE, "firewarrior", 20, 20);
  const foe = sim.addUnit(RED, "warrior", 22, 20); // 距离 2 < 射程 4.5
  fire.atkId = foe.id;
  fire.order = "fight";
  const full = foe.hp; // 12

  const orig = stubRandom(0.99); // > 0.4+0.2：纯伤害
  try {
    fireAndHit(sim);
  } finally {
    Math.random = orig;
  }
  const dmg = damageAfterArmor("firewarrior", "warrior"); // 5-2=3
  assert(Math.abs(foe.hp - (full - dmg)) < 1e-6, `纯伤害命中：火球经统一结算入口扣 ${dmg} 血`);
  assert(foe.flyVy === 0 && foe.flyDmg === 0, "纯伤害不击飞");
  assert(Math.abs(foe.x - 22) < 1e-6, "纯伤害不位移");
  assert(fire.atkId === foe.id, "目标存活攻击者保持目标");

  console.log("testLaunchAndPlainHit ok");
}

function testLosBlocksLaunch(): void {
  const sim = new Sim(new World(42));
  const fire = sim.addUnit(BLUE, "firewarrior", 20, 20);
  const foe = sim.addUnit(RED, "warrior", 23, 20); // 距离 3 < 射程 4.5
  fire.atkId = foe.id;
  fire.order = "fight";

  // 中途抬一座高于弹道线的山
  assert(sim.world.sculpt(21.5, 20, 0.9, 5), "地形已抬升");
  assert(sim.world.losBlocked(20, 20, 23, 20), "losBlocked 判定被山遮挡");
  sim.combat(0.05);
  sim.combat(0.05);
  assert(sim.shots.length === 0, "视线被遮挡时不发射火球");
  assert(fire.atkId === foe.id, "目标保持，继续贴近寻找射界");

  // 铲平山后恢复发射
  assert(sim.world.sculpt(21.5, 20, 0.9, -5), "地形已铲平");
  assert(!sim.world.losBlocked(20, 20, 23, 20), "losBlocked 判定恢复通畅");
  sim.combat(0.05);
  assert(sim.shots.length === 1, "视线通畅后正常发射");

  console.log("testLosBlocksLaunch ok");
}

function testMidFlightTerrainCrash(): void {
  const sim = new Sim(new World(42));
  const fire = sim.addUnit(BLUE, "firewarrior", 20, 20);
  const foe = sim.addUnit(RED, "warrior", 22, 20);
  fire.atkId = foe.id;
  fire.order = "fight";
  const full = foe.hp;

  sim.combat(0.05);
  assert(sim.shots.length === 1, "火球已发射");
  // 火球飞行途中在弹道线上抬山：下一步即撞地熄灭
  assert(sim.world.sculpt(21, 20, 0.6, 6), "飞行途中抬升地形");
  for (let i = 0; i < 6 && sim.shots.length; i++) sim.projectiles(0.05);
  assert(sim.shots.length === 0, "火球撞上中途抬高的地形熄灭");
  assert(foe.hp === full, "熄灭的火球不造成伤害");

  console.log("testMidFlightTerrainCrash ok");
}

function testKnockbackOnHit(): void {
  const sim = new Sim(new World(42));
  const fire = sim.addUnit(BLUE, "firewarrior", 20, 20);
  const foe = sim.addUnit(RED, "warrior", 22, 20);
  fire.atkId = foe.id;
  fire.order = "fight";
  const full = foe.hp;

  const orig = stubRandom(0.1); // < 0.4：击退
  try {
    fireAndHit(sim);
  } finally {
    Math.random = orig;
  }
  assert(foe.hp < full, "击退命中同样结算伤害");
  assert(foe.x > 22.5, `被沿弹向击退（x=${foe.x.toFixed(2)} > 22.5）`);
  assert(foe.flyVy === 0, "击退不是击飞");

  console.log("testKnockbackOnHit ok");
}

function testKnockupAndLandingDamage(): void {
  const sim = new Sim(new World(42));
  const fire = sim.addUnit(BLUE, "firewarrior", 20, 20);
  const foe = sim.addUnit(RED, "warrior", 22, 20);
  fire.atkId = foe.id;
  fire.order = "fight";
  const full = foe.hp;

  const orig = stubRandom(0.5); // 0.4 <= r < 0.6：原地击飞
  try {
    fireAndHit(sim);
  } finally {
    Math.random = orig;
  }
  const hitDmg = damageAfterArmor("firewarrior", "warrior");
  assert(foe.flyVy > 0, "原地击飞：获得垂直速度");
  assert(foe.flyDmg === 2, "击飞附带落地伤害标记");
  assert(foe.y > sim.world.heightAt(foe.x, foe.z), "单位腾空");

  fire.atkId = 0; // 停止后续攻击，观察落地
  for (let i = 0; i < 200 && foe.flyVy !== 0; i++) sim.tick(0.05);
  assert(foe.flyVy === 0, "单位已落地");
  assert(foe.flyDmg === 0, "落地伤害标记已清零");
  // 落地伤害 = max(1, 2 - 护甲2) = 1
  assert(Math.abs(foe.hp - (full - hitDmg - 1)) < 1e-6, "落地瞬间结算落地伤害（经护甲）");

  console.log("testKnockupAndLandingDamage ok");
}

function testFlyingUnitsNotMeleed(): void {
  const sim = new Sim(new World(42));
  const warrior = sim.addUnit(BLUE, "warrior", 20, 20);
  const foe = sim.addUnit(RED, "warrior", 20.5, 20);
  warrior.atkId = foe.id;
  warrior.order = "fight";
  const full = foe.hp;

  // 目标腾空：近战与火球都打不到
  foe.flyVy = 5;
  foe.y = sim.world.heightAt(foe.x, foe.z) + 1;
  sim.combat(0.05);
  sim.combat(0.05);
  assert(foe.hp === full, "腾空目标不被近战命中");
  assert(warrior.atkCd === 0, "攻击者未出刀（等待落地）");
  assert(warrior.atkId === foe.id, "目标保持不变");

  // 攻击者自己也腾空时同样无法出刀
  warrior.atkId = foe.id;
  foe.flyVy = 0;
  foe.y = sim.world.heightAt(foe.x, foe.z);
  warrior.flyVy = 4;
  warrior.y = sim.world.heightAt(warrior.x, warrior.z) + 0.5;
  sim.combat(0.05);
  assert(foe.hp === full, "腾空攻击者无法出刀");

  console.log("testFlyingUnitsNotMeleed ok");
}

function testFireballVsBuilding(): void {
  const sim = new Sim(new World(42));
  const hut = sim.buildings.find((b) => b.team === RED && b.kind === "hut" && b.level === 1);
  assert(!!hut, "need red L1 hut");

  const fire = sim.addUnit(BLUE, "firewarrior", hut!.x, hut!.z + 4);
  fire.atkId = hut!.id;
  fire.order = "fight";
  const full = hut!.hp;
  assert(full === houseHp(1), "hut starts full");

  sim.combat(0.05);
  assert(sim.shots.length === 1, "对建筑远程发射火球");
  for (let i = 0; i < 100 && sim.shots.length; i++) sim.projectiles(0.05);
  assert(hut!.hp < full, "火球命中建筑造成伤害");

  console.log("testFireballVsBuilding ok");
}

function main(): void {
  testLaunchAndPlainHit();
  testLosBlocksLaunch();
  testMidFlightTerrainCrash();
  testKnockbackOnHit();
  testKnockupAndLandingDamage();
  testFlyingUnitsNotMeleed();
  testFireballVsBuilding();
  console.log("projectile-check ok (v0.9 火球弹道与命中效果)");
}

main();
