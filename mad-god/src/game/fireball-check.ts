/**
 * v0.26 火球法术检查（`npm run check` 第 28 项）
 * 针对 feature：火球——立即命中，击飞 + 立即伤害 + 着火持续轻微伤害。
 *
 * 覆盖：
 *  a) 范围内敌方单位：掉 FIREBALL_DMG（8）血、被击飞（flyVy>0）、burnT=5；
 *  b) 着火持续伤害：burnT 期间约 burnDps(1.2)/秒扣血；
 *  c) 范围外单位（>1.7 格）不受伤；
 *  d) 己方单位不被打（火球只打非己方）；
 *  e) 槽扣 1 颗、不足拒绝；
 *  f) 落空时无伤害但依旧扣颗（施放即扣，与 blast 同口径）。
 */
import { Sim } from "./sim";
import { BLUE, FIREBALL_BURN_DPS, FIREBALL_BURN_T, FIREBALL_DMG, RED } from "./types";
import { World } from "./world";
import { cast } from "./spells";

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

function clearSpot(sim: Sim, x: number, z: number): { x: number; z: number } {
  for (let r = 0; r < 6; r++) {
    for (let a = 0; a < 12; a++) {
      const cx = x + Math.cos((a / 12) * Math.PI * 2) * r * 1.2;
      const cz = z + Math.sin((a / 12) * Math.PI * 2) * r * 1.2;
      if (sim.world.walkableAt(cx, cz) && sim.units.every((o) => (o.x - cx) ** 2 + (o.z - cz) ** 2 > 4)) {
        return { x: cx, z: cz };
      }
    }
  }
  return { x, z };
}

function testFireballHit(): void {
  const sim = new Sim(new World(42));
  sim.fillCharges(BLUE);
  const spot = clearSpot(sim, 30, 30);
  // 目标用 warrior（hp 24+3s=27）：walker 只有 6 血，会被 8 点直接伤害秒杀，测不出灼烧。
  const foe = sim.addUnit(RED, "warrior", spot.x + 0.3, spot.z + 0.3);
  const self = sim.addUnit(BLUE, "walker", spot.x - 0.8, spot.z - 0.8);
  const far = sim.addUnit(RED, "warrior", spot.x + 4, spot.z + 4); // 4 格外：范围 1.7 之外
  const hp0 = foe.hp;
  const hpFar = far.hp;
  const hpSelf = self.hp;

  const res = cast(sim, BLUE, "fireball", spot.x, spot.z, 0);
  assert(res.ok, `cast ok（${res.msg}）`);
  assert(foe.hp === hp0 - FIREBALL_DMG, `命中掉 ${FIREBALL_DMG} 血（got ${hp0 - foe.hp}）`);
  assert(foe.flyVy > 0, "命中单位被击飞（flyVy>0）");
  assert(foe.burnT > 0, `着火 burnT=${foe.burnT} > 0`);
  assert(far.hp === hpFar, "范围外单位不受伤");
  assert(self.hp === hpSelf, "己方单位不被打");

  // 灼烧测试：清场只剩两个同队 warrior（互相无敌人可打），sim.tick 3 秒只量灼烧。
  sim.units = sim.units.filter((u) => u.id === foe.id || u.id === far.id);
  for (let i = 0; i < 3 * 60; i++) sim.tick(1 / 60);
  const burnLost = hp0 - FIREBALL_DMG - foe.hp;
  assert(burnLost > FIREBALL_BURN_DPS * 2 - 1, `3 秒灼烧约 ${(FIREBALL_BURN_DPS * 3).toFixed(1)} 血（got ${burnLost.toFixed(1)}）`);
  assert(burnLost < FIREBALL_BURN_DPS * 3 + 2, "灼烧伤害不超标（没有叠加其他伤害源）");
  console.log(`  ✓ 火球命中：-${FIREBALL_DMG} 血 + 击飞 + burnT=${FIREBALL_BURN_T}s，3s 灼烧 ${burnLost.toFixed(1)} 血`);
}

function testFireballCharge(): void {
  const sim = new Sim(new World(42));
  const c = sim.chargeState(BLUE, "fireball");
  c.cur = 0;
  const spot = clearSpot(sim, 34, 34);
  const r = cast(sim, BLUE, "fireball", spot.x, spot.z, 0);
  assert(!r.ok && r.msg.includes("法力"), "无颗时拒绝");
  sim.fillCharges(BLUE);
  const n0 = c.cur;
  cast(sim, BLUE, "fireball", 35, 35, 0); // 落空也扣颗
  assert(c.cur === n0 - 1, "施放即扣 1 颗（含落空）");
  console.log("  ✓ 火球充能：无颗拒绝、施放扣 1 颗");
}

function main(): void {
  console.log("v0.26 火球法术检查");
  testFireballHit();
  testFireballCharge();
  console.log("PASS: 命中击飞+灼烧 / 范围与阵营过滤 / 充能消耗");
}

main();
