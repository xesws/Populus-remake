// v0.28c 检查：① 训成出营散开（不堵门口）② 茅屋缩半 / 哨塔地基贴塔身 / 训练营不缩。
// 测试文件命名：v0.28c / feature=train-exit + building-sizes。

import { Sim } from "./sim";
import { BLUE, CAMP_PAD, HOUSE_PAD, TOWER_PAD, padSize, sitePad } from "./types";
import { World } from "./world";

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

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

/**
 * a. 训成出营散开：完成训练的单位应弹到营地外 ≥2 格的开阔点，
 * 不再堆在门口 0.8 格处堵住后续排队（与茅屋出生同一套散开逻辑）。
 */
function testTrainExitScatters(): void {
  const sim = new Sim(new World(42));
  const bw = sim.units.find((u) => u.team === BLUE && u.kind === "walker")!;
  const spot = landSpotNear(sim, bw.x, bw.z);
  assert(!!spot, "exit: 找到营地落点");
  const camp = sim.placeComplete(BLUE, spot!.x, spot!.z, 0, "warriorHut", 1);

  const trainee = sim.addUnit(BLUE, "walker", camp.x + 1, camp.z + 1);
  sim.trainingSystem.sendWalkerToCamp(sim, trainee, camp, "warrior");

  let done = false;
  for (let i = 0; i < 400; i++) {
    sim.tick(0.05);
    if (trainee.kind === "warrior") {
      done = true;
      break;
    }
  }
  assert(done, "exit: 训练完成成为武士");

  const d = Math.hypot(trainee.x - camp.x, trainee.z - camp.z);
  assert(d >= camp.padD / 2 + 1.5, `exit: 出营散开到营地外 ≥1.5 格（d=${d.toFixed(2)}，门口堵人旧实现只有 ~1.4）`);
  assert(!sim.buildingAt(trainee.x, trainee.z), "exit: 不站在任何建筑地基上");
  assert(sim.world.walkableAt(trainee.x, trainee.z), "exit: 落点可走");
  console.log("testTrainExitScatters ok");
}

/** b. v0.28c 尺寸：茅屋缩半（1.1 墙 / 1.3 地基）、训练营不缩（2.6）、哨塔贴塔身（0.6）。 */
function testBuildingSizes(): void {
  assert(HOUSE_PAD[1] === 1.3 && padSize(1).w === 1.3, "size: 茅屋地基缩半 2.6→1.3");
  assert(TOWER_PAD === 0.6, "size: 哨塔地基贴塔身 0.6（建模 0.5）");
  assert(CAMP_PAD === 2.6 && sitePad("warriorHut").w === 2.6, "size: 训练营保持 2.6 不缩");
  assert(sitePad("temple").w === 2.6 && sitePad("fireHut").w === 2.6 && sitePad("spyHut").w === 2.6, "size: 全部训练营 2.6");
  assert(sitePad("hut").w === 1.3, "size: 茅屋 sitePad 1.3");
  assert(sitePad("tower").w === 0.6, "size: 哨塔 sitePad 0.6");
  console.log("testBuildingSizes ok");
}

testTrainExitScatters();
testBuildingSizes();
console.log("train-exit-check 全部通过（v0.28c 训成散开出营 + 建筑尺寸回调）");
