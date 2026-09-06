// v0.30 检查：大龙（飞龙）——大龙训练营建造 / 20 牛战士进驻 / 60s 生产空降 /
// 飞行索敌与脱锁 / 吐息火 patch 衰减伤害 / 魔法必中与对空克制 / 剪影拾取。
// 测试文件命名：v0.30 / feature=dragon（大龙）。

import { Sim } from "./sim";
import { DragonSystem } from "./systems/dragon-system";
import {
  BLUE,
  DRAGON_FACTORY_PAD,
  DRAGON_FACTORY_WOOD,
  DRAGON_GARRISON_MAX,
  DRAGON_HP,
  DRAGON_PROD_T,
  DRAGON_RANGE,
  DRAGON_SPEED,
  RED,
  unitHp,
  unitRange,
  woodNeedFor,
} from "./types";
import type { Building, Team, Unit } from "./types";
import { World } from "./world";
import {
  DRAGON_PICK_RADIUS,
  dragonSpinePoint,
  pickDragonAt,
  type DragonPickItem,
} from "./picking";

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

/** 落一座成 L1 的大龙训练营（blue 方，出生点旁），返回建筑。 */
function placeFactory(sim: Sim, team: Team = BLUE, dx = -5, dz = 0): Building {
  const pad = sim.world.startPad(team);
  return sim.placeComplete(team, pad.x + dx, pad.z + dz, 0, "dragonFactory", 1);
}

/** 造 n 名牛战士并派进工厂，tick 到进驻满/超时，返回实际进驻数。 */
function garrisonTo(sim: Sim, factory: Building, n: number): number {
  const fires: Unit[] = [];
  for (let i = 0; i < n; i++) {
    const f = sim.addUnit(BLUE, "firewarrior", factory.x - 4 + (i % 5) * 0.6, factory.z + 3 + Math.floor(i / 5) * 0.6);
    fires.push(f);
  }
  for (const f of fires) f.selected = true;
  sim.orderMove(BLUE, factory.x, factory.z);
  for (const f of fires) f.selected = false;
  for (let i = 0; i < 500; i++) {
    sim.tick(0.05);
    if (factory.dwell >= Math.min(n, DRAGON_GARRISON_MAX)) break;
  }
  return factory.dwell;
}

/** a. 造价与占地：6 木起升，落地 3.2×3.2 大厂房。 */
function testFactoryBuild(): void {
  assert(woodNeedFor("dragonFactory", 0) === DRAGON_FACTORY_WOOD, "cost: 工厂 L0 需 6 捆木头");
  assert(woodNeedFor("dragonFactory", 1) === 0, "cost: 落成后不再要木头");
  const sim = new Sim(new World(42));
  const f = placeFactory(sim);
  assert(f.level === 1 && f.kind === "dragonFactory", "cost: placeComplete 直接落成 L1");
  assert(f.padW === DRAGON_FACTORY_PAD && f.padD === DRAGON_FACTORY_PAD, "cost: 占地 3.2×3.2");
  console.log("testFactoryBuild ok");
}

/** b. 进驻：20 名牛战士进厂 dwell=20、homeId 挂厂；第 21 名被拒。 */
function testGarrisonFill(): void {
  const sim = new Sim(new World(42));
  const f = placeFactory(sim);
  const filled = garrisonTo(sim, f, DRAGON_GARRISON_MAX);
  assert(filled === DRAGON_GARRISON_MAX, `garrison: 进驻满 ${DRAGON_GARRISON_MAX}（实际 ${filled}）`);
  const inside = sim.units.filter((u) => u.homeId === f.id);
  assert(inside.length === DRAGON_GARRISON_MAX, "garrison: 20 名牛战士 homeId 挂厂");

  // 第 21 名：走到门口也进不去（容量锁死）。
  const extra = sim.addUnit(BLUE, "firewarrior", f.x - 4, f.z + 3);
  extra.selected = true;
  sim.orderMove(BLUE, f.x, f.z);
  extra.selected = false;
  for (let i = 0; i < 120; i++) sim.tick(0.05);
  assert(extra.homeId === 0 && f.dwell === DRAGON_GARRISON_MAX, "garrison: 第 21 名被拒（容量锁死）");
  console.log("testGarrisonFill ok");
}

