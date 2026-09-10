// v0.37 敌方 AI 行为探针（脚本，不进 npm run check）：无头长局观测量化"AI 打得凶不凶"。
//
// 用法：npx tsx scripts/probe-ai-army.ts [easy|normal|hard] [分钟]
//
// 观测口径（对应用户实测抱怨的三条）：
//   ① 常备军规模：只记红方战斗兵（武士/牛战士/传教士）峰值与人口，看它会不会把村民转成兵；
//   ② 兵种配比：牛战士数量（"不知道去出别的兵种"）+ 大龙训练营进度/大龙条数（"不会拿火武士训大龙"）；
//   ③ 波次规模：每次发波时的出击兵力（"只派一两个、三个武士来骚扰"）。
//
// 蓝方为"木头玩家"：不操作、只维持不灭（每 30s 补村民、锁血重生碑与茅屋），
// 这样红方的行为不会被对局提前结束打断，便于观察长局节奏。

import { AIDirector, AIProfile, ArmyPolicy } from "../src/game/ai";
import { logger, MemorySink } from "../src/game/logger";
import { Sim } from "../src/game/sim";
import { BLUE, Building, DRAGON_GARRISON_MAX, RED, Team } from "../src/game/types";
import { World } from "../src/game/world";

const level = (process.argv[2] ?? "normal") as "easy" | "normal" | "hard";
const minutes = Number(process.argv[3] ?? "6");
const profile = level === "easy" ? AIProfile.easy() : level === "hard" ? AIProfile.hard() : AIProfile.normal();

// --log：把 AI 子脑日志收进内存并分类打印（无头排查专用；默认关闭避免刷屏）
const wantLog = process.argv.includes("--log");
const sink = new MemorySink();
if (wantLog) logger.setSink(sink);

function soldiers(sim: Sim, team: Team): { warrior: number; fire: number; preacher: number; spy: number } {
  const c = (k: string) => sim.units.filter((u) => u.team === team && u.hp > 0 && u.kind === k).length;
  return { warrior: c("warrior"), fire: c("firewarrior"), preacher: c("preacher"), spy: c("spy") };
}

function keepBlueAlive(sim: Sim): void {
  const blueSpot = sim.world.startPad(BLUE);
  if (sim.countKind(BLUE, "walker") < 4) {
    for (let i = 0; i < 3; i++) sim.addUnit(BLUE, "walker", blueSpot.x + 1 + i * 0.5, blueSpot.z + 2);
  }
  for (const b of sim.buildings) {
    if (b.team !== BLUE) continue;
    b.hp = b.maxHp;
  }
  const shaman = sim.units.find((u) => u.team === BLUE && u.kind === "shaman");
  if (shaman) shaman.hp = shaman.maxHp;
}

const sim = new Sim(new World(42));
const dir = new AIDirector([[RED, profile]]);
dir.attach(sim);
const brain = dir.brains[0]!;

let peakSoldiers = 0;
let waveSizes: number[] = [];
let lastWaves = 0;
let firstWaveAt = -1;
let firstFireAt = -1;
let factoryAt = -1;
let dragonAt = -1;
const factory0 = () => sim.buildings.find((b) => b.team === RED && b.kind === "dragonFactory");

console.log(`probe-ai-army: level=${level} 时长=${minutes} 分钟（seed=42，蓝方为木头玩家）`);
console.log("  t(s)  红人口  武士  牛战  传教  战场军力  状态      波次  门槛  工厂  大龙  蓝人口");
const total = minutes * 60;
for (let t = 0; t < total; t += 0.05) {
  sim.tick(0.05);
  sim.winner = null; // 观测量化：不让对局提前结束
  dir.update(sim, 0.05);
  if (t % 30 === 0) keepBlueAlive(sim);

  const s = soldiers(sim, RED);
  const totalSoldiers = s.warrior + s.fire + s.preacher + s.spy;
  if (totalSoldiers > peakSoldiers) peakSoldiers = totalSoldiers;
  if (brain.war.waves > lastWaves) {
    lastWaves = brain.war.waves;
    if (firstWaveAt < 0) firstWaveAt = t;
    waveSizes.push(brain.war.readyForce(sim));
  }
  if (firstFireAt < 0 && s.fire > 0) firstFireAt = t;
  const f = factory0();
  if (factoryAt < 0 && f && f.level >= 1) factoryAt = t;
  if (dragonAt < 0 && sim.countKind(RED, "dragon") > 0) dragonAt = t;

  if (Math.round(t * 20) % 600 === 0) {
    console.log(
      `  ${String(Math.round(t)).padStart(4)}  ${String(sim.countPop(RED)).padStart(6)}  ${String(s.warrior).padStart(4)}  ${String(s.fire).padStart(4)}  ${String(s.preacher).padStart(4)}  ${String(brain.war.readyForce(sim)).padStart(8)}  ${brain.state.padEnd(9)}  ${String(brain.war.waves).padStart(4)}  ${String(brain.war.waveThreshold).padStart(4)}  ${f ? `${f.dwell}/${DRAGON_GARRISON_MAX}`.padEnd(5) : " -   "}  ${String(sim.countKind(RED, "dragon")).padStart(4)}  ${String(sim.countPop(BLUE)).padStart(6)}`,
    );
  }
}

