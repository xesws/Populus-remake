// v0.31 敌方 AI 测试（feature：建营者保护 + 营地后方选址 → 火战士/间谍兵种线解锁）。
// 背景：旧链路三处互锁 bug——assignHomes 吸走建营者、occupy 不清 foundKind 永久占死名额、
// 批量训兵把营者训成武士——导致红方 87 局日志 firewarrior 成功 0 次。本文件逐条验证修复。
// 纯 node 可跑（npx tsx src/game/ai-founder-check.ts）。

import { EconomyDirector } from "./ai/economy-director";
import { AIDirector, AIProfile } from "./ai";
import { Sim } from "./sim";
import { BLUE, dist2, RED, Unit } from "./types";
import { World } from "./world";

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

function play(sim: Sim, dir: AIDirector, simTime: number): void {
  for (let t = 0; t < simTime; t += 0.05) {
    sim.tick(0.05);
    dir.update(sim, 0.05);
  }
}

/** 找一座红方开局茅屋（L1、有空位）。 */
function redHut(sim: Sim) {
  const hut = sim.buildings.find((b) => b.team === RED && b.kind === "hut" && b.level >= 1 && b.hp > 0);
  assert(hut !== undefined, "红方开局应有茅屋");
  return hut!;
}

/** test 1（A1）：建营者被吸进茅屋入住时，foundKind/settle 坐标必须一并卸任。 */
function testOccupyClearsFounderRole(): void {
  const sim = new Sim(new World(42));
  const hut = redHut(sim);
  const door = sim.hutDoor(hut);
  const u: Unit = sim.addUnit(RED, "walker", door.x, door.z);
  u.foundKind = "temple"; // 模拟正在前往建 temple 的营者
  u.settleX = door.x + 3;
  u.settleZ = door.z + 3;
  u.targetId = hut.id;
  assert(sim.tryOccupy(u), "门口村民应能入住");
  assert(u.homeId === hut.id, "入住成功");
  assert(u.foundKind === null, "入住即卸任：foundKind 清空（旧实现占死名额的根因）");
  assert(u.settleX < 0 && u.settleZ < 0, "settle 坐标作废（防出屋后误落 hut）");
  console.log("testOccupyClearsFounderRole ok");
}

/** test 2（A2）：assignHomes 不许碰带建设任务（foundKind）的村民。 */
function testAssignHomesSparesFounder(): void {
  const sim = new Sim(new World(42));
  const hut = redHut(sim);
  const door = sim.hutDoor(hut);
  const founder: Unit = sim.addUnit(RED, "walker", door.x + 1.5, door.z + 1.5);
  founder.foundKind = "fireHut";
  const eco = new EconomyDirector(RED, AIProfile.normal());
  eco.update(sim, 1.1); // 越过 tickSec=1.0 触发一轮 assignHomes
  assert(founder.targetId === 0, `建营者不得被指派入住（targetId=${founder.targetId}）`);
  assert(founder.foundKind === "fireHut", "建营者任务保持不变");
  console.log("testAssignHomesSparesFounder ok");
}

/** test 3（A3a）：批量训兵不吞建营者——训练营排队时 foundKind 村民必须留在工地。 */
function testBatchTrainSparesFounder(): void {
  const sim = new Sim(new World(42));
  const hut = redHut(sim);
  const made = sim.foundSite(RED, hut.x + 6, hut.z, 0, "warriorHut");
  assert(made !== null, " warriorHut 地基应能落下");
  sim.upgradeBuilding(made!, 1); // 直接升到 L1，训练可用
  const founder: Unit = sim.addUnit(RED, "walker", hut.x + 2, hut.z + 2);
  founder.foundKind = "temple";
  const a: Unit = sim.addUnit(RED, "walker", hut.x + 3, hut.z + 3);
  const b: Unit = sim.addUnit(RED, "walker", hut.x + 4, hut.z + 4);
  assert(sim.train(RED, "warrior"), "有营有村民，训练应成功");
  assert(founder.job !== "train", "建营者不得被征入训练营");
  assert(founder.foundKind === "temple", "建营者任务保持不变");
  assert(a.job === "train" && b.job === "train", "其余村民正常入队训练");
  console.log("testBatchTrainSparesFounder ok");
}

/** test 4（A3b）：该营地已有 L0 地基时不得重复派营者（旧实现会反复落基、重复工地）。 */
function testFoundationCoversWanted(): void {
  const sim = new Sim(new World(42));
  const hut = redHut(sim);
  const made = sim.foundSite(RED, hut.x + 6, hut.z, 0, "fireHut");
  assert(made !== null, "fireHut 地基应能落下");
  assert(made!.level === 0, "地基为 L0");
  assert(sim.train(RED, "firewarrior") === false, "无 L1 火战士营，训练失败");
  const founders = sim.units.filter((u) => u.team === RED && u.kind === "walker" && u.foundKind === "fireHut");
  assert(founders.length === 0, `L0 地基已存在，不得再派建营者（实际 ${founders.length} 名）`);
  console.log("testFoundationCoversWanted ok");
}

