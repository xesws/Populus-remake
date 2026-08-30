import { Sim } from "./sim";
import { BLUE, RED, agroLeash, UNIT_SIGHT, unitRange } from "./types";
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

  // 靶子钉桩：红村民会自主砍树/游荡，v0.27-2 视野 20 + 无限追击会把"击杀"变成概率事件
  //（靶子把武士风筝过半个地图），钉住后测的才是"锁定→贴身→击杀→再锁定"链路本身。
  let died = false;
  for (let i = 0; i < 400; i++) {
    sim.tick(0.05);
    villager.x = 21.5;
    villager.z = 20;
    villager.path = [];
    villager.pathI = 0;
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
    next.x = 21.5;
    next.z = 20;
    next.path = [];
    next.pathI = 0;
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
  const villager = sim.addUnit(RED, "walker", 20, 56); // v0.27-2 视野 20：旧距离 14 已在圈内
  const fullHp = villager.hp;

  // 靶子钉桩：红村民会自主砍树/游荡（甚至会撞进红方出生点被合并），干扰"满血"断言。
  for (let i = 0; i < 20; i++) {
    sim.tick(0.05);
    villager.x = 20;
    villager.z = 56;
    villager.path = [];
    villager.pathI = 0;
  }

  assert(warrior.atkId === 0, "out-of-sight: 距离 36 > 武士索敌半径 20，不会主动锁定");
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
  const foe = sim.addUnit(RED, "walker", 21.5, 20);
  // 靶子血量拉满：武士一刀就砍死 6 血村民（v0.19 数值克制的设计），而本用例要验的是
  // 「自动获得目标 → 拉开锚点距离 → 自动放弃」两段判定，目标中途阵亡就没得判了。
  foe.hp = 999;

  tickFor(sim, 0.5);
  assert(warrior.atkId !== 0, "leash: 武士已自动获得 atkId");

  // 传送武士到远离锚点（agroX/Z 仍是 20,20）；v0.27-2 拴绳=视野+2=22，要拉到 24 格外。
  // 注意同步 y：combat 对"腾空"单位（y 高于脚下地面 0.08+）在拴绳判定前就 continue，
  // 传送不落地会误测成"拴绳没生效"。
  warrior.x = 44;
  warrior.z = 20;
  warrior.y = sim.world.heightAt(44, 20);
  warrior.flyVy = 0;

  sim.combat(0.05);
  assert(warrior.atkId === 0, "leash: 距锚点 24 > 拴绳(视野20+2)，自动放弃目标");

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
  // 靶子血量拉满：村民只有 6 血，武士一刀就砍死，循环立刻 break，minDist 量到的其实是
  // "敌人暴毙前武士还没走完的路"（实测 1.12），而不是近战贴身能力。这条要测的是
  // 「远程手动下令后武士会一路贴到近战判定内」，所以敌人必须活得够久。
  foe.hp = 999;
  warrior.atkId = foe.id; // 距离 4 > 索敌 3.5，手动下令

  let minDist = 1e9;
  let hit = false;
  for (let i = 0; i < 100; i++) {
    sim.tick(0.05);
    foe.x = 24;
    foe.z = 20;
    if (foe.hp < 999) hit = true;
    if (foe.hp > 0) {
      const d = Math.hypot(warrior.x - 24, warrior.z - 20);
      if (d < minDist) minDist = d;
    } else break;
  }
  // 近战判定半径就是 unitRange("warrior")=0.95：贴进这个圈才算真正能出刀。
  assert(hit, "武士确实出刀命中（敌人掉血）");
  assert(minDist <= unitRange("warrior"), `武士贴身肉搏（min=${minDist.toFixed(2)}）`);

  console.log("testWarriorClosesToMelee ok");
}

/** v0.27-2 f. 视野/拴绳数值：武士 20、牛头人 12、传教士 4.5；拴绳=视野+2。 */
function testSightAndLeashValues(): void {
  assert(UNIT_SIGHT.warrior === 20, "sight: 武士锁敌 20（13×1.5+）");
  assert(UNIT_SIGHT.firewarrior === 12, "sight: 牛头人锁敌 12（8×1.5）");
  assert(UNIT_SIGHT.preacher === 4.5, "sight: 传教士锁敌 4.5");
  assert(agroLeash("warrior") === 22, "leash: 武士拴绳=22（视野+2）");
  assert(agroLeash("firewarrior") === 14, "leash: 牛头人拴绳=14");
  assert(agroLeash("walker") === 0, "leash: 不索敌兵种拴绳 0");
  console.log("testSightAndLeashValues ok");
}

