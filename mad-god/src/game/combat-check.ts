import { Sim } from "./sim";
import { attackInterval, BLUE, damageAfterArmor, FIREBALL_SPEED, houseHp, RED, unitDamageToBuilding, unitHp } from "./types";
import { World } from "./world";

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

function stubRandom(v: number): () => number {
  const orig = Math.random;
  Math.random = () => v;
  return orig;
}

// v0.7 数值与伤害判定体系：护甲、克制、攻击间隔单发结算。

function testWarriorTwoHitsKillFirewarrior(): void {
  const sim = new Sim(new World(42));
  const warrior = sim.addUnit(BLUE, "warrior", 20, 20);
  const foe = sim.addUnit(RED, "firewarrior", 20.5, 20);
  warrior.atkId = foe.id;
  warrior.order = "fight";

  const full = foe.hp;
  const orig = stubRandom(0.99); // v0.12：≥ 0.5 无暴击，锁定普攻数值
  try {
    sim.combat(0.05);
    assert(
      Math.abs(foe.hp - (full - damageAfterArmor("warrior", "firewarrior"))) < 1e-6,
      "首刀伤害 = 攻击 - 护甲（经统一结算入口）"
    );
    assert(foe.hp > 0, "火战士（9 血）第一刀不死");

    sim.combat(attackInterval("warrior") + 0.01);
  } finally {
    Math.random = orig;
  }
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

  // v0.12 起火球默认命中为倒地延迟扣血；伤害在站起瞬间经克制结算。
  // v0.28a 每发必击退：沿弹道方向（远离射手）推 ~1 格 + 短暂倒地；弹速 4→5.2。
  assert(FIREBALL_SPEED === 5.2, "弹速提速 1.3×（4→5.2）");
  const orig = stubRandom(0.99); // 无暴击
  try {
    sim.combat(0.05);
    assert(sim.shots.length === 1, "火战士在射程内发射火球");
    while (sim.shots.length) sim.projectiles(0.05);
  } finally {
    Math.random = orig;
  }
  assert(villager.downT > 0 && villager.hp > 0, "默认命中：倒地、伤害延迟到站起");
  const knocked = villager.x - 20.4;
  assert(knocked >= 0.7, `每发必沿弹道击退 ~1 格（沿 +x 推了 ${knocked.toFixed(2)}，朝远离射手方向）`);
  for (let i = 0; i < 100 && villager.downT > 0; i++) sim.tick(0.05);
  assert(villager.hp <= 0, "克制系数表生效：火战士对村民 ×1.2，站起结算 round(5×1.2)=6 直接带走");

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
  // v0.24 改走玩家真实的"点敌屋拆屋"指令链：orderAttackTarget 会先 sendMove 到 pad 边缘
  // 再挂 atkId。旧写法只挂 atkId——近战对建筑的判定半径是 edge+0.95=2.25，而 +1.2 的落点
  // 在地基内、被 addUnit 就近吸到 2.59 格外，武士砍完第一刀就永远够不着房。
  // 那时测到的是"指令链路缺一段行军"，不是本用例要测的房屋骨架(shell)状态机。
  warrior.selected = true;
  sim.orderAttackTarget(BLUE, hut!);
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

// v0.12：武士血量恒为牛头人 3 倍（盾+刀 vs 无甲脆皮）。
function testWarriorHpTripleFirewarrior(): void {
  assert(unitHp("warrior", 1) === 27 && unitHp("firewarrior", 1) === 9, "基础血量 武士 27 / 牛头人 9");
  assert(unitHp("warrior", 1) === 3 * unitHp("firewarrior", 1), "武士血量 = 牛头人 ×3（str=1）");
  assert(unitHp("warrior", 2) === 3 * unitHp("firewarrior", 2), "武士血量 = 牛头人 ×3（str=2，公式恒等）");

  console.log("testWarriorHpTripleFirewarrior ok");
}

// v0.12 武士暴击：50% 沿攻击方向击退 2~3 格 + 伤害 ×2；普攻无特效。
function testWarriorCrit(): void {
  const sim = new Sim(new World(42));
  const warrior = sim.addUnit(BLUE, "warrior", 20, 20);
  const foe = sim.addUnit(RED, "warrior", 20.5, 20); // 27 血甲 2：普通 4/刀，暴击 8/刀
  warrior.atkId = foe.id;
  warrior.order = "fight";
  const full = foe.hp;

  let orig = stubRandom(0.1); // < 0.5 → 暴击；击退距离 = 2 + 0.1 ≈ 2.1
  try {
    sim.combat(0.05);
  } finally {
    Math.random = orig;
  }
  assert(Math.abs(foe.hp - (full - 8)) < 1e-6, "暴击伤害 = 普通 ×2（4×2 = 8）");
  const knocked = Math.hypot(foe.x - 20.5, foe.z - 20);
  assert(knocked >= 2, `暴击沿攻击方向击退 2~3 格（d=${knocked.toFixed(2)}）`);

  foe.x = 20.5;
  foe.z = 20;
  orig = stubRandom(0.6); // ≥ 0.5 → 无暴击
  try {
    sim.combat(attackInterval("warrior") + 0.01);
  } finally {
    Math.random = orig;
  }
  assert(Math.abs(foe.hp - (full - 12)) < 1e-6, "无暴击只扣普通伤害（累计 8 + 4）");
  assert(Math.abs(foe.x - 20.5) < 1e-6 && Math.abs(foe.z - 20) < 1e-6, "普攻无位移无特效");

  console.log("testWarriorCrit ok");
}

function main(): void {
  testWarriorTwoHitsKillFirewarrior();
  testWarriorOneHitKillsWalker();
  testArmorReducesDamage();
  testCounterMultiplier();
  testAttackCooldownGating();
  testWarriorHpTripleFirewarrior();
  testWarriorCrit();
  testHutDamageSkeletonAndDestruction();
  testOrderAttackTarget();
  console.log("combat-check ok (v0.7 数值伤害 + v0.12 武士暴击与 3× 血量)");
}

main();
