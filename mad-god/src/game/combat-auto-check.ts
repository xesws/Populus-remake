import { Sim } from "./sim";
import { BLUE, RED } from "./types";
import { World } from "./world";

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

function tickFor(sim: Sim, seconds: number, dt = 0.05): void {
  const n = Math.round(seconds / dt);
  for (let i = 0; i < n; i++) sim.tick(dt);
}

// v0.8 自动索敌与还手：士兵自动找人，村民/萨满不主动但被打会还手，红方 fight 谕令对称生效。

/** a. 蓝武士自动索敌击杀红村民；击杀后再放一个红村民也能继续被自动索敌。 */
function testWarriorAutoAcquire(): void {
  const sim = new Sim(new World(42));
  const warrior = sim.addUnit(BLUE, "warrior", 20, 20);
  const villager = sim.addUnit(RED, "walker", 21.5, 20);

  let died = false;
  for (let i = 0; i < 400; i++) {
    sim.tick(0.05);
    if (villager.hp <= 0) {
      died = true;
      break;
    }
  }
  assert(died, "auto: 武士自动索敌后击杀村民（不手动设 atkId）");

  // 再放一个红村民到附近，自动索敌应能再次生效
  const next = sim.addUnit(RED, "walker", 21.5, 20);
  assert(warrior.atkId === 0, "auto: 击杀后武士 atkId 已清零，等待重新索敌");

  let nextDied = false;
  for (let i = 0; i < 400; i++) {
    sim.tick(0.05);
    if (next.hp <= 0) {
      nextDied = true;
      break;
    }
  }
  assert(nextDied, "auto: 击杀后武士自动重新索敌并击杀第二名村民");

  console.log("testWarriorAutoAcquire ok");
}

/** b. 索敌半径外不主动攻击，只跑 1s 避免红村民自己游荡进入半径。 */
function testNoAcquireOutOfSight(): void {
  const sim = new Sim(new World(42));
  const warrior = sim.addUnit(BLUE, "warrior", 20, 20);
  const villager = sim.addUnit(RED, "walker", 30, 30);
  const fullHp = villager.hp;

  tickFor(sim, 1.0);

  assert(warrior.atkId === 0, "out-of-sight: 距离 14 > 武士索敌半径 3.5，不会主动锁定");
  assert(villager.hp === fullHp, "out-of-sight: 1 秒内村民满血");

  console.log("testNoAcquireOutOfSight ok");
}

/** c. 萨满不主动索敌（UNIT_SIGHT=0），但被打会还手并反杀村民。 */
function testShamanRetaliate(): void {
  const sim = new Sim(new World(42));
  const shaman = sim.addUnit(BLUE, "shaman", 20, 20);
  const villager = sim.addUnit(RED, "walker", 20.5, 20);
  const shamanStart = shaman.hp;

  // 萨满不主动索敌，玩家用村民手动进攻，触发还手
  villager.atkId = shaman.id;
  villager.order = "fight";

  let retaliated = false;
  let villagerDied = false;
  for (let i = 0; i < 400; i++) {
    sim.tick(0.05);
    if (!retaliated && shaman.atkId === villager.id) retaliated = true;
    if (villager.hp <= 0) {
      villagerDied = true;
      break;
    }
  }
  assert(retaliated, "retaliate: 萨满被打后还手，把 atkId 反指向村民");
  assert(villagerDied, "retaliate: 萨满还手后击杀村民（攻 3 / 1.5s × 2 刀）");
  assert(shaman.hp > 0, "retaliate: 萨满扛得住村民两刀（14 血 - 2×2 = 10）");
  assert(shaman.hp < shamanStart, "retaliate: 萨满确实挨了打（血量减少）");

  console.log("testShamanRetaliate ok");
}

