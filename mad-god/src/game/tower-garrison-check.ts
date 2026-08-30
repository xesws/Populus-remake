// v0.27-3 检查：哨塔（tower）建造 / 牛战士驻扎 / 塔上射击 / 弹出。
// 测试文件命名：v0.27 / feature=tower-garrison。

import { Sim } from "./sim";
import { BLUE, RED, TOWER_PAD, woodNeedFor } from "./types";
import type { Unit } from "./types";
import { World } from "./world";

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

/** a. 造价与完工：哨塔 1 捆木头（比茅屋快），送满即落成 L1、占地 TOWER_PAD。 */
function testTowerCostAndCompletion(): void {
  assert(woodNeedFor("tower", 0) === 1, "cost: 哨塔 L0 需 1 捆木头");
  assert(woodNeedFor("tower", 1) === 0, "cost: 落成后不再要木头");

  const sim = new Sim(new World(42));
  const pad = sim.world.startPad(BLUE);
  // 找一个能落塔基的点（canFound 与游戏内建房同源）。
  let site: { x: number; z: number } | null = null;
  outer: for (let r = 2; r <= 8; r += 1) {
    for (let a = 0; a < 16; a++) {
      const ang = (a / 16) * Math.PI * 2;
      const x = Math.round((pad.x + Math.cos(ang) * r) * 2) / 2;
      const z = Math.round((pad.z + Math.sin(ang) * r) * 2) / 2;
      if (sim.tryPrepFound(x, z, 0) && sim.foundSite(BLUE, x, z, 0, "tower")) {
        site = { x, z };
        break outer;
      }
    }
  }
  assert(!!site, "cost: 找到可落塔基的点位");
  const t = sim.buildings.find((b) => b.kind === "tower")!;
  assert(t.level === 0 && t.need === 1, "cost: L0 塔基 need=1");
  assert(t.padW === 0.6 && t.padD === 0.6, "cost: 塔基 pad 贴塔身 0.6（v0.28c 落基即最终尺寸）");

  sim.deliverWood(t); // 送满 1 捆 → completeStep → 落成 L1
  assert(t.level === 1, "cost: 送 1 捆木头即落成 L1（哨塔建造最快）");
  assert(t.padW === TOWER_PAD && t.padD === TOWER_PAD, `cost: 落成占地 ${TOWER_PAD}×${TOWER_PAD}`);
  console.log("testTowerCostAndCompletion ok");
}

/** b. 驻扎：选中牛战士右键自家哨塔 → 走到塔边爬塔上瞭望台；容量 3（v0.28e），第四人上不去。 */
function testGarrisonFlow(): void {
  const sim = new Sim(new World(42));
  const pad = sim.world.startPad(BLUE);
  const t = sim.placeComplete(BLUE, pad.x - 3, pad.z, 0, "tower", 1);

  const f1 = sim.addUnit(BLUE, "firewarrior", pad.x - 6, pad.z + 1);
  f1.selected = true;
  sim.orderMove(BLUE, t.x, t.z);
  assert(f1.targetId === t.id, "garrison: 右键哨塔已下达驻扎令（targetId=塔）");

  let inTower = false;
  for (let i = 0; i < 120; i++) {
    sim.tick(0.05);
    if (f1.homeId === t.id) {
      inTower = true;
      break;
    }
  }
  assert(inTower, "garrison: 牛战士走到塔边自动上塔（homeId=塔）");
  assert(!f1.selected && f1.atkId === 0, "garrison: 上塔后清选中/清战斗状态");

  // v0.28e 容量 3：第二、三名可继续上塔，第四名被拒。
  const f2 = sim.addUnit(BLUE, "firewarrior", pad.x - 6, pad.z - 1);
  const f3 = sim.addUnit(BLUE, "firewarrior", pad.x - 6, pad.z - 2);
  const f4 = sim.addUnit(BLUE, "firewarrior", pad.x - 6, pad.z - 3);
  for (const f of [f2, f3, f4]) {
    f.selected = true;
    sim.orderMove(BLUE, t.x, t.z);
  }
  for (let i = 0; i < 160; i++) sim.tick(0.05); // 爬塔 1.1s + 行军
  assert(f2.homeId === t.id && f3.homeId === t.id, "garrison: 塔容量 3，第二/三名可驻扎");
  assert(f4.homeId === 0, "garrison: 第四名被拒（容量 3）");
  assert(sim.towerGarrison(t).length === 3, "garrison: 驻军数 3");
  console.log("testGarrisonFlow ok");
}

