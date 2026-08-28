import { Sim } from "./sim";
import { attackInterval, BLUE, damageAfterArmor, houseHp, RED, unitDamageToBuilding } from "./types";
import { World } from "./world";

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

// v0.7 数值与伤害判定体系：护甲、克制、攻击间隔单发结算。

function testWarriorTwoHitsKillFirewarrior(): void {
  const sim = new Sim(new World(42));
  const warrior = sim.addUnit(BLUE, "warrior", 20, 20);
  const foe = sim.addUnit(RED, "firewarrior", 20.5, 20);
  warrior.atkId = foe.id;
  warrior.order = "fight";

  const full = foe.hp;
  sim.combat(0.05);
  assert(
    Math.abs(foe.hp - (full - damageAfterArmor("warrior", "firewarrior"))) < 1e-6,
    "首刀伤害 = 攻击 - 护甲（经统一结算入口）"
  );
  assert(foe.hp > 0, "火战士（9 血）第一刀不死");

  sim.combat(attackInterval("warrior") + 0.01);
  assert(foe.hp <= 0, "武士两刀解决火战士（克制关系）");
  assert(warrior.atkId === 0, "击杀后清 atkId");

  console.log("testWarriorTwoHitsKillFirewarrior ok");
}

function testWarriorOneHitKillsWalker(): void {
  const sim = new Sim(new World(42));
  const warrior = sim.addUnit(BLUE, "warrior", 20, 20);
  const villager = sim.addUnit(RED, "walker", 20.5, 20);
  warrior.atkId = villager.id;
  warrior.order = "fight";

  sim.combat(0.05);
  assert(villager.hp <= 0, "武士攻击远高于平民：一刀带走村民（6 血）");

  console.log("testWarriorOneHitKillsWalker ok");
}

function testArmorReducesDamage(): void {
  const sim = new Sim(new World(42));
  const attacker = sim.addUnit(RED, "walker", 20, 20);
  const preacher = sim.addUnit(BLUE, "preacher", 20.4, 20); // 护甲 1
  attacker.atkId = preacher.id;
  attacker.order = "fight";

  const before = preacher.hp;
  sim.combat(0.05);
  assert(
    Math.abs(preacher.hp - (before - damageAfterArmor("walker", "preacher"))) < 1e-6,
    "护甲参与减伤：村民攻 2 打传教士甲 1，只掉 1 血"
  );

  console.log("testArmorReducesDamage ok");
}

function testCounterMultiplier(): void {
  const sim = new Sim(new World(42));
  const fire = sim.addUnit(RED, "firewarrior", 20, 20);
  const villager = sim.addUnit(BLUE, "walker", 20.4, 20);
  fire.atkId = villager.id;
  fire.order = "fight";

  // v0.9 起火战士远程发射火球：出刀后需推进弹道到命中。
  sim.combat(0.05);
  assert(sim.shots.length === 1, "火战士在射程内发射火球");
  while (sim.shots.length) sim.projectiles(0.05);
  assert(villager.hp <= 0, "克制系数表生效：火战士对村民 1.2 倍，一发火球 6 血带走");

  console.log("testCounterMultiplier ok");
}

function testAttackCooldownGating(): void {
  const sim = new Sim(new World(42));
  const spy = sim.addUnit(BLUE, "spy", 20, 20);
  const villager = sim.addUnit(RED, "walker", 20.4, 20);
  spy.atkId = villager.id;
  spy.order = "fight";

  sim.combat(0.05);
  assert(Math.abs(villager.hp - 3) < 1e-6, "间谍首刀 3 伤（村民 6 血剩 3）");
  sim.combat(0.05);
  assert(Math.abs(villager.hp - 3) < 1e-6, "攻击间隔内不出第二刀");
  sim.combat(attackInterval("spy") + 0.01);
  assert(villager.hp <= 0, "冷却结束第二刀击杀");

  console.log("testAttackCooldownGating ok");
}

function testHutDamageSkeletonAndDestruction(): void {
  const sim = new Sim(new World(42));
  const hut = sim.buildings.find((b) => b.team === RED && b.kind === "hut" && b.level === 1);
  assert(!!hut, "need red L1 hut");
  assert(hut!.hp === houseHp(1), "hut starts at full L1 hp");
  assert(!hut!.shell, "hut starts not in skeleton stage");

  const warrior = sim.addUnit(BLUE, "warrior", hut!.x, hut!.z + 1.2);
  warrior.atkId = hut!.id;
  warrior.order = "fight";
  const hit = unitDamageToBuilding("warrior");
  assert(hit === 4, "拆屋伤害 = 攻击 × 0.6（武士 4/刀）");

  // Simulate combat ticks until hut reaches skeleton (shell) stage
  let reachedSkeleton = false;
  for (let i = 0; i < 150; i++) {
    sim.tick(0.05);
    if (hut!.shell) {
      reachedSkeleton = true;
      break;
    }
  }

  assert(reachedSkeleton, "hut transitions into skeleton (shell) stage when hp depleted");
  assert(hut!.shell, "hut.shell is true");
  assert(hut!.hp <= hut!.maxHp * 0.5, "hut hp in skeleton stage is <= maxHp / 2");
  assert(hut!.hp > 0, "hut still alive in skeleton stage");

  // Continue combat until hut is fully destroyed (hp <= 0)
  let destroyed = false;
  for (let i = 0; i < 200; i++) {
    sim.tick(0.05);
    if (hut!.hp <= 0) {
      destroyed = true;
      break;
    }
  }

  assert(destroyed, "house is completely destroyed after skeleton stage hp depleted");
  assert(hut!.hp <= 0, "hut hp is <= 0");
  assert(warrior.atkId === 0, "warrior clears atkId after destroying building");

  console.log("testHutDamageSkeletonAndDestruction ok");
}

function testOrderAttackTarget(): void {
  const sim = new Sim(new World(42));
  const hut = sim.buildings.find((b) => b.team === RED && b.kind === "hut" && b.level === 1);
  assert(!!hut, "need red L1 hut");

  const warrior = sim.addUnit(BLUE, "warrior", 15, 15);
  warrior.selected = true;

  sim.orderAttackTarget(BLUE, hut!);
  assert(warrior.atkId === hut!.id, "warrior assigned atkId of target building");
  assert(warrior.order === "fight", "warrior order set to fight");
  assert(warrior.job === "move", "warrior moves towards target");

  console.log("testOrderAttackTarget ok");
}

function main(): void {
  testWarriorTwoHitsKillFirewarrior();
  testWarriorOneHitKillsWalker();
  testArmorReducesDamage();
  testCounterMultiplier();
  testAttackCooldownGating();
  testHutDamageSkeletonAndDestruction();
  testOrderAttackTarget();
  console.log("combat-check ok (v0.7 数值与伤害判定)");
}

main();
