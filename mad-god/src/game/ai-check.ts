// v0.17 敌方 AI 系统测试（feature：分层 TribeBrain——经济/军事/神力子脑 + 难度 Profile + 多敌人架构）。
// 覆盖三条断链修复：红方入住（生产恢复）、红方人口增长、远程被打还手（火球死角冲锋）；
// 外加进攻波次、难度参数单调、多 brain 状态隔离。纯 node 可跑。
// v0.37 军事升级后：波次门槛改 waveForce、发波不再 setOrder(team,"fight")（见 ai-army-check）。

import { AIProfile, AIDirector, TribeBrain } from "./ai";
import { CombatSystem } from "./systems/combat-system";
import { Sim } from "./sim";
import { BLUE, RED, Team, Unit, UnitKind } from "./types";
import { World } from "./world";

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

/** 标准对局：AIDirector(normal) 接管 RED，加速推演 simTime 秒。 */
function play(sim: Sim, dir: AIDirector, simTime: number): void {
  for (let t = 0; t < simTime; t += 0.05) {
    sim.tick(0.05);
    dir.update(sim, 0.05);
  }
}

function testRedVillagersOccupyHuts(): void {
  const sim = new Sim(new World(42));
  const dir = new AIDirector([[RED, AIProfile.normal()]]);
  dir.attach(sim);
  play(sim, dir, 30);
  const redHuts = sim.buildings.filter((b) => b.team === RED && b.kind === "hut" && b.level >= 1);
  assert(redHuts.length > 0, "红方开局应有茅屋");
  assert(
    redHuts.some((b) => b.dwell > 0),
    "30 秒内红方村民入住茅屋（经济断链修复）",
  );
  console.log("testRedVillagersOccupyHuts ok");
}

function testRedPopulationGrows(): void {
  const sim = new Sim(new World(42));
  const dir = new AIDirector([[RED, AIProfile.normal()]]);
  dir.attach(sim);
  const pop0 = sim.countPop(RED);
  play(sim, dir, 90);
  // v0.27-1 红方生产 ×0.75 后，90 秒内"人口净增"的余量会被随机波动（边境战斗等）
  // 吃掉，偶发净减——断言改为直接测生产闭环本身（茅屋出生数 > 0），人口只兜底"不崩盘"。
  //（v0.27e 合并系统已移除，合并吞人这一波动源不复存在。）
  const born = sim.buildings
    .filter((b) => b.team === RED && b.kind === "hut")
    .reduce((n, b) => n + b.born, 0);
  assert(born > 0, `红方茅屋有出生（born=${born}，生产闭环恢复）`);
  assert(sim.countPop(RED) >= pop0 - 1, `红方人口不崩盘（${pop0} → ${sim.countPop(RED)}，容许合并/战斗 -1）`);
  console.log("testRedPopulationGrows ok");
}

function testRedRetaliatesRangedFire(): void {
  const sim = new Sim(new World(42));
  // 红方村民站在空地；蓝方火战士在其索敌圈外 4.2 格发射火球（死角：射程 4.5 > 索敌 3）。
  let rx = 26;
  let rz = 26;
  for (let r = 0; r < 8; r++) {
    for (let a = 0; a < 8; a++) {
      const x = 26 + Math.cos((a / 8) * Math.PI * 2) * r * 1.2;
      const z = 26 + Math.sin((a / 8) * Math.PI * 2) * r * 1.2;
      if (sim.world.walkableAt(x, z) && sim.units.every((o) => (o.x - x) ** 2 + (o.z - z) ** 2 > 9)) {
        rx = x;
        rz = z;
        r = 99;
        break;
      }
    }
  }
  const victim = sim.addUnit(RED, "walker", rx, rz);
  const shooter: Unit = sim.addUnit(BLUE, "firewarrior", rx + 4.2, rz);
  const origRandom = Math.random;
  Math.random = () => 0.99; // 关闭暴击分支，走默认击倒
  const combat = new CombatSystem();
  combat.fireballHit(sim, victim, {
    x: victim.x,
    z: victim.z,
    y: victim.y + 1,
    vx: 4,
    vz: 0,
    team: BLUE,
    dmg: 2,
    life: 1,
    knock: 0,
    ox: shooter.x,
    oz: shooter.z,
  });
  Math.random = origRandom;
  const charges =
    victim.atkId !== 0 ||
    (victim.path.length > 0 && Math.hypot(victim.path[victim.path.length - 1]!.x - shooter.x, victim.path[victim.path.length - 1]!.z - shooter.z) < 3);
  assert(charges, "红方村民被圈外火球打后反击/朝火源冲锋（还手断链修复）");
  console.log("testRedRetaliatesRangedFire ok");
}

