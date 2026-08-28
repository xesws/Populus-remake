import { Sim } from "./sim";
import { BLUE } from "./types";
import { World } from "./world";

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

function main(): void {
  const sim = new Sim(new World(7));
  const l1 = sim.buildings.filter((b) => b.team === BLUE && b.kind === "hut" && b.level === 1);
  assert(l1.length >= 2, "need starting L1 huts");
  assert(l1.every((b) => b.need === 3), "L1 huts still have need===3 at start");

  const beforeKinds = sim.units.filter((u) => u.team === BLUE).map((u) => u.kind);
  const sent = sim.train(BLUE, "warrior");
  assert(!sent, "train warrior without camp must fail");
  assert((sim.logs[sim.logs.length - 1] ?? "") === "先盖训练营", "last log must be 先盖训练营");
  assert(sim.teams[BLUE].wanted.includes("warriorHut"), "wanted has warriorHut");
  assert(
    sim.units.filter((u) => u.team === BLUE).every((u, i) => u.kind === beforeKinds[i]),
    "NO walker.kind changed on train-without-camp",
  );

  const gen1 = sim.toastGen;
  sim.train(BLUE, "warrior");
  assert(sim.toastGen === gen1 + 1, "repeat T must increment toastGen");
  assert((sim.logs[sim.logs.length - 1] ?? "") === "先盖训练营", "repeat toast stays 先盖训练营");

  const camps = sim.buildings.filter((b) => b.team === BLUE && b.kind === "warriorHut" && b.hp > 0);
  assert(camps.length <= 1, "at most one camp site");
  if (camps[0]) {
    assert(camps[0].level === 0, "founder places L0 site");
    assert(camps[0].need === 4, "camp still needs 4 wood");
  }
  const founders = sim.units.filter((u) => u.team === BLUE && u.kind === "walker" && u.foundKind === "warriorHut");
  assert(founders.length <= 1, "one founder max");

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
  const trainLoaded = carrySim.train(BLUE, "warrior");
  assert(loaded!.job !== "train", "do not send a loaded walker into training");
  if (empty && empty.carry === 0) {
    assert(trainLoaded, "empty-handed walker should train");
    assert(empty.job === "train", "the carry===0 walker is sent");
  }

  console.log("settle-check ok");
  console.log("  click-train toast:", "先盖训练营");
  console.log("  wanted:", sim.teams[BLUE].wanted.join(","));
  console.log("  campSite", camps.length > 0, "level", camps[0]?.level ?? "-", "need", camps[0]?.need ?? "-");
  console.log("  after 20s: chopped=true wood", wood, "choppers", blues.filter((u) => u.job === "chop").length, "deadTrees", sim.trees.filter((t) => !t.alive).length);
  console.log("  walkers chopped after train-without-camp: YES");
}

main();