/** c. 生产：满员后 prod 推进，60s 完成空降大龙、20 名进驻者移除。 */
function testProduction(): void {
  const sim = new Sim(new World(42));
  const f = placeFactory(sim);
  assert(garrisonTo(sim, f, DRAGON_GARRISON_MAX) === DRAGON_GARRISON_MAX, "produce: 先进驻满 20");

  let sawProgress = false;
  for (let i = 0; i < 40 && !sawProgress; i++) {
    sim.tick(0.05);
    if (f.prod > 0) sawProgress = true;
  }
  assert(sawProgress, "produce: 满员后生产进度开始推进");

  // 快进 65 秒：生产完成 → 大龙空降。
  let dragon: Unit | undefined;
  for (let i = 0; i < 1400; i++) {
    sim.tick(0.05);
    dragon = sim.units.find((u) => u.kind === "dragon");
    if (dragon) break;
  }
  assert(!!dragon, `produce: ${DRAGON_PROD_T}s 后大龙空降`);
  assert(dragon!.team === BLUE, "produce: 大龙属蓝方");
  assert(dragon!.hp === DRAGON_HP && dragon!.maxHp === DRAGON_HP, "produce: 大龙血量 = 100 村民");
  assert(sim.units.every((u) => u.homeId !== f.id), "produce: 20 名进驻者已移除（化作大龙）");
  assert(f.dwell === 0 && f.prod === 0, "produce: 工厂计数/进度清零");
  // 空降自高处下坠：初始高度明显高于巡航线。
  assert(dragon!.y > sim.world.heightAt(dragon!.x, dragon!.z) + 1.2, "produce: 大龙悬在半空");
  console.log("testProduction ok");
}

/** d. 数值：600 血 = 100×村民；射程 10；速度慢于村民。 */
function testStats(): void {
  assert(unitHp("dragon", 1) === DRAGON_HP, "stats: 大龙血量常量");
  assert(unitHp("dragon", 1) === 100 * unitHp("walker", 1), "stats: 血量 = 100 个村民");
  assert(unitRange("dragon") === DRAGON_RANGE && DRAGON_RANGE === 10, "stats: 攻击范围 10 格");
  assert(DRAGON_SPEED < 2.4, "stats: 飞行速度慢于村民（2.4）");
  console.log("testStats ok");
}

/** 找一个距 (cx,cz) 约 dist 格、可走的落点（扫描 24 个角度）。 */
function findLandSpot(sim: Sim, cx: number, cz: number, dist: number): { x: number; z: number } {
  for (let a = 0; a < 24; a++) {
    const ang = (a / 24) * Math.PI * 2;
    const x = cx + Math.cos(ang) * dist;
    const z = cz + Math.sin(ang) * dist;
    if (sim.world.walkableAt(x, z)) return { x, z };
  }
  throw new Error(`findLandSpot: ${dist} 格内找不到可走点`);
}

/** e. 全自动索敌 + 脱锁：10 格内锁定；目标跑出 10 格弃锁；无目标不锁。 */
function testAutoTargetAndLeash(): void {
  const sim = new Sim(new World(42));
  const pad = sim.world.startPad(BLUE);
  const dragon = sim.addUnit(BLUE, "dragon", pad.x + 2, pad.z);
  dragon.y = sim.world.heightAt(dragon.x, dragon.z) + 2.2;
  const foe = sim.addUnit(RED, "walker", pad.x + 6, pad.z);
  foe.hp = 999;

  let locked = false;
  for (let i = 0; i < 40 && !locked; i++) {
    // 钉位必须在 tick 之前：索敌判定发生在 tick 内部（红方村民会自己走动）。
    foe.x = pad.x + 6;
    foe.z = pad.z;
    foe.path = [];
    foe.pathI = 0;
    sim.tick(0.05);
    locked = dragon.atkId === foe.id;
  }
  assert(locked, "target: 10 格内自动锁定敌方单位");
  assert(dragon.y > sim.world.heightAt(dragon.x, dragon.z) + 1.2, "target: 大龙始终在半空");

  // 目标跑出 10 格 → 弃锁。落点必须是**可走的**陆地：钉进海里会被
  // resolveCollisions 的 nearestLand 弹回海岸（<10 格），脱锁判定就看不到了。
  const far = findLandSpot(sim, dragon.x, dragon.z, 12);
  assert(Math.hypot(far.x - dragon.x, far.z - dragon.z) > DRAGON_RANGE, "target: 脱锁落点在 10 格外");
  for (let i = 0; i < 20; i++) {
    foe.x = far.x;
    foe.z = far.z;
    foe.path = [];
    foe.pathI = 0;
    sim.tick(0.05);
  }
  assert(dragon.atkId === 0, "target: 目标逃出 10 格自动放弃");

  // 附近无敌单位 → 不再锁（同一处 12 格外陆点）。
  for (let i = 0; i < 20; i++) {
    foe.x = far.x;
    foe.z = far.z;
    foe.path = [];
    foe.pathI = 0;
    sim.tick(0.05);
  }
  assert(dragon.atkId === 0, "target: 射程外无目标不锁");
  console.log("testAutoTargetAndLeash ok");
}