/** v0.27-2 g. 近战追击刷新：敌人持续保持在武士前方 5 格逃跑，武士必须一路追、不丢锁。 */
function testWarriorChasesFleeingFoe(): void {
  const sim = new Sim(new World(42));
  const pad = sim.world.startPad(BLUE);
  const warrior = sim.addUnit(BLUE, "warrior", pad.x, pad.z);
  const foe = sim.addUnit(RED, "walker", pad.x + 6, pad.z);
  foe.hp = 999;

  // 阶段 1（3 秒）：靶子始终钉在武士前方 5 格（等价持续逃跑），旧实现走完一次
  // 路径就拿着过期 atkId 发呆，位移会停在 ~5 格；新实现每轮刷新追击。
  for (let i = 0; i < 60; i++) {
    sim.tick(0.05);
    foe.x = warrior.x + 5;
    foe.z = warrior.z;
    foe.path = [];
    foe.pathI = 0;
  }
  const advanced = Math.hypot(warrior.x - pad.x, warrior.z - pad.z);
  assert(warrior.atkId === foe.id, `chase: 追击全程锁定不丢（atkId=${warrior.atkId}）`);
  assert(advanced >= 6, `chase: 持续追击位移 ≥6（实际 ${advanced.toFixed(1)}）`);

  // 阶段 2：靶子停跑，武士应贴身出刀。
  const fx = foe.x;
  const fz = foe.z;
  let hit = false;
  for (let i = 0; i < 120; i++) {
    sim.tick(0.05);
    foe.x = fx;
    foe.z = fz;
    foe.path = [];
    foe.pathI = 0;
    if (foe.hp < 999) {
      hit = true;
      break;
    }
  }
  assert(hit, "chase: 追上后出刀命中（敌人掉血）");
  console.log("testWarriorChasesFleeingFoe ok");
}

/** v0.27-2 h. 牛头人站桩：敌人从 8 格外路过，全程不移动，进射程即被火球命中。 */
function testFirewarriorHoldsGroundAndFires(): void {
  const sim = new Sim(new World(42));
  const pad = sim.world.startPad(BLUE);
  // 偏离 pad 中心 2 格落位：出生点还站着初始祭司/村民，贴中心会被碰撞挤动，误判成"移动"。
  const fire = sim.addUnit(BLUE, "firewarrior", pad.x - 2, pad.z);
  const foe = sim.addUnit(RED, "walker", pad.x + 6, pad.z);
  foe.hp = 999;

  sim.tick(0.05);
  const sx = fire.x;
  const sz = fire.z;
  let moved = false;
  let fired = false;
  for (let i = 0; i < 200; i++) {
    sim.tick(0.05);
    const t = Math.max(1.5, 8 - i * 0.05); // 敌人 2 格/秒走近，最近停 1.5 格
    foe.x = pad.x - 2 + t;
    foe.z = pad.z;
    foe.path = [];
    foe.pathI = 0;
    if (Math.hypot(fire.x - sx, fire.z - sz) > 0.4) moved = true;
    if (foe.hp < 999 || foe.downT > 0 || foe.flyVy !== 0) fired = true;
    if (fired) break;
  }
  assert(fired, "hold: 敌人进入射程后被火球命中（掉血/倒地/击飞）");
  assert(!moved, "hold: 牛头人全程站桩，一步未挪");
  console.log("testFirewarriorHoldsGroundAndFires ok");
}

/** v0.27-2 i. 牛头人换锁：锁着射程外远目标时，更近目标进圈应切锁。 */
function testFirewarriorSwitchesToCloserFoe(): void {
  const sim = new Sim(new World(42));
  const pad = sim.world.startPad(BLUE);
  const fire = sim.addUnit(BLUE, "firewarrior", pad.x - 2, pad.z);
  const far = sim.addUnit(RED, "walker", pad.x + 6, pad.z);
  far.hp = 999;

  // 靶子全程钉桩：红村民会自主游荡，走近了会把火战士挤动，干扰位移断言。
  const fx = far.x;
  const fz = far.z;
  let ok1 = false;
  for (let i = 0; i < 12; i++) {
    sim.tick(0.05);
    far.x = fx;
    far.z = fz;
    far.path = [];
    far.pathI = 0;
    if (fire.atkId === far.id) ok1 = true;
  }
  assert(ok1, "switch: 先锁住 8 格外的远目标");
  const sx = fire.x; // 出生碰撞会把火战士挤开一步，位移基准取稳定后的落点
  const sz = fire.z;

  // 近目标放在射程外一点（离火战士 5.5 > 4.5）：本用例只验"换锁"，不触发射击/
  // 击退/还手冲锋（那些会把火战士挤动，干扰"换锁不产生移动"的断言）。
  const near = sim.addUnit(RED, "walker", pad.x + 3.5, pad.z);
  near.hp = 999;
  let ok2 = false;
  for (let i = 0; i < 15; i++) {
    sim.tick(0.05); // ≥2 轮索敌（0.25s/轮）
    far.x = fx;
    far.z = fz;
    far.path = [];
    far.pathI = 0;
    near.x = pad.x + 3.5;
    near.z = pad.z;
    near.path = [];
    near.pathI = 0;
    if (fire.atkId === near.id) ok2 = true;
  }
  assert(ok2, `switch: 切锁到更近目标（atkId=${fire.atkId}）`);
  assert(Math.hypot(fire.x - sx, fire.z - sz) <= 0.4, "switch: 换锁不产生移动");
  console.log("testFirewarriorSwitchesToCloserFoe ok");
}

function main(): void {
  testWarriorAutoAcquire();
  testNoAcquireOutOfSight();
  testShamanRetaliate();
  testRedFightOrderAcquires();
  testAgroLeash();
  testFirewarriorStandsOff();
  testWarriorClosesToMelee();
  testSightAndLeashValues();
  testWarriorChasesFleeingFoe();
  testFirewarriorHoldsGroundAndFires();
  testFirewarriorSwitchesToCloserFoe();
  console.log("combat-auto-check ok (v0.8 索敌还手 + v0.12 远程拉停 + v0.27-2 锁敌刷新/远程站桩/视野扩大)");
}

main();