const blueHouses = sim.buildings.filter((b) => b.team === BLUE && b.kind === "hut" && b.hp > 0) as Building[];
console.log(
  `\n结果：常备军峰值=${peakSoldiers} 兵种=武士${soldiers(sim, RED).warrior}/牛战${soldiers(sim, RED).fire}`,
);
console.log(
  `      首波=${firstWaveAt < 0 ? "无" : `${firstWaveAt.toFixed(0)}s`} 波次=${waveSizes.length} 每波出击=${waveSizes.join(",") || "无"}`,
);
console.log(
  `      首个牛战士=${firstFireAt < 0 ? "无" : `${firstFireAt.toFixed(0)}s`} 大龙训练营=${factoryAt < 0 ? "无" : `${factoryAt.toFixed(0)}s`} 大龙=${dragonAt < 0 ? "无" : `${dragonAt.toFixed(0)}s`}`,
);
console.log(`      末态：红波次门槛=${brain.war.waveThreshold} 蓝方茅屋剩 ${blueHouses.length} 座`);
// 兵源诊断：v0.37 战争经济的瓶颈一目了然（住户/户外空闲/可动员住户/上限）
const huts = sim.buildings.filter((b) => b.team === RED && b.kind === "hut" && b.level >= 1 && b.hp > 0);
const redWalkers = sim.units.filter((u) => u.team === RED && u.hp > 0 && u.kind === "walker");
console.log(
  `      兵源：茅屋${huts.length} 座（容量${huts.reduce((n, b) => n + (b.level === 3 ? 10 : b.level === 2 ? 5 : 2), 0)}）住户${redWalkers.filter((u) => u.homeId > 0).length} 户外${redWalkers.filter((u) => u.homeId === 0).length} 可征召${sim.draftableWalkers(RED).length} 可动员住户${new ArmyPolicy(profile).surplusDwellers(sim, RED)}（人口上限 ${sim.countPop(RED)}）`,
);

// 训兵队列诊断：卡住的学员一眼可见（到大营距离 / 槽位可走性 / 路径长度）
const trainees = sim.units.filter((u) => u.team === RED && u.job === "train");
if (trainees.length) {
  const slots: string[] = [];
  for (const u of trainees.slice(0, 8)) {
    const camp = sim.buildings.find((b) => b.id === u.targetId);
    if (!camp) {
      slots.push(`#${u.id}(${u.trainKind}) 无营地`);
      continue;
    }
    const q = sim.trainQueue(camp.id);
    const slot = Math.max(0, q.findIndex((o) => o.id === u.id));
    const dest = sim.trainSlotPos(camp, slot);
    slots.push(
      `#${u.id}(${u.trainKind}/槽${slot}) 距槽${Math.hypot(u.x - dest.x, u.z - dest.z).toFixed(1)}格 槽可走=${sim.world.walkableAt(dest.x, dest.z)} 路长=${u.path.length}`,
    );
  }
  console.log(`      训练队列（${trainees.length} 人）：${slots.join(" | ")}`);
}

if (wantLog) {
  const cats = ["ai-train", "ai-dragon", "ai-brain", "ai-war"];
  for (const cat of cats) {
    const lines = sink.entries.filter((e) => e.cat === cat);
    console.log(`\n── ${cat}（${lines.length} 条，末 12 条）──`);
    for (const e of lines.slice(-12)) console.log(`  [${e.t.toFixed(0)}s] ${e.msg} ${JSON.stringify(e.data ?? {})}`);
  }
}