/** f. 吐息：命中单位生成火 patch，伤害衰减并烧死目标。 */
function testBreathKillsUnit(): void {
  const sim = new Sim(new World(42));
  const pad = sim.world.startPad(BLUE);
  const dragon = sim.addUnit(BLUE, "dragon", pad.x + 2, pad.z);
  dragon.y = sim.world.heightAt(dragon.x, dragon.z) + 2.2;
  const foe = sim.addUnit(RED, "walker", pad.x + 5, pad.z); // 6 血村民
  let sawFire = false;
  let dpsEarly = 0;
  let dpsLate = 0;
  for (let i = 0; i < 400; i++) {
    // 钉住村民在射程内（村民会乱走）；先钉位再 tick，保证索敌/吐息判定所见位置一致。
    if (foe.hp > 0) {
      foe.x = pad.x + 5;
      foe.z = pad.z;
      foe.path = [];
      foe.pathI = 0;
    }
    sim.tick(0.05);
    if (sim.fires.length > 0 && !sawFire) {
      sawFire = true;
      dpsEarly = sim.fires[0]!.dps();
    } else if (sawFire && dpsLate === 0 && i % 10 === 0) {
      dpsLate = sim.fires[0]?.dps() ?? 0;
    }
    if (foe.hp <= 0) break;
  }
  assert(sawFire, "breath: 吐息落地生成燃烧地块");
  assert(dpsLate < dpsEarly, `breath: 伤害随时间衰减（${dpsEarly.toFixed(2)} → ${dpsLate.toFixed(2)}）`);
  assert(foe.hp <= 0, "breath: 6 血村民被烧死");
  console.log("testBreathKillsUnit ok");
}

/** g. 吐息拆屋：范围内只有建筑时锁定建筑，持续掉血/骨架化。 */
function testBreathBurnsBuilding(): void {
  const sim = new Sim(new World(42));
  const pad = sim.world.startPad(BLUE);
  const dragon = sim.addUnit(BLUE, "dragon", pad.x + 2, pad.z);
  dragon.y = sim.world.heightAt(dragon.x, dragon.z) + 2.2;
  const hut = sim.placeComplete(RED, pad.x + 6, pad.z, 0, "hut", 1);
  const hp0 = hut.hp;
  let locked = false;
  let worn = false;
  for (let i = 0; i < 400 && !worn; i++) {
    sim.tick(0.05);
    locked = locked || dragon.atkId === hut.id;
    worn = hut.hp < hp0;
  }
  assert(locked, "breath-house: 大龙锁定敌方建筑");
  assert(worn, "breath-house: 建筑被吐息持续烧伤");
  console.log("testBreathBurnsBuilding ok");
}

/** h. 魔法必中大龙：闪电/击飞只掉血无击飞物理；陨石点燃。 */
function testMagicHitsDragon(): void {
  const sim = new Sim(new World(42));
  const pad = sim.world.startPad(BLUE);
  const dragon = sim.addUnit(BLUE, "dragon", pad.x + 2, pad.z);
  dragon.y = sim.world.heightAt(dragon.x, dragon.z) + 2.2;
  const y0 = dragon.y;

  sim.lightningSpell.strikeLightning(sim, dragon.x, dragon.z);
  assert(dragon.hp === DRAGON_HP - 8, "magic: 闪电劈中大龙 -8");
  assert(dragon.flyVy === 0 && Math.abs(dragon.y - y0) < 0.5, "magic: 大龙不被闪电击飞");

  sim.blastSpell.blastAt(sim, dragon.x, dragon.z);
  assert(dragon.hp === DRAGON_HP - 8 - 6, "magic: 击飞法术命中大龙 -6");
  assert(dragon.flyVy === 0, "magic: 大龙不被气浪掀飞");

  sim.meteors.push({ x: dragon.x, z: dragon.z, y: 5, vy: -15, team: RED });
  for (let i = 0; i < 40 && sim.meteors.length; i++) sim.tickMeteors(0.05);
  assert(dragon.burnT > 0, "magic: 天降火球点燃大龙（持续灼烧）");
  console.log("testMagicHitsDragon ok");
}

