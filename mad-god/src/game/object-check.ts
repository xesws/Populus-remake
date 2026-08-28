import { Sim } from "./sim";
import { BLUE, SAMPLES, STEP, UnitKind, WORLD, houseHp } from "./types";
import { World } from "./world";

const ALLOWED: UnitKind[] = [
  "shaman",
  "walker",
  "warrior",
  "preacher",
  "firewarrior",
  "spy",
  "wildman",
];

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

function settleAfterTrainCheck(): void {
  const sim = new Sim(new World(7));
  const l1 = sim.buildings.filter((b) => b.team === BLUE && b.kind === "hut" && b.level === 1);
  assert(l1.length >= 2, "need starting L1 huts");
  assert(l1.every((b) => b.need === 3), "L1 huts still have need===3 at start");

  const beforeKinds = sim.units.filter((u) => u.team === BLUE).map((u) => u.kind);
  const sent = sim.train(BLUE, "warrior");
  assert(!sent, "train warrior without selection must fail");
  assert((sim.logs[sim.logs.length - 1] ?? "") === "先选人", "nobody selected → 先选人");
  assert(!sim.teams[BLUE].wanted.includes("warriorHut"), "do not mark wanted when nobody is selected");
  assert(
    sim.units.filter((u) => u.team === BLUE).every((u, i) => u.kind === beforeKinds[i]),
    "NO walker.kind changed on train-without-selection",
  );
  const gen1 = sim.toastGen;
  sim.train(BLUE, "warrior");
  assert(sim.toastGen === gen1 + 1, "repeat T must increment toastGen");
  assert((sim.logs[sim.logs.length - 1] ?? "") === "先选人", "repeat toast string stays 先选人");

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

  console.log("settle-after-train ok");
  console.log("  toast", sim.logs[sim.logs.length - 1], "wanted", sim.teams[BLUE].wanted.join(","));
  console.log("  wood", wood, "choppers", blues.filter((u) => u.job === "chop").length, "carry", blues.filter((u) => u.carry === 1).length);
  console.log("  deadTrees", sim.trees.filter((t) => !t.alive).length);
}


function shotQueueCheck(): void {
  const sim = new Sim(new World(1989));
  sim.freezeMerge = true;
  sim.lockWin = true;
  let hutN = 0;
  for (const b of sim.buildings) {
    if (b.team !== BLUE || b.kind !== "hut") continue;
    b.level = 1;
    b.hp = b.maxHp = houseHp(1);
    b.wood = 0;
    b.need = hutN === 0 ? 0 : 16;
    hutN++;
  }
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
    sim.tryPrepFound(x, z, s.yaw);
    if (sim.canFound(x, z, 1, s.yaw)) {
      campX = x;
      campZ = z;
      break;
    }
  }
  sim.placeComplete(BLUE, campX, campZ, s.yaw, "warriorHut", 1);
  const camp = sim.buildings.find((b) => b.team === BLUE && b.kind === "warriorHut" && b.hp > 0)!;
  const have = sim.units.filter((u) => u.team === BLUE && u.kind === "walker");
  while (have.length < 4) have.push(sim.addUnit(BLUE, "walker", camp.x + 3, camp.z));
  const rx = Math.cos(camp.yaw);
  const rz = -Math.sin(camp.yaw);
  for (let i = 0; i < 3; i++) {
    const slot = sim.trainSlotPos(camp, i);
    const w = have[i]!;
    w.x = slot.x + rx * 0.55;
    w.z = slot.z + rz * 0.55;
    w.y = sim.world.heightAt(w.x, w.z);
    w.job = "idle";
    w.selected = true;
  }
  const door = sim.trainDoor(camp);
  const p0 = sim.trainSlotPos(camp, 0);
  const p4 = sim.trainSlotPos(camp, 4);
  const along = (p4.x - p0.x) * door.fx + (p4.z - p0.z) * door.fz;
  assert(along < 2.0, "slot 4 must wrap the wall, not extend the door line");
  const ok = sim.train(BLUE, "warrior");
  assert(ok, "shot setup train succeeds");
  assert(have[0]!.job === "train" && have[1]!.job === "train" && have[2]!.job === "train", "three door walkers queue");
  for (let i = 0; i < 40; i++) sim.tick(0.05);
  assert(sim.countKind(BLUE, "warrior") === 0, "still 0 soldiers at 2s");
  const q = sim.trainQueue(camp.id);
  assert(q.length === 3, "queue stays 3");
  const at = q.filter((u, i) => {
    const slot = sim.trainSlotPos(camp, i);
    return (u.x - slot.x) ** 2 + (u.z - slot.z) ** 2 <= 0.22 * 0.22;
  });
  assert(at.length >= 2, "at least two standing on slots");
  assert(q[0]!.channel > 1, "slot 0 is training");
  for (let i = 0; i < 80; i++) sim.tick(0.05);
  assert(sim.countKind(BLUE, "warrior") >= 1, "first graduate by 6s");
  assert(sim.trainQueue(camp.id).length >= 1, "next still in queue");
  console.log("shot-queue ok");
}