/** c. 塔上射击：射程 2×（9 格）——7 格外敌人（地面射程 4.5 打不到）也会被塔顶火球命中。 */
function testTowerFire(): void {
  const sim = new Sim(new World(42));
  const pad = sim.world.startPad(BLUE);
  const t = sim.placeComplete(BLUE, pad.x - 3, pad.z, 0, "tower", 1);
  const f = sim.addUnit(BLUE, "firewarrior", pad.x - 3, pad.z + 2);
  f.selected = true;
  sim.orderMove(BLUE, t.x, t.z);
  for (let i = 0; i < 120; i++) {
    sim.tick(0.05);
    if (f.homeId === t.id) break;
  }
  assert(f.homeId === t.id, "fire: 牛战士已上塔");

  // 距塔 10 格的可射靶位：>7（v0.27g 地面射程，证 ×2），<14（塔上射程）。
  // 程序化找点：必须可走且与塔之间无地形遮挡（俯冲弹道仍会被中途土脊挡熄——
  // 这是"火球遇地形遮挡无法通过"的既有设计，测试只挑打得着的方向）。
  let fx = t.x + 10;
  let fz = t.z;
  for (let a = 0; a < 16; a++) {
    const ang = (a / 16) * Math.PI * 2;
    const x = t.x + Math.cos(ang) * 10;
    const z = t.z + Math.sin(ang) * 10;
    if (sim.world.walkableAt(x, z) && !sim.world.losBlocked(t.x, t.z, x, z)) {
      fx = x;
      fz = z;
      break;
    }
  }
  const foe = sim.addUnit(RED, "walker", fx, fz);
  foe.hp = 999;
  const foeX = foe.x;
  const foeZ = foe.z;
  let hit = false;
  for (let i = 0; i < 200; i++) {
    sim.tick(0.05);
    foe.x = foeX;
    foe.z = foeZ;
    foe.path = [];
    foe.pathI = 0;
    if (foe.hp < 999 || foe.downT > 0 || foe.flyVy !== 0) hit = true;
    if (hit) break;
  }
  assert(hit, "fire: 塔上 10 格外开火命中（射程 ×2=14 生效；地面 7 打不到）");
  console.log("testTowerFire ok");
}

/** d. 塔上视野 ×2：20 格外敌人（>地面锁敌 12，<塔上 24）会被锁定，但超出 9 格射程不开火。 */
function testTowerSight(): void {
  const sim = new Sim(new World(42));
  const pad = sim.world.startPad(BLUE);
  const t = sim.placeComplete(BLUE, pad.x - 3, pad.z, 0, "tower", 1);
  const f = sim.addUnit(BLUE, "firewarrior", pad.x - 3, pad.z + 2);
  f.selected = true;
  sim.orderMove(BLUE, t.x, t.z);
  for (let i = 0; i < 120; i++) {
    sim.tick(0.05);
    if (f.homeId === t.id) break;
  }
  assert(f.homeId === t.id, "sight: 牛战士已上塔");

  const foe = sim.addUnit(RED, "walker", t.x - 20, t.z); // 20 格：>12（地面锁敌），<24（塔上锁敌）；注意留在图内
  foe.hp = 999;
  const foeX = foe.x;
  const foeZ = foe.z;
  let locked = false;
  for (let i = 0; i < 40; i++) {
    sim.tick(0.05);
    foe.x = foeX;
    foe.z = foeZ;
    foe.path = [];
    foe.pathI = 0;
    if (f.atkId === foe.id) locked = true;
  }
  assert(locked, "sight: 塔上锁敌 24 格，20 格外敌人被锁定");
  assert(foe.hp === 999 && foe.downT === 0, "sight: 超出射程 9 格不开火（只锁不打）");
  console.log("testTowerSight ok");
}

/** e. 塔毁自动弹出：塔被打爆（先骨架后拆没）后驻军弹出到塔边、homeId 清零。 */
function testEjectOnDestroy(): void {
  const sim = new Sim(new World(42));
  const pad = sim.world.startPad(BLUE);
  const t = sim.placeComplete(BLUE, pad.x - 3, pad.z, 0, "tower", 1);
  const f = sim.addUnit(BLUE, "firewarrior", pad.x - 3, pad.z + 2);
  f.selected = true;
  sim.orderMove(BLUE, t.x, t.z);
  for (let i = 0; i < 120; i++) {
    sim.tick(0.05);
    if (f.homeId === t.id) break;
  }
  assert(f.homeId === t.id, "eject: 牛战士已上塔");

  sim.combatSystem.hurtBuilding(sim, t, 9999); // 第一击 → 骨架
  assert(t.hp > 0, "eject: 第一击成骨架（hp>0），驻军暂留");
  sim.combatSystem.hurtBuilding(sim, t, 9999); // 第二击 → 拆没
  assert(t.hp <= 0, "eject: 塔已拆没");
  sim.tick(0.05); // ejectRuinedTowers 在 production tick 里扫
  assert(f.homeId === 0, "eject: 塔毁后驻军自动弹出（homeId=0）");
  assert(f.hp > 0 && f.x > 0, "eject: 弹出后存活在塔边");
  console.log("testEjectOnDestroy ok");
}