/** i. 对空克制：地面牛战士锁大龙并射中；近战武士锁不到。 */
function testAirCombatCounters(): void {
  const sim = new Sim(new World(42));
  const pad = sim.world.startPad(BLUE);
  // 战场选在离村 15 格的无人区：否则牛战士会优先锁到更近的蓝方村民/祭司（地面对地），
  // 这条用例只验证"视野内只有大龙时，地面牛战士对空开火"。
  const spot = findLandSpot(sim, pad.x, pad.z, 15);
  const dragon = sim.addUnit(BLUE, "dragon", spot.x, spot.z);
  dragon.y = sim.world.heightAt(dragon.x, dragon.z) + 2.2;
  const shooterSpot = findLandSpot(sim, spot.x, spot.z, 3);
  const shooter = sim.addUnit(RED, "firewarrior", shooterSpot.x, shooterSpot.z);
  shooter.hp = 999; // 顶住大龙吐息，专注验证"对空射击"这一条链路
  const warrior = sim.addUnit(RED, "warrior", shooterSpot.x + 0.4, shooterSpot.z);

  let hit = false;
  let warriorLocked = false;
  let locked = false;
  for (let i = 0; i < 100; i++) {
    // 先钉位再 tick：大龙被 DragonSystem 移动，钉住后弹道瞄准点即命中点；
    // 索敌/开火/命中判定都发生在 tick 内部。
    dragon.x = spot.x;
    dragon.z = spot.z;
    dragon.y = sim.world.heightAt(dragon.x, dragon.z) + 2.2;
    shooter.x = shooterSpot.x;
    shooter.z = shooterSpot.z;
    shooter.path = [];
    shooter.pathI = 0;
    warrior.x = shooterSpot.x + 0.4;
    warrior.z = shooterSpot.z;
    warrior.path = [];
    warrior.pathI = 0;
    sim.tick(0.05);
    locked = locked || shooter.atkId === dragon.id;
    hit = hit || dragon.hp < DRAGON_HP;
    warriorLocked = warriorLocked || warrior.atkId === dragon.id;
  }
  assert(locked, "air: 牛战士锁定大龙");
  assert(hit, "air: 牛战士对空射中大龙（弹道瞄准龙身高度）");
  assert(!warriorLocked, "air: 近战武士锁不到大龙（够不着不站桩）");
  console.log("testAirCombatCounters ok");
}

/** j. 传教士/转化感化不了大龙。 */
function testNoConvert(): void {
  const sim = new Sim(new World(42));
  const pad = sim.world.startPad(BLUE);
  const dragon = sim.addUnit(RED, "dragon", pad.x + 2, pad.z);
  dragon.y = sim.world.heightAt(dragon.x, dragon.z) + 2.2;
  const preacher = sim.addUnit(BLUE, "preacher", pad.x + 2.4, pad.z);
  for (let i = 0; i < 60; i++) {
    preacher.x = dragon.x + 0.5;
    preacher.z = dragon.z;
    sim.tick(0.05);
  }
  assert(dragon.team === RED && dragon.kind === "dragon", "convert: 大龙不被感化/转化");
  console.log("testNoConvert ok");
}

/** k. 剪影拾取（纯函数）：光标落剪影内命中、离中心近者胜、剪影外返回 null。 */
function testPickingSilhouette(): void {
  // 模拟两只龙的屏幕剪影：A 在 (200,200)，B 在 (400,200)，圆半径 30px。
  const mk = (id: number, cx: number): DragonPickItem => ({
    id,
    cx,
    cy: 200,
    circles: [
      { x: cx - 40, y: 200, r: 30 },
      { x: cx, y: 200, r: 30 },
      { x: cx + 40, y: 200, r: 30 },
    ],
  });
  const items = [mk(1, 200), mk(2, 400)];
  assert(pickDragonAt(items, 205, 195)?.id === 1, "pick: 剪影内命中 A");
  assert(pickDragonAt(items, 435, 205)?.id === 2, "pick: 剪影内命中 B");
  assert(pickDragonAt(items, 205, 195)!.id === 1, "pick: 命中取中心最近者");
  assert(pickDragonAt(items, 280, 200) === null, "pick: 两龙剪影间隙不算命中");
  assert(pickDragonAt(items, 200, 280) === null, "pick: 剪影外返回 null（走地面单位判定）");

  // 脊线采样：沿朝向偏移，y 抬到龙身高度。
  const p = dragonSpinePoint(10, 5, 10, 0, 1.0);
  assert(Math.abs(p.x - 10) < 1e-9 && Math.abs(p.z - 11) < 1e-9 && Math.abs(p.y - 5.55) < 1e-9, "pick: 脊线点沿 yaw 前向偏移");
  console.log("testPickingSilhouette ok");
}