function selectionTrainCheck(): void {
  const sim1 = new Sim(new World(7));
  const kinds1 = sim1.units.map((u) => u.kind);
  const ok1 = sim1.train(BLUE, "warrior");
  assert(!ok1, "train with nobody selected must fail");
  assert((sim1.logs[sim1.logs.length - 1] ?? "") === "先选人", "toast 先选人");
  assert(sim1.units.every((u, i) => u.kind === kinds1[i]), "no kind change when nobody selected");
  assert(!sim1.teams[BLUE].wanted.includes("warriorHut"), "no wanted founding when nobody selected");
  assert(
    sim1.units.filter((u) => u.team === BLUE && u.kind === "walker").every((u) => u.foundKind === null && u.job !== "train"),
    "no walker sent to found/train when nobody selected",
  );

  const sim2 = new Sim(new World(7));
  const walkers2 = sim2.units.filter((u) => u.team === BLUE && u.kind === "walker");
  assert(walkers2.length >= 2, "need two walkers");
  const pick = walkers2[0]!;
  const other = walkers2[1]!;
  pick.selected = true;
  const ok2 = sim2.train(BLUE, "warrior");
  assert(!ok2, "train without camp returns false");
  assert((sim2.logs[sim2.logs.length - 1] ?? "") === "先盖训练营", "toast 先盖训练营");
  assert(!sim2.teams[BLUE].wanted.includes("warriorHut"), "do not mark wanted — player places the camp");
  assert(!sim2.buildings.some((b) => b.team === BLUE && b.kind === "warriorHut"), "no auto camp site");
  assert(pick.foundKind === null, "selected walker is not sent to found");
  assert(other.foundKind === null, "unselected walker is not a camp founder");
  assert(other.job === "chop" || other.job === "idle" || other.job === "haul", "other stays wood-loop job");
  assert(other.job !== "train", "unselected does not train");
  for (let i = 0; i < 8; i++) sim2.tick(0.05);
  const stillOther = sim2.units.find((u) => u.id === other.id);
  assert(!!stillOther, "other walker lives");
  assert(stillOther!.foundKind === null, "other still not founding after ticks");
  assert(stillOther!.job === "chop" || stillOther!.job === "idle" || stillOther!.job === "haul", "other keeps wood loop");
  const founders = sim2.units.filter((u) => u.team === BLUE && u.kind === "walker" && u.foundKind === "warriorHut");
  assert(founders.length === 0, "no founder assigned");
  const campWalkers = sim2.units.filter((u) => u.team === BLUE && u.kind === "walker" && u.job === "train");
  assert(campWalkers.length === 0, "no one trains without a complete camp");

  const sim3 = new Sim(new World(13));
  const w3 = sim3.units.filter((u) => u.team === BLUE && u.kind === "walker");
  assert(w3.length >= 2, "need two walkers for camp train");
  const extra = sim3.addUnit(BLUE, "walker", w3[0]!.x + 1.2, w3[0]!.z + 1.2);
  extra.selected = false;
  w3[0]!.selected = true;
  w3[1]!.selected = true;
  w3[0]!.carry = 0;
  w3[1]!.carry = 0;
  extra.carry = 0;
  sim3.placeComplete(BLUE, w3[0]!.x + 4.2, w3[0]!.z, 0, "warriorHut", 1);
  const ok3 = sim3.train(BLUE, "warrior");
  assert(ok3, "train with camp and selected walkers succeeds");
  assert(w3[0]!.job === "train", "first selected trains");
  assert(w3[1]!.job === "train", "second selected trains");
  assert(extra.job !== "train", "unselected walker does not train");

  const sim4 = new Sim(new World(17));
  const shaman = sim4.units.find((u) => u.team === BLUE && u.kind === "shaman");
  assert(!!shaman, "need shaman");
  shaman!.selected = true;
  const ok4 = sim4.train(BLUE, "warrior");
  assert(!ok4, "shaman cannot train");
  assert((sim4.logs[sim4.logs.length - 1] ?? "") === "选中的人不能训练", "toast 选中的人不能训练");

  console.log("selection-train ok");
}

