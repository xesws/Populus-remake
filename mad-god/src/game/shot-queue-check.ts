import { Sim } from "./sim";
import { BLUE, WORLD, houseHp } from "./types";
import { World } from "./world";

function setupLikeShot(): Sim {
  const sim = new Sim(new World(1989));
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
  const offsets: Array<[number, number]> = [
    [8.0, 0],
    [7.2, 2.6],
    [7.2, -2.6],
    [9.0, 1.8],
    [6.6, 0],
  ];
  let campX = s.x + fx * 8;
  let campZ = s.z + fz * 8;
  for (const [a, b] of offsets) {
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
    w.carry = 0;
    w.channel = 0;
    w.path = [{ x: w.x, z: w.z }];
    w.pathI = 0;
    w.think = 20;
    w.selected = false;
    w.targetId = 0;
    w.trainKind = null;
  }
  const chop = have[3]!;
  const near = sim.trees
    .filter((t) => t.alive)
    .map((t) => ({ t, d: Math.hypot(t.x - campX, t.z - campZ) }))
    .filter((o) => o.d > 2.8 && o.d < 7.5)
    .sort((a, b) => a.d - b.d);
  const tree = near[0]?.t ?? sim.nearestTree(campX - fx * 4 + px * 4, campZ - fz * 4 + pz * 4);
  if (tree) {
    chop.x = tree.x + 0.55;
    chop.z = tree.z + 0.35;
    chop.y = sim.world.heightAt(chop.x, chop.z);
    chop.job = "chop";
    chop.targetId = tree.id;
    chop.channel = 0.2;
    chop.path = [];
    chop.think = 20;
    chop.selected = false;
    chop.carry = 0;
  }
  sim.markHouseBlocks();
  return sim;
}

function dump(sim: Sim, label: string): void {
  const camp = sim.buildings.find((b) => b.team === BLUE && b.kind === "warriorHut")!;
  const q = sim.trainQueue(camp.id);
  const walkers = sim.units.filter((u) => u.team === BLUE && (u.kind === "walker" || u.kind === "warrior"));
  console.log(`--- ${label} t=${sim.time.toFixed(2)} soldiers=${sim.countKind(BLUE, "warrior")} q=${q.length} toast=${sim.logs[sim.logs.length - 1] ?? ""}`);
  for (const w of walkers) {
    const slot = q.findIndex((o) => o.id === w.id);
    const dest = slot >= 0 ? sim.trainSlotPos(camp, slot) : null;
    const d = dest ? Math.hypot(w.x - dest.x, w.z - dest.z) : -1;
    const walk = sim.world.walkableAt(w.x, w.z);
    console.log(
      `  id=${w.id} kind=${w.kind} job=${w.job} sel=${w.selected} ch=${w.channel.toFixed(2)} path=${w.path.length} think=${w.think.toFixed(2)} ` +
        `pos=${w.x.toFixed(2)},${w.z.toFixed(2)} walkable=${walk} slot=${slot} dSlot=${d.toFixed(2)}`,
    );
  }
  for (let i = 0; i < 3; i++) {
    const p = sim.trainSlotPos(camp, i);
    console.log(`  slot${i} ${p.x.toFixed(2)},${p.z.toFixed(2)} walkable=${sim.world.walkableAt(p.x, p.z)}`);
  }
}

function main(): void {
  const sim = setupLikeShot();
  dump(sim, "setup");
  const camp = sim.buildings.find((b) => b.team === BLUE && b.kind === "warriorHut")!;
  const have = sim.units.filter((u) => u.team === BLUE && u.kind === "walker");
  have[0]!.selected = true;
  have[1]!.selected = true;
  have[2]!.selected = true;
  const ok = sim.train(BLUE, "warrior");
  console.log("train ok", ok, "toast", sim.logs[sim.logs.length - 1]);
  dump(sim, "just after train");
  const start = have.slice(0, 3).map((w) => ({ id: w.id, x: w.x, z: w.z }));
  for (let i = 0; i < 40; i++) sim.tick(0.05);
  dump(sim, "after 2s");
  for (const s of start) {
    const u = sim.units.find((w) => w.id === s.id)!;
    const moved = Math.hypot(u.x - s.x, u.z - s.z);
    console.log(`moved id=${s.id} ${moved.toFixed(3)} job=${u.job} kind=${u.kind}`);
  }
  for (let i = 0; i < 80; i++) sim.tick(0.05);
  dump(sim, "after 6s");
  console.log("door", sim.trainDoor(camp));
}

main();
