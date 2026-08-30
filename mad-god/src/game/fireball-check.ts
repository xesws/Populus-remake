/**
 * v0.27f 火球法术检查（天降陨石重构）。
 * 针对 feature：火球——从天而降（约 0.85s 落地）、撞击小直接伤害 + 点燃（主伤害靠灼烧），
 * 不再立即命中 + 击飞蒸发。
 *
 * 覆盖：
 *  a) 施放：扣 1 颗、高空生成陨石（sim.meteors）、目标此刻无伤；
 *  b) 下落：0.4s 后仍在空中、无任何伤害；
 *  c) 撞击：范围内敌方单位 -FIREBALL_IMPACT_DMG、被点燃（fireT/burnT>0）、不被击飞（flyVy=0）；
 *     范围外与己方不受影响；
 *  d) 灼烧致死：村民 6 血 → 撞击剩 3 → 约 2 秒内被烧死（可见的燃烧死亡，非瞬秒）；
 *  e) 无颗拒绝且不生成陨石。
 */
import { Sim } from "./sim";
import { BLUE, FIREBALL_IMPACT_DMG, RED } from "./types";
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

function testMeteorFallsAndBurns(): void {
  const sim = new Sim(new World(42));
  sim.fillCharges(BLUE);
  const spot = clearSpot(sim, 30, 30);
  const foe = sim.addUnit(RED, "warrior", spot.x + 0.3, spot.z + 0.3); // 27 血：扛得住撞击，量灼烧
  const villager = sim.addUnit(RED, "walker", spot.x - 0.4, spot.z + 0.5); // 6 血：撞击剩 3，烧 ~2s 死
  const far = sim.addUnit(RED, "warrior", spot.x + 4, spot.z + 4); // 范围 1.7 之外
  const self = sim.addUnit(BLUE, "walker", spot.x - 0.8, spot.z - 0.8); // 己方不受影响
  const hp0 = foe.hp;
  const hpV0 = villager.hp;
  const hpFar = far.hp;
  const hpSelf = self.hp;

  // 钉桩：防目标自主移动出圈/进圈。
  const pin = () => {
    for (const [u, x, z] of [
      [foe, spot.x + 0.3, spot.z + 0.3],
      [villager, spot.x - 0.4, spot.z + 0.5],
      [far, spot.x + 4, spot.z + 4],
      [self, spot.x - 0.8, spot.z - 0.8],
    ] as const) {
      (u as typeof foe).x = x;
      (u as typeof foe).z = z;
      (u as typeof foe).path = [];
      (u as typeof foe).pathI = 0;
    }
  };

  // a) 施放：陨石入列、立即无伤。
  const res = cast(sim, BLUE, "fireball", spot.x, spot.z, 0);
  assert(res.ok, `cast ok（${res.msg}）`);
  assert(sim.meteors.length === 1, "施放生成 1 颗高空陨石");
  assert(foe.hp === hp0 && villager.hp === hpV0, "施放瞬间无任何伤害（不再立即命中）");

  // b) 下落：0.4s 后仍在空中。
  for (let i = 0; i < 24; i++) {
    sim.tick(1 / 60);
    pin();
  }
  assert(sim.meteors.length === 1 && sim.meteors[0]!.y < 13 - 5, `下落中（y=${sim.meteors[0]!.y.toFixed(1)}）`);
  assert(foe.hp === hp0, "落地前无伤害");

  // c) 落地撞击（13/15 ≈ 0.87s，再给 1 秒余量）。
  for (let i = 0; i < 60 && sim.meteors.length > 0; i++) {
    sim.tick(1 / 60);
    pin();
  }
  assert(sim.meteors.length === 0, "陨石已落地");
  const impactLost = hp0 - foe.hp;
  assert(impactLost >= FIREBALL_IMPACT_DMG && impactLost <= FIREBALL_IMPACT_DMG + 0.2, `撞击扣 ${FIREBALL_IMPACT_DMG} 血（got ${impactLost}，含同帧一小口灼烧）`);
  assert(foe.burnT > 0, `被点燃 burnT=${foe.burnT.toFixed(1)} > 0`);
  assert(foe.fireT > 0, "视觉火焰 fireT > 0");
  assert(foe.flyVy === 0, "不被击飞（不再瞬间蒸发）");
  assert(villager.hp <= hpV0 - FIREBALL_IMPACT_DMG && villager.hp >= hpV0 - FIREBALL_IMPACT_DMG - 0.2, "村民同受撞击伤害（剩 ~3 血）");
  assert(far.hp === hpFar, "范围外单位不受伤");
  assert(self.hp === hpSelf, "己方单位不被打");

  // d) 灼烧致死：村民 3 血 @1.6/s ≈ 1.9s 烧死；warrior 只掉灼烧血。
  let villagerDied = false;
  let diedOnFire = false;
  for (let i = 0; i < 4 * 60; i++) {
    sim.tick(1 / 60);
    pin();
    if (villager.hp <= 0 && !villagerDied) {
      villagerDied = true;
      diedOnFire = villager.fireT > 0 || villager.burnT > 0; // 死亡时刻仍在燃烧（可见的烧死）
    }
    if (foe.hp <= 0) break;
  }
  assert(villagerDied && diedOnFire, "村民被活活烧死（死亡时身上带火，非瞬秒）");
  const burnLost = hp0 - impactLost - foe.hp;
  assert(burnLost > 2, `warrior 持续掉灼烧血（got ${burnLost.toFixed(1)}）`);
  console.log("testMeteorFallsAndBurns ok");
}

/** e) 无颗拒绝且不生成陨石。 */
function testNoChargeNoMeteor(): void {
  const sim = new Sim(new World(42)); // 开局 0 颗（v0.26d）
  const before = sim.units.length;
  const res = cast(sim, BLUE, "fireball", 30, 30, 0);
  assert(!res.ok, "无颗施放被拒绝");
  assert(sim.meteors.length === 0, "拒绝时不生成陨石");
  assert(sim.units.length === before, "无人受伤");
  console.log("testNoChargeNoMeteor ok");
}

testMeteorFallsAndBurns();
testNoChargeNoMeteor();
console.log("fireball-check 全部通过（v0.27f 天降陨石 + 撞击点燃 + 灼烧致死）");