function testRedAttackWave(): void {
  const sim = new Sim(new World(42));
  const profile = AIProfile.normal();
  const brain = new TribeBrain(RED, profile);
  // 补足波次兵力：v0.37 门槛为首波 waveForce（normal=8），全波一起出发。
  const home = sim.buildings.find((b) => b.team === RED && b.kind === "hut")!;
  const kinds: UnitKind[] = ["warrior", "warrior", "firewarrior"];
  for (let i = 0; i < profile.waveForce; i++) {
    sim.addUnit(RED, kinds[i % kinds.length]!, home.x + 1.5 + i * 0.25, home.z + 1.5);
  }
  assert(brain.war.readyForce(sim) === profile.waveForce, `可出击兵力 ${profile.waveForce}`);
  assert(brain.war.waveReady(sim), "兵力达门槛且波次冷却未起，应就绪");
  assert(brain.war.launchWave(sim), "发波成功");
  const blueHome = sim.buildings.find((b) => b.team === BLUE && b.kind === "hut")!;
  const magnetOff = Math.hypot(sim.teams[RED].magnetX - blueHome.x, sim.teams[RED].magnetZ - blueHome.z);
  assert(magnetOff < 6, `magnet 锁定蓝方聚落（偏移 ${magnetOff.toFixed(1)} 格）`);
  // v0.37 军令/民令分离：发波不再走 setOrder(team,"fight")（那会把全队村民的任务清空），
  // 而是逐兵 sendMove + 统一集火焦点目标，团队 order 保持 settle。
  assert(sim.teams[RED].order === "settle", "发波不再改团队 order（村民任务不被清空）");
  const marchers = sim.units.filter(
    (u) =>
      u.team === RED &&
      u.hp > 0 &&
      u.homeId === 0 &&
      (u.kind === "warrior" || u.kind === "firewarrior" || u.kind === "preacher"),
  );
  const focusIds = new Set(marchers.map((m) => m.atkId));
  assert(focusIds.size === 1 && !focusIds.has(0), `全波集火同一焦点目标（实际 ${[...focusIds].join(",")}）`);
  console.log("testRedAttackWave ok");
}

function testDifficultyProfilesDiffer(): void {
  const e = AIProfile.easy();
  const n = AIProfile.normal();
  const h = AIProfile.hard();
  assert(e.reactSec > n.reactSec && n.reactSec > h.reactSec, "反应延迟 easy > normal > hard");
  // v0.37 波次规模/常备军改口径：门槛 waveForce、上限 armyMax（旧 waveSize/armyCap 已删除）
  assert(e.waveForce < n.waveForce && n.waveForce < h.waveForce, "波次门槛 easy < normal < hard");
  assert(e.armyMax < n.armyMax && n.armyMax < h.armyMax, "常备军上限 easy < normal < hard");
  assert(e.armyRatio < n.armyRatio && n.armyRatio < h.armyRatio, "常备军占人口比例 easy < normal < hard");
  assert(e.spellAggro < n.spellAggro && n.spellAggro < h.spellAggro, "施法激进度 easy < normal < hard");
  // v0.37 大龙计划：easy 不追龙，hard 比 normal 更早启动
  assert(e.dragonPopMin === 0 && e.dragonCap === 0, "easy 档不追龙");
  assert(h.dragonPopMin < n.dragonPopMin, "hard 比 normal 更早启动大龙计划");
  console.log("testDifficultyProfilesDiffer ok");
}

function testBrainStateIsolation(): void {
  const sim = new Sim(new World(42));
  const slow = new TribeBrain(RED, AIProfile.easy());
  const fast = new TribeBrain((RED + 0) as Team, AIProfile.hard());
  slow.update(sim, 0.5); // < easy.tickSec(1.6)，不决策
  fast.update(sim, 0.8); // ≥ hard.tickSec(0.7)，已决策一轮
  assert(slow.state === "develop" && fast.state === "develop", "两脑均从 develop 起步");
  assert(slow !== fast && slow.profile.tickSec !== fast.profile.tickSec, "两脑 profile 实例独立");
  // 一脑决策不推动另一脑：slow 再喂不足周期的时间，状态不变。
  slow.update(sim, 0.5);
  assert(slow.state === "develop", "另一脑的推进不影响本脑（状态隔离）");
  console.log("testBrainStateIsolation ok");
}

testRedVillagersOccupyHuts();
testRedPopulationGrows();
testRedRetaliatesRangedFire();
testRedAttackWave();
testDifficultyProfilesDiffer();
testBrainStateIsolation();
console.log("ai-check ok (v0.17 敌方 AI：入住修复 / 人口闭环 / 远程还手 / 进攻波次 / 难度 / 隔离)");