function main(): void {
  const world = new World(42);
  const ix = 80;
  const iz = 80;
  world.h[iz * SAMPLES + ix] = 1.0;
  world.h[iz * SAMPLES + ix + 1] = 3.0;
  world.h[(iz + 1) * SAMPLES + ix] = 1.0;
  world.h[(iz + 1) * SAMPLES + ix + 1] = 3.0;
  const mid = world.heightAt((ix + 0.5) * STEP, iz * STEP);
  assert(Math.abs(mid - 2.0) < 0.05, `heightAt should interpolate, got ${mid}`);
  assert(mid !== 1 && mid !== 3, "heightAt must not snap to a sample");

  const sx = 20.0;
  const sz = 20.0;
  const before = world.heightAt(sx, sz);
  const ok = world.sculpt(sx, sz, 1.4, 0.25);
  assert(ok, "sculpt should change samples");
  const after = world.heightAt(sx, sz);
  assert(after !== before, `sculpt should change float height ${before} -> ${after}`);
  assert(Math.abs(after - before) < 1, `sculpt must not be +1 integer column, delta=${after - before}`);
  assert(after !== Math.floor(before) + 1, "sculpt is not integer raise");

  const sim = new Sim(new World(7));
  for (const u of sim.units) {
    assert(ALLOWED.includes(u.kind), `illegal kind ${u.kind}`);
  }
  assert(sim.units.some((u) => u.kind === "shaman"), "must seed a shaman");
  assert(sim.units.some((u) => u.kind === "wildman"), "must seed wildmen");
  assert(sim.units.some((u) => u.kind === "walker"), "must seed walkers");
  assert(sim.buildings.every((b) => typeof b.yaw === "number"), "buildings need yaw");
  assert(sim.units.every((u) => typeof u.y === "number" && typeof u.yaw === "number"), "units need y+yaw");

  const beforeKinds = sim.units.map((u) => u.kind);
  const noCamp = sim.train(0, "firewarrior");
  assert(!noCamp, "train without camp must fail");
  assert(
    sim.units.every((u, i) => u.kind === beforeKinds[i]),
    "no instant transform without camp",
  );

  const walker = sim.units.find((u) => u.team === 0 && u.kind === "walker");
  assert(!!walker, "need a walker");
  walker!.selected = true;
  const camp = sim.placeComplete(0, walker!.x + 3.2, walker!.z, 0, "fireHut", 1);
  const sent = sim.train(0, "firewarrior");
  assert(sent, "train with camp should send a walker");
  assert(walker!.kind === "walker", "still a walker while walking in");
  assert(walker!.job === "train", "job is train");
  const slot0 = sim.trainSlotPos(camp, 0);
  walker!.x = slot0.x;
  walker!.z = slot0.z;
  walker!.path = [];
  assert(walker!.kind === "walker", "remains a walker until 4s at slot 0");
  for (let i = 0; i < 90; i++) sim.tick(0.05);
  assert(sim.units.some((u) => u.kind === "firewarrior"), "comes out as firewarrior after 4s at slot 0");

  const b = sim.buildings[0];
  assert(b && b.padW > 0 && b.padD > 0, "building has pad");

  settleAfterTrainCheck();
  selectionTrainCheck();
  shotQueueCheck();

  console.log("object-check ok");
  console.log("  heightAt mid", mid);
  console.log("  sculpt", before, "->", after, "delta", after - before);
  console.log("  kinds", [...new Set(sim.units.map((u) => u.kind))].join(","));
  console.log("  terrain samples", SAMPLES, "step", STEP);
}

main();
