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

function testFireballDefaultKnockdown(): void {
  const sim = new Sim(new World(42));
  const fire = sim.addUnit(BLUE, "firewarrior", 20, 20);
  const foe = sim.addUnit(RED, "warrior", 22, 20);
  fire.atkId = foe.id;
  fire.order = "fight";
  const full = foe.hp;

  const orig = stubRandom(0.99); // ≥ 0.2：走默认击退分支（击退方向由弹道决定，stub 只关掉暴击）
  try {
    fireAndHit(sim);
  } finally {
    Math.random = orig;
  }
  assert(foe.hp === full, "倒地瞬间不扣血（伤害延迟到站起）");
  assert(foe.downT > 0, "被火球命中后倒地");
  const moved = foe.x - 22; // 弹道 +x：击退应沿 +x（远离射手）
  assert(moved >= 0.7 && moved <= 1.2, `每发必沿弹道击退约一步（d=${moved.toFixed(2)}，朝远离射手方向）`);
  assert(foe.flyVy === 0 && !foe.flyKill, "默认命中不打飞");

  fire.atkId = 0; // 停火，观察站起结算
  for (let i = 0; i < 100 && foe.downT > 0; i++) sim.tick(0.05);
  assert(foe.downT === 0, "0.6s 后站起");
  assert(foe.downDmg === 0, "延迟伤害已清零");
  assert(
    Math.abs(foe.hp - (full - damageAfterArmor("firewarrior", "warrior"))) < 1e-6,
    "站起瞬间结算伤害（5 − 甲 2 = 3）"
  );

  console.log("testFireballDefaultKnockdown ok");
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

function testFireballCritLethalLaunch(): void {
  const sim = new Sim(new World(42));
  const fire = sim.addUnit(BLUE, "firewarrior", 20, 20);
  const foe = sim.addUnit(RED, "warrior", 22, 20);
  fire.atkId = foe.id;
  fire.order = "fight";
  const full = foe.hp;

  const orig = stubRandom(0.1); // < 0.2：暴击
  try {
    fireAndHit(sim);
  } finally {
    Math.random = orig;
  }
  assert(foe.flyVy > 0, "暴击真正打飞（获得垂直速度）");
  assert(foe.flyKill, "标记落地即死");
  assert(foe.y > sim.world.heightAt(foe.x, foe.z), "被抛到空中");
  assert(foe.hp === full, "击飞瞬间不结算伤害（落地才死）");

  fire.atkId = 0;
  for (let i = 0; i < 200 && foe.flyVy !== 0; i++) sim.tick(0.05);
  assert(foe.flyVy === 0, "已落地");
  assert(foe.hp <= 0, "暴击击飞：摔下来直接死亡");
  assert(!foe.flyKill, "标记已复位");

  console.log("testFireballCritLethalLaunch ok");
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
  testFireballDefaultKnockdown();
  testFireballCritLethalLaunch();
  testLosBlocksLaunch();
  testMidFlightTerrainCrash();
  testFlyingUnitsNotMeleed();
  testFireballVsBuilding();
  console.log("projectile-check ok (v0.12 火球：倒地延迟扣血 / 暴击致死击飞)");
}

main();