/** l. 生产途中工厂被拆：20 名牛战士原样弹出存活，大龙不出现。 */
function testFactoryDestroyedMidProduction(): void {
  const sim = new Sim(new World(42));
  const f = placeFactory(sim);
  assert(garrisonTo(sim, f, DRAGON_GARRISON_MAX) === DRAGON_GARRISON_MAX, "destroy: 进驻满");
  for (let i = 0; i < 20 && f.prod === 0; i++) sim.tick(0.05);
  assert(f.prod > 0, "destroy: 生产已开始");

  sim.combatSystem.hurtBuilding(sim, f, 9999); // 骨架
  sim.combatSystem.hurtBuilding(sim, f, 9999); // 拆没
  sim.tick(0.05);
  const crew = sim.units.filter((u) => u.kind === "firewarrior" && u.homeId === 0);
  assert(crew.length === DRAGON_GARRISON_MAX, "destroy: 20 名牛战士被弹出工厂且存活");
  assert(!sim.units.some((u) => u.kind === "dragon"), "destroy: 生产中断大龙不出现");
  console.log("testFactoryDestroyedMidProduction ok");
}

/** m. 飞行物理：视觉火焰按时熄灭（moveUnits 跳过飞行单位的补偿）+ 飞越海面不沉水下。 */
function testFlightPhysics(): void {
  const sim = new Sim(new World(42));
  const pad = sim.world.startPad(BLUE);
  const dragon = sim.addUnit(BLUE, "dragon", pad.x + 2, pad.z);
  dragon.y = sim.world.heightAt(dragon.x, dragon.z) + 2.2;

  // 闪电点燃的视觉火焰必须会熄灭：fireT 衰减在地面 moveUnits 里，飞行单位靠 DragonSystem 补。
  sim.lightningSpell.strikeLightning(sim, dragon.x, dragon.z);
  assert(dragon.fireT > 0, "flight: 闪电点燃大龙（视觉火焰）");
  for (let i = 0; i < 100; i++) sim.tick(0.05); // 5s > fireT 3.6s
  assert(dragon.fireT === 0, "flight: 视觉火焰按时熄灭（不会永远 burning）");

  // 飞越海面：巡航高度恒在水面之上。注：世界生成与 sculpt 都对高度场做了 ≥0 钳制
  //（实测海床最低 ≈0.04），所以"沉到水下"当前不可达——flyStep 里的 max(地表, WATER)
  // 是防御性兜底（未来地形改动若放开负高度仍然安全）。这里验证水面巡航不变量。
  let water: { x: number; z: number } | null = null;
  for (let x = 1; x < 72 && !water; x += 2) {
    for (let z = 1; z < 72; z += 2) {
      if (sim.world.heightAt(x, z) <= 0.2) {
        water = { x, z };
        break;
      }
    }
  }
  assert(!!water, "flight: 地图上存在水面点");
  for (let i = 0; i < 80; i++) {
    dragon.x = water!.x;
    dragon.z = water!.z;
    sim.tick(0.05);
  }
  assert(
    dragon.y >= 0.2 + 1.5,
    `flight: 大龙飞越水面恒在水面之上（y=${dragon.y.toFixed(2)} ≥ 水面+1.5）`,
  );
  console.log("testFlightPhysics ok");
}

/** n. 系统冒烟：DragonSystem.update 直调不抛（ISystem 接口一致性）。 */
function testSystemContract(): void {
  const sim = new Sim(new World(42));
  const sys = new DragonSystem();
  sys.update(sim, 0.05);
  assert(Array.isArray(sim.breaths) && Array.isArray(sim.fires), "contract: breaths/fires 字段就绪");
  console.log("testSystemContract ok");
}

testFactoryBuild();
testGarrisonFill();
testProduction();
testStats();
testAutoTargetAndLeash();
testBreathKillsUnit();
testBreathBurnsBuilding();
testMagicHitsDragon();
testAirCombatCounters();
testNoConvert();
testPickingSilhouette();
testFactoryDestroyedMidProduction();
testFlightPhysics();
testSystemContract();
console.log("dragon-check 全部通过（v0.30 大龙：建造/进驻/生产空降/索敌脱锁/吐息衰减/魔法必中/对空克制/剪影拾取/飞行物理）");