/** f. 驻塔免疫直射火球：projectile 命中循环跳过 homeId>0，塔上牛战士不会被平射火球命中。 */
function testGarrisonImmuneToDirectFire(): void {
  const sim = new Sim(new World(42));
  const pad = sim.world.startPad(BLUE);
  const t = sim.placeComplete(BLUE, pad.x - 3, pad.z, 0, "tower", 1);
  const f = sim.addUnit(BLUE, "firewarrior", pad.x - 3, pad.z + 2);
  f.selected = true;
  sim.orderMove(BLUE, t.x, t.z);
  for (let i = 0; i < 120; i++) {
    sim.tick(0.05);
    if (f.homeId === t.id) break;
  }
  assert(f.homeId === t.id, "immune: 牛战士已上塔");
  const hp0 = f.hp;

  // 一发红方火球正穿塔顶驻军位置。
  sim.shots.push({
    x: f.x - 0.2,
    z: f.z,
    y: f.y + 2.7,
    vx: 4,
    vz: 0,
    team: RED,
    dmg: 5,
    life: 0.5,
    knock: 0,
    ox: f.x - 2,
    oz: f.z,
  });
  for (let i = 0; i < 10; i++) sim.combatSystem.projectiles(sim, 0.05);
  assert(f.hp === hp0, "immune: 驻塔期间不被直射火球命中（塔体保护）");
  console.log("testGarrisonImmuneToDirectFire ok");
}

/**
 * g. v0.27f 四面八方可射 + 永不伤自家塔：
 * 东南西北四个方向各站一个钉桩敌人（3 格，均在射程 9 内），塔上驻军必须全部命中；
 * 弹道从窗口高度俯冲而出，全程不得击中/摧毁自家塔（自家塔血量恒满）。
 */
function testOmniFireAndTowerSafe(): void {
  const sim = new Sim(new World(42));
  const pad = sim.world.startPad(BLUE);
  const t = sim.placeComplete(BLUE, pad.x - 3, pad.z, 0, "tower", 1);
  const f = sim.addUnit(BLUE, "firewarrior", pad.x - 3, pad.z + 2);
  f.selected = true;
  sim.orderMove(BLUE, t.x, t.z);
  for (let i = 0; i < 120; i++) {
    sim.tick(0.05);
    if (f.homeId === t.id) break;
  }
  assert(f.homeId === t.id, "omni: 牛战士已上塔");

  const dirs: [number, number][] = [
    [3, 0],
    [-3, 0],
    [0, 3],
    [0, -3],
  ];
  // 普通村民（6 血，两发火球即死）：塔会先杀最近者再转向下一个——四个方向都能轮到，
  // 才能证明火球穿窗而出、没有任何方向被自家塔体挡住。
  const foes: Unit[] = [];
  const hp0s: number[] = [];
  for (const [dx, dz] of dirs) {
    const foe = sim.addUnit(RED, "walker", t.x + dx, t.z + dz);
    hp0s.push(foe.hp);
    foes.push(foe);
  }
  const hitFlags = [false, false, false, false];
  for (let i = 0; i < 600; i++) {
    sim.tick(0.05); // 30 秒：攻击间隔 1.8s、每个目标约两发，四个方向逐一击杀
    for (let k = 0; k < foes.length; k++) {
      const foe = foes[k]!;
      if (foe.hp > 0) {
        const [dx, dz] = dirs[k]!;
        foe.x = t.x + dx;
        foe.z = t.z + dz;
        foe.path = [];
        foe.pathI = 0;
      }
      if (foe.hp < hp0s[k]! || foe.downT > 0 || foe.flyVy !== 0 || foe.hp <= 0) hitFlags[k] = true;
    }
  }
  for (let k = 0; k < hitFlags.length; k++) {
    assert(hitFlags[k], `omni: ${["东", "西", "南", "北"][k]}方向的敌人被命中（火球穿窗而出，四面八方通畅）`);
  }
  assert(t.hp === t.maxHp, `omni: 自家火球永不伤自家塔（hp=${t.hp}/${t.maxHp}）`);
  assert(t.hp > 0, "omni: 塨未因自身射击被摧毁");
  console.log("testOmniFireAndTowerSafe ok");
}

/** h. v0.27f 瘦身：占地缩为 0.9（直径 ≈ 旧边长 1.8 的一半）。 */
function testTowerSlimFootprint(): void {
  assert(TOWER_PAD === 0.6, "slim: 哨塔地基贴塔身（建模 0.5，地基 0.6）");
  console.log("testTowerSlimFootprint ok");
}

testTowerCostAndCompletion();
testGarrisonFlow();
testTowerFire();
testTowerSight();
testEjectOnDestroy();
testGarrisonImmuneToDirectFire();
testOmniFireAndTowerSafe();
testTowerSlimFootprint();
console.log("tower-garrison-check 全部通过（v0.27-3 建造/驻扎/射击/弹出 + v0.27f 瘦身魔法塔/全方位射击/不伤自家塔）");
