import { Sim } from "./sim";
import { BLUE, houseHp, RED } from "./types";
import { World } from "./world";

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

function testWarriorVsEnemyMelee(): void {
  const sim = new Sim(new World(42));
  const warrior = sim.addUnit(BLUE, "warrior", 20, 20);
  const enemy = sim.addUnit(RED, "walker", 20.5, 20);
  warrior.atkId = enemy.id;
  warrior.order = "fight";

  const initialHp = enemy.hp;
  // Sim combat for 1 second (damage rate is 2.2/s)
  sim.combat(1.0);

  assert(enemy.hp < initialHp, "enemy took melee damage from warrior");
  assert(Math.abs(enemy.hp - (initialHp - 2.2)) < 1e-4, `enemy hp matches expected dmg, got ${enemy.hp}`);

  // Sim until enemy dies
  while (enemy.hp > 0) {
    sim.combat(0.5);
  }

  assert(enemy.hp <= 0, "enemy unit is killed");
  assert(warrior.atkId === 0, "warrior clears atkId after killing enemy");

  console.log("testWarriorVsEnemyMelee ok");
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
  testWarriorVsEnemyMelee();
  testHutDamageSkeletonAndDestruction();
  testOrderAttackTarget();
  console.log("combat-check ok");
}

main();
