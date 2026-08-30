import { Sim } from "./sim";
import { BLUE, WORLD } from "./types";
import { World } from "./world";

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

function main(): void {
  const sim = new Sim(new World(7));
  const l1 = sim.buildings.filter((b) => b.team === BLUE && b.kind === "hut" && b.level === 1);
  assert(l1.length >= 2, "need starting L1 huts");
  assert(l1.every((b) => b.need === 0), "L1 huts have need===0 at start");

  const beforeKinds = sim.units.filter((u) => u.team === BLUE).map((u) => u.kind);
  const sent = sim.train(BLUE, "warrior");
  assert(!sent, "train warrior without selection must fail");
  assert((sim.logs[sim.logs.length - 1] ?? "") === "先选人", "last log must be 先选人");
  assert(!sim.teams[BLUE].wanted.includes("warriorHut"), "wanted does not have warriorHut when no one selected");
  assert(
    sim.units.filter((u) => u.team === BLUE).every((u, i) => u.kind === beforeKinds[i]),
    "NO walker.kind changed on train-without-selection",
  );

  const gen1 = sim.toastGen;
  sim.train(BLUE, "warrior");
  assert(sim.toastGen === gen1 + 1, "repeat T must increment toastGen");
  assert((sim.logs[sim.logs.length - 1] ?? "") === "先选人", "repeat toast stays 先选人");

  // Selection train without camp triggers "先盖训练营"
  const blues0 = sim.units.filter((u) => u.team === BLUE && u.kind === "walker");
  if (blues0.length > 0) {
    blues0[0]!.selected = true;
    const sentWithSel = sim.train(BLUE, "warrior");
    assert(!sentWithSel, "train warrior with selection but no camp must fail");
    assert((sim.logs[sim.logs.length - 1] ?? "") === "先盖训练营", "toast 先盖训练营");
    blues0[0]!.selected = false;
  }

  // Found a camp site needing wood so walkers chop/carry
  const s = sim.world.startPad(BLUE);
  const toCx = WORLD * 0.5 - s.x;
  const toCz = WORLD * 0.5 - s.z;
  const len = Math.hypot(toCx, toCz) || 1;
  const fx = toCx / len;
  const fz = toCz / len;
  const px = -fz;
  const pz = fx;
  let campX = s.x + fx * 8;
  let campZ = s.z + fz * 8;
  for (const [a, b] of [
    [8.0, 0],
    [7.2, 2.6],
    [7.2, -2.6],
    [9.0, 1.8],
    [6.6, 0],
  ] as Array<[number, number]>) {
    const x = s.x + fx * a + px * b;
    const z = s.z + fz * a + pz * b;
    // v0.28c 起地基按建筑类型取尺寸：预备/校验/落基必须同一口径（这里建训练营）。
    sim.tryPrepFound(x, z, s.yaw, "warriorHut");
    if (sim.canFound(x, z, 1, s.yaw, 0, "warriorHut")) {
      campX = x;
      campZ = z;
      break;
    }
  }
  const site = sim.foundSite(BLUE, campX, campZ, s.yaw, "warriorHut");
  assert(site !== null, "camp site founded");
  assert(site!.level === 0, "founder places L0 site");
  assert(site!.need === 4, "camp still needs 4 wood");

  for (let i = 0; i < 400; i++) sim.tick(0.05);

  const blues = sim.units.filter((u) => u.team === BLUE && u.kind === "walker");
  const chopped = blues.some((u) => u.job === "chop" || u.carry === 1) || sim.trees.some((t) => !t.alive);
  assert(chopped, "after 20s at least one walker chops/carries or a tree is down");
  const wood = sim.countWood(BLUE);
  const allSeekEmpty = blues.length > 0 && blues.every((u) => u.job === "idle" && u.settleX >= 0 && u.carry === 0);
  assert(!(allSeekEmpty && wood === 0), "must NOT have all walkers only walking to empty settle coords with 木 0");

  const carrySim = new Sim(new World(11));
  const loaded = carrySim.units.find((u) => u.team === BLUE && u.kind === "walker");
  assert(!!loaded, "need walker for carry-train");
  loaded!.carry = 1;
  const camp = carrySim.placeComplete(BLUE, loaded!.x + 3.4, loaded!.z, 0, "warriorHut", 1);
  const empty = carrySim.units.find((u) => u.team === BLUE && u.kind === "walker" && u.id !== loaded!.id);
  if (empty) empty.x = camp.x + 6;
  loaded!.selected = true;
  if (empty) empty.selected = true;
  const trainLoaded = carrySim.train(BLUE, "warrior");
  assert(trainLoaded, "selected walkers train even if one was carrying");
  assert(loaded!.job === "train", "loaded walker drops wood and queues");
  assert(loaded!.carry !== 1, "wood is dropped on the way to camp");
  if (empty) assert(empty.job === "train", "the other selected walker also queues");

  console.log("settle-check ok");
  console.log("  no-selection train toast:", "先选人");
  console.log("  selected-no-camp toast:", "先盖训练营");
  console.log("  campSite level", site?.level ?? "-", "need", site?.need ?? "-");
  console.log("  after 20s: chopped=true wood", wood, "choppers", blues.filter((u) => u.job === "chop").length, "deadTrees", sim.trees.filter((t) => !t.alive).length);
  console.log("  carry-train handled: YES");
}

main();