/** d. 红方 fight 谕令下武士主动交战（AI 零改动，靠对称索敌生效）。 */
function testRedFightOrderAcquires(): void {
  const sim = new Sim(new World(42));
  const redWarrior = sim.addUnit(RED, "warrior", 20, 20);
  redWarrior.order = "fight";
  const blueVillager = sim.addUnit(BLUE, "walker", 21, 20);

  let died = false;
  for (let i = 0; i < 400; i++) {
    sim.tick(0.05);
    if (blueVillager.hp <= 0) {
      died = true;
      break;
    }
  }
  assert(died, "red-fight: 红方 fight 谕令下武士主动索敌击杀蓝村民");

  console.log("testRedFightOrderAcquires ok");
}

/** e. 拴绳：自动获得的目标离锚点超过 AGRO_LEASH 格就放弃（手动指令 -1 不受影响）。 */
function testAgroLeash(): void {
  const sim = new Sim(new World(42));
  const warrior = sim.addUnit(BLUE, "warrior", 20, 20);
  sim.addUnit(RED, "walker", 21.5, 20);

  tickFor(sim, 0.5);
  assert(warrior.atkId !== 0, "leash: 武士已自动获得 atkId");

  // 传送武士到远离锚点（agroX/Z 仍是 20,20）
  warrior.x = 30;
  warrior.z = 30;

  sim.combat(0.05);
  assert(warrior.atkId === 0, "leash: 距锚点 ~14 > AGRO_LEASH(8)，自动放弃目标");

  console.log("testAgroLeash ok");
}

/** v0.12 远程拉停：火战士进射程即停、不再前压；武士对照贴身肉搏。 */
function testFirewarriorStandsOff(): void {
  const sim = new Sim(new World(42));
  const fire = sim.addUnit(BLUE, "firewarrior", 20, 20);
  fire.order = "fight";
  const foe = sim.addUnit(RED, "walker", 26, 20); // 距离 6 > 索敌 5.5，模拟玩家手动下令
  fire.atkId = foe.id;

  let minDist = 1e9;
  let hit = false;
  for (let i = 0; i < 100; i++) {
    sim.tick(0.05);
    foe.x = 26;
    foe.z = 20; // 钉住敌人，观察火战士自身走位
    const d = Math.hypot(fire.x - 26, fire.z - 20);
    if (d < minDist) minDist = d;
    if (foe.hp < foe.maxHp || foe.downT > 0 || foe.flyVy !== 0 || foe.hp <= 0) hit = true;
    if (foe.hp <= 0) break;
  }
  assert(hit, "远程持续开火命中（倒地/击飞/掉血至少其一）");
  const d = Math.hypot(fire.x - 26, fire.z - 20);
  assert(d <= 4.6 && d >= 3.2, `停在射程边沿开火（d=${d.toFixed(2)}）`);
  assert(minDist >= 2.8, `不进入肉搏距离（min=${minDist.toFixed(2)}）`);

  console.log("testFirewarriorStandsOff ok");
}

function testWarriorClosesToMelee(): void {
  const sim = new Sim(new World(42));
  const warrior = sim.addUnit(BLUE, "warrior", 20, 20);
  warrior.order = "fight";
  const foe = sim.addUnit(RED, "walker", 24, 20);
  warrior.atkId = foe.id; // 距离 4 > 索敌 3.5，手动下令

  let minDist = 1e9;
  for (let i = 0; i < 100; i++) {
    sim.tick(0.05);
    foe.x = 24;
    foe.z = 20;
    if (foe.hp > 0) {
      const d = Math.hypot(warrior.x - 24, warrior.z - 20);
      if (d < minDist) minDist = d;
    } else break;
  }
  assert(minDist <= 1.1, `武士贴身肉搏（min=${minDist.toFixed(2)}）`);

  console.log("testWarriorClosesToMelee ok");
}

function main(): void {
  testWarriorAutoAcquire();
  testNoAcquireOutOfSight();
  testShamanRetaliate();
  testRedFightOrderAcquires();
  testAgroLeash();
  testFirewarriorStandsOff();
  testWarriorClosesToMelee();
  console.log("combat-auto-check ok (v0.8 索敌还手 + v0.12 远程拉停)");
}

main();