/** test 5（A4+阶梯）：兵种阶梯能走到火战士——有 2 武士 + 1 传教士且无火战士时，下一轮训的必须是火战士。 */
function testLadderReachesFirewarrior(): void {
  const sim = new Sim(new World(42));
  const hut = redHut(sim);
  for (const kind of ["warriorHut", "temple", "fireHut"] as const) {
    const made = sim.foundSite(RED, hut.x + 6 + (kind === "temple" ? 0 : kind === "fireHut" ? 3 : -3), hut.z, 0, kind);
    assert(made !== null, `${kind} 地基应能落下`);
    sim.upgradeBuilding(made!, 1);
  }
  sim.addUnit(RED, "warrior", hut.x + 1, hut.z + 1);
  sim.addUnit(RED, "warrior", hut.x + 1.5, hut.z + 1.5);
  sim.addUnit(RED, "preacher", hut.x + 2, hut.z + 2);
  for (let i = 0; i < 14; i++) sim.addUnit(RED, "walker", hut.x + 2 + i * 0.4, hut.z + 3);
  const dir = new AIDirector([[RED, AIProfile.normal()]]);
  dir.attach(sim);
  play(sim, dir, 40); // tryTrain 冷却 8s：足够完成一次决策+训练+转兵
  const fires = sim.units.filter((u) => u.team === RED && u.kind === "firewarrior");
  assert(fires.length >= 1, `兵种阶梯应产出火战士（实际 ${fires.length}）`);
  console.log("testLadderReachesFirewarrior ok");
}

/** test 6（端到端 + B）：AIDirector 空推 480s——红方自主走完 武士营→神庙→火战士营 并训出过火战士；
 *  且所有营地在自家半场（到红方出生点比到蓝方出生点近，营地不再顶到前线）。
 *  稳定性处理：移除蓝方祭司（排除远程战损干扰——本用例测的是经济/训兵链路，不是战斗），
 *  并周期性补蓝方村民，防止红方提前推平蓝方导致 winner 落定、AI 停摆。 */
function testEndToEndAndHomeSideCamps(): void {
  const sim = new Sim(new World(42));
  const dir = new AIDirector([[RED, AIProfile.normal()]]);
  dir.attach(sim);
  for (const s of sim.units.filter((u) => u.team === BLUE && u.kind === "shaman")) s.hp = 0;
  const bluePad = sim.world.startPad(BLUE);
  const blueSpot = ((): { x: number; z: number } => {
    for (let r = 0; r < 8; r++) {
      for (let a = 0; a < 8; a++) {
        const x = bluePad.x + Math.cos((a / 8) * Math.PI * 2) * r * 1.2;
        const z = bluePad.z + Math.sin((a / 8) * Math.PI * 2) * r * 1.2;
        if (sim.world.walkableAt(x, z)) return { x, z };
      }
    }
    return bluePad;
  })();
  let everFire = false;
  for (let t = 0; t < 480 * 20; t++) {
    sim.tick(0.05);
    // 本用例不终结对局：红方推平蓝方会触发 winner 落定、AI 停摆——每帧复位。
    sim.winner = null;
    dir.update(sim, 0.05);
    // 火战士会随进攻波次消耗（战死），断言"训出过"而非"终局在场"。
    if (!everFire && sim.units.some((u) => u.team === RED && u.kind === "firewarrior")) everFire = true;
    if (t % 600 === 0) {
      // 补蓝方村民保持 foeWalk；重生碑锁血（配合 winner 复位双保险）。
      if (sim.countKind(BLUE, "walker") < 2) sim.addUnit(BLUE, "walker", blueSpot.x, blueSpot.z);
      const rebirth = sim.buildings.find((b) => b.team === BLUE && b.kind === "rebirth");
      if (rebirth) rebirth.hp = rebirth.maxHp;
    }
  }
  const camps = sim.buildings.filter(
    (b) => b.team === RED && b.hp > 0 && b.level >= 1 && ["warriorHut", "temple", "fireHut"].includes(b.kind),
  );
  assert(camps.some((b) => b.kind === "warriorHut"), "480s 内应建成武士营");
  assert(camps.some((b) => b.kind === "temple"), "480s 内应建成神庙（传教士线打通）");
  assert(camps.some((b) => b.kind === "fireHut"), "480s 内应建成火战士营（旧实现 0 次的断链已修复）");
  assert(everFire, "480s 内应训出过至少 1 名火战士（兵种阶梯走通）");
  const redPad = sim.world.startPad(RED);
  for (const c of camps) {
    const dRed = dist2(c.x, c.z, redPad.x, redPad.z);
    const dBlue = dist2(c.x, c.z, bluePad.x, bluePad.z);
    assert(dRed < dBlue, `营地(${c.kind}) 应在自家半场：到红方 ${Math.sqrt(dRed).toFixed(1)} < 到蓝方 ${Math.sqrt(dBlue).toFixed(1)}`);
  }
  console.log("testEndToEndAndHomeSideCamps ok");
}

testOccupyClearsFounderRole();
testAssignHomesSparesFounder();
testBatchTrainSparesFounder();
testFoundationCoversWanted();
testLadderReachesFirewarrior();
testEndToEndAndHomeSideCamps();
console.log("ai-founder-check ok (v0.31 建营者保护：卸任/免征/免入住/地基覆盖 + 兵种阶梯到火战士 + 营地后方选址)");
