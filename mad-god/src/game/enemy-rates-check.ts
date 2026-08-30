// v0.27-1 检查：敌方数值削弱 Wrapper（TeamRates / RateBook）。
// 覆盖三条接线：茅屋生产速率、技能充能速率、训兵速度——同配置下红方均应为蓝方 ×0.75，
// 且玩家（蓝方）保持基准 1.0 不受影响。测试文件命名：v0.27 / feature=enemy-rates。

import { Sim } from "./sim";
import { RateBook, TeamRates } from "./team-rates";
import { BLUE, RED, Team, Unit } from "./types";
import { World } from "./world";

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

/** 就近找一块"陆地 + 可走 + 高于水面"的落点（放建筑/营地用），从 r=2 起螺旋外扩。 */
function landSpotNear(sim: Sim, ox: number, oz: number): { x: number; z: number } | null {
  for (let r = 2; r <= 10; r += 1) {
    for (let a = 0; a < 16; a++) {
      const ang = (a / 16) * Math.PI * 2;
      const x = Math.round((ox + Math.cos(ang) * r) * 2) / 2;
      const z = Math.round((oz + Math.sin(ang) * r) * 2) / 2;
      if (sim.world.walkableAt(x, z) && sim.world.heightAt(x, z) > 0.5) return { x, z };
    }
  }
  return null;
}

/** a. 茅屋生产：同配置（L1、dwell=1）红方 b.prod 增速 = 蓝方 ×0.75。 */
function testProdRate(): void {
  const sim = new Sim(new World(42));
  const bw = sim.units.find((u) => u.team === BLUE && u.kind === "walker")!;
  const rw = sim.units.find((u) => u.team === RED && u.kind === "walker")!;
  const bs = landSpotNear(sim, bw.x, bw.z);
  const rs = landSpotNear(sim, rw.x, rw.z);
  assert(!!bs && !!rs, "prod: 双方附近都能找到落屋点");

  const bh = sim.placeComplete(BLUE, bs!.x, bs!.z, 0, "hut", 1);
  const rh = sim.placeComplete(RED, rs!.x, rs!.z, 0, "hut", 1);
  bh.dwell = 1;
  rh.dwell = 1;

  const b0 = bh.prod;
  const r0 = rh.prod;
  for (let i = 0; i < 4; i++) sim.tick(0.5); // 2 秒：blue 0.1×2=0.2，red 0.075×2=0.15，都远不到出生阈值 1
  const bd = bh.prod - b0;
  const rd = rh.prod - r0;
  assert(bd > 0.05, `prod: 蓝方茅屋在产（Δ=${bd.toFixed(3)}）`);
  assert(Math.abs(rd / bd - 0.75) < 0.02, `prod: 红方增速 = 蓝方×0.75（blue Δ=${bd.toFixed(3)}, red Δ=${rd.toFixed(3)}）`);
  console.log("testProdRate ok");
}

/** b. 技能充能：同人口档（双方初始人口相同）红方 fill 增速 = 蓝方 ×0.75。 */
function testChargeRate(): void {
  const sim = new Sim(new World(42));
  const tool = "lightning" as const;
  const b0 = sim.chargeState(BLUE, tool).fill;
  const r0 = sim.chargeState(RED, tool).fill;
  sim.regenCharges(1.0);
  const bd = sim.chargeState(BLUE, tool).fill - b0;
  const rd = sim.chargeState(RED, tool).fill - r0;
  assert(Math.abs(bd - 1.0) < 0.01, `charge: 蓝方 1 秒充 1.0（Δ=${bd.toFixed(3)}）`);
  assert(Math.abs(rd / bd - 0.75) < 0.02, `charge: 红方 = 蓝方×0.75（blue Δ=${bd.toFixed(3)}, red Δ=${rd.toFixed(3)}）`);
  console.log("testChargeRate ok");
}

/** c. 训兵：蓝方 4 秒训成武士，红方需 4/0.75≈5.33 秒——中途断言红方仍未训成。 */
function testTrainRate(): void {
  const sim = new Sim(new World(42));
  const pick = (team: Team): Unit => sim.units.find((u) => u.team === team && u.kind === "walker")!;
  const bw = pick(BLUE);
  const rw = pick(RED);
  const bs = landSpotNear(sim, bw.x, bw.z);
  const rs = landSpotNear(sim, rw.x, rw.z);
  assert(!!bs && !!rs, "train: 双方附近都能找到营地落点");

  const bc = sim.placeComplete(BLUE, bs!.x, bs!.z, 0, "warriorHut", 1);
  const rc = sim.placeComplete(RED, rs!.x, rs!.z, 0, "warriorHut", 1);
  sim.trainingSystem.sendWalkerToCamp(sim, bw, bc, "warrior");
  sim.trainingSystem.sendWalkerToCamp(sim, rw, rc, "warrior");

  // 走位耗时随地形浮动：轮询到双方都到训练位（channel>0）再开测速窗口。
  let waited = 0;
  while ((bw.channel <= 0 || rw.channel <= 0) && waited < 8) {
    sim.tick(0.25);
    waited += 0.25;
  }
  assert(bw.channel > 0 && rw.channel > 0, `train: 双方都已到训练位（waited=${waited}s）`);

  // 1 秒测速窗口（蓝方 channel 此时远不到 4，不会中途训成重置）。
  const b0 = bw.channel;
  const r0 = rw.channel;
  for (let i = 0; i < 4; i++) sim.tick(0.25);
  const bd = bw.channel - b0;
  const rd = rw.channel - r0;
  assert(Math.abs(bd - 1.0) < 0.01, `train: 蓝方通道 1 秒 +1.0（Δ=${bd.toFixed(3)}）`);
  assert(Math.abs(rd / bd - 0.75) < 0.02, `train: 红方 = 蓝方×0.75（blue Δ=${bd.toFixed(3)}, red Δ=${rd.toFixed(3)}）`);

  // 收尾：蓝方先训成（起步相近且速率更快），红方在那一刻仍是 walker，随后也训成。
  let t = 0;
  while (bw.kind === "walker" && t < 12) {
    sim.tick(0.25);
    t += 0.25;
  }
  assert(bw.kind === "warrior", "train: 蓝方先训成武士");
  assert(rw.kind === "walker", "train: 蓝方训成时红方尚未训成（0.75×）");
  t = 0;
  while (rw.kind === "walker" && t < 12) {
    sim.tick(0.25);
    t += 0.25;
  }
  assert(rw.kind === "warrior", "train: 红方随后也训成武士");
  console.log("testTrainRate ok");
}

/** d. Wrapper 可替换性：整体换一份 RateBook 即全参数生效（复用入口）。 */
function testRateBookSwappable(): void {
  const sim = new Sim(new World(42));
  assert(sim.rates.of(BLUE).prod === 1 && sim.rates.of(RED).prod === 0.75, "swap: 默认红弱蓝基准");

  sim.rates = new RateBook({
    [BLUE]: new TeamRates(1, 1, 1),
    [RED]: new TeamRates(0.5, 0.6, 0.7),
  });
  assert(sim.rates.of(RED).charge === 0.6 && sim.rates.of(RED).train === 0.7, "swap: 替换后新系数生效");
  console.log("testRateBookSwappable ok");
}

testProdRate();
testChargeRate();
testTrainRate();
testRateBookSwappable();
console.log("enemy-rates-check 全部通过（v0.27-1 敌方削弱 Wrapper）");
