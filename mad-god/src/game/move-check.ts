import { Sim } from "./sim";
import { BLUE, Cell, inMap, Unit, WATER, WORLD } from "./types";
import { World } from "./world";
import { astar } from "./path";

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

function dist(ax: number, az: number, bx: number, bz: number): number {
  return Math.hypot(ax - bx, az - bz);
}

function tickFor(sim: Sim, seconds: number): void {
  for (let i = 0; i < Math.round(seconds / 0.05); i++) sim.tick(0.05);
}

function blueWalker(sim: Sim): Unit {
  const u = sim.units.find((x) => x.team === BLUE && x.kind === "walker" && x.homeId === 0);
  assert(!!u, "need a blue walker");
  return u!;
}

/** Find a walkable cell with 8-neighbour clearance near a ring distance from an origin. */
function openCellNear(sim: Sim, ox: number, oz: number, minD: number, maxD: number): Cell {
  for (let r = minD; r <= maxD; r += 0.5) {
    for (let a = 0; a < Math.PI * 2; a += Math.PI / 24) {
      const x = Math.round((ox + Math.cos(a) * r) * 2) / 2;
      const z = Math.round((oz + Math.sin(a) * r) * 2) / 2;
      if (!inMap(x, z)) continue;
      if (!sim.world.walkableAt(x, z)) continue;
      let clear = true;
      for (let dx = -1; dx <= 1 && clear; dx += 0.5) {
        for (let dz = -1; dz <= 1 && clear; dz += 0.5) {
          if (!sim.world.walkableAt(x + dx, z + dz)) clear = false;
        }
      }
      if (clear) return { x, z };
    }
  }
  return { x: WORLD / 2, z: WORLD / 2 };
}

/** 1. Plain straight move arrives quickly and HOLDS position (no wander-away). */
function testPlainStraightMove(): void {
  const sim = new Sim(new World(7));
  const u = blueWalker(sim);
  const dest = openCellNear(sim, u.x, u.z, 7, 10);
  sim.sendMove(u, dest.x, dest.z);
  assert(u.job === "move", "plain: job is move");
  assert(u.moveX === dest.x && u.moveZ === dest.z, "plain: move dest persisted");
  tickFor(sim, 8);
  assert(dist(u.x, u.z, dest.x, dest.z) < 0.35, `plain: arrives (d=${dist(u.x, u.z, dest.x, dest.z).toFixed(2)})`);
  assert(u.moveX < 0, "plain: move dest cleared on arrival");
  // Hold: unit must not wander away from the ordered destination
  tickFor(sim, 4);
  assert(dist(u.x, u.z, dest.x, dest.z) < 1.0, `plain: holds position (d=${dist(u.x, u.z, dest.x, dest.z).toFixed(2)})`);
  console.log("testPlainStraightMove ok");
}

/** 2. L-shaped move around a completed camp corner still arrives, no stuck. */
function testCornerAroundHut(): void {
  const sim = new Sim(new World(11));
  const u = blueWalker(sim);
  const hut = sim.placeComplete(BLUE, u.x + 3.4, u.z, 0, "warriorHut", 1);
  assert(!!hut, "corner: camp placed");
  const dest = openCellNear(sim, hut!.x, hut!.z, 3.5, 6);
  const startD = dist(u.x, u.z, dest.x, dest.z);
  sim.sendMove(u, dest.x, dest.z);
  tickFor(sim, 10);
  const endD = dist(u.x, u.z, dest.x, dest.z);
  assert(endD < 0.35, `corner: arrives past hut (d=${endD.toFixed(2)})`);
  assert(endD < startD - 1, "corner: made real progress");
  console.log("testCornerAroundHut ok");
}

/** 3. Move order into water snaps to shore and completes on land. */
function testWaterDestSnapsToShore(): void {
  const sim = new Sim(new World(13));
  const u = blueWalker(sim);
  let water: Cell | null = null;
  for (let r = 2; r <= 10 && !water; r += 0.5) {
    for (let a = 0; a < Math.PI * 2 && !water; a += Math.PI / 24) {
      const x = Math.round((u.x + Math.cos(a) * r) * 2) / 2;
      const z = Math.round((u.z + Math.sin(a) * r) * 2) / 2;
      if (!inMap(x, z)) continue;
      if (sim.world.heightAt(x, z) <= WATER && !sim.world.walkableAt(x, z)) water = { x, z };
    }
  }
  assert(!!water, "water: reachable water found near unit");
  const before = dist(u.x, u.z, water!.x, water!.z);
  sim.sendMove(u, water!.x, water!.z);
  assert(u.moveX >= 0, "water: order accepted");
  tickFor(sim, 10);
  assert(sim.world.walkableAt(u.x, u.z), "water: unit ends on walkable land");
  assert(dist(u.x, u.z, water!.x, water!.z) < before - 1, "water: unit approached the shore");
  console.log("testWaterDestSnapsToShore ok");
}

/** 4. Group rally to one point: nobody freezes, group converges. */
function testGroupRally(): void {
  const sim = new Sim(new World(17));
  const anchor = blueWalker(sim);
  const rally = openCellNear(sim, anchor.x, anchor.z, 6, 9);
  // Spawn the group on verified-clear cells around the rally point (blind spawns can land in water/pads and die)
  const offsets: [number, number][] = [
    [0, 0], [0.5, 0], [-0.5, 0], [0, 0.5], [0, -0.5],
    [0.5, 0.5], [-0.5, 0.5], [0.5, -0.5], [-0.5, -0.5], [1, 0],
  ];
  const walkers: Unit[] = [];
  for (const [dx, dz] of offsets) {
    if (walkers.length >= 10) break;
    const c = { x: rally.x + dx, z: rally.z + dz };
    if (inMap(c.x, c.z) && sim.world.walkableAt(c.x, c.z)) walkers.push(sim.addUnit(BLUE, "walker", c.x, c.z));
  }
  assert(walkers.length >= 6, `rally: spawned group (got ${walkers.length})`);
  const dest = openCellNear(sim, rally.x, rally.z, 5, 8);
  const starts = walkers.map((w) => ({ x: w.x, z: w.z }));
  for (const w of walkers) sim.sendMove(w, dest.x, dest.z);
  tickFor(sim, 10);
  // Merging absorbs nearby walkers (absorbed ones drop to hp 0 pending cull) — assert on survivors only.
  const alive = walkers.filter((w) => w.hp > 0);
  assert(alive.length >= 2, `rally: survivors after merge (${alive.length})`);
  let sum = 0;
  let maxFinal = 0;
  alive.forEach((w, i) => {
    const idx = walkers.indexOf(w);
    const final = dist(w.x, w.z, dest.x, dest.z);
    sum += final;
    maxFinal = Math.max(maxFinal, final);
    assert(dist(w.x, w.z, starts[idx]!.x, starts[idx]!.z) > 1, `rally: unit ${idx} actually moved`);
  });
  assert(sum / alive.length < 1.5, `rally: group converged (avg d=${(sum / alive.length).toFixed(2)})`);
  assert(maxFinal < 3.0, `rally: nobody left far behind (max d=${maxFinal.toFixed(2)})`);
  console.log("testGroupRally ok");
}

/** 5-6. Long-range path is not truncated and astar is fast. */
function testLongRangeAndPerf(): void {
  const sim = new Sim(new World(19));
  const u = blueWalker(sim);
  const dest = openCellNear(sim, u.x, u.z, 18, 26);
  const t0 = performance.now();
  const path = astar(sim.world, u.x, u.z, dest.x, dest.z);
  const ms = performance.now() - t0;
  assert(path.length > 30, `long: full path produced (len=${path.length})`);
  assert(ms < 8, `long: astar fast (${ms.toFixed(2)}ms)`);
  sim.sendMove(u, dest.x, dest.z);
  tickFor(sim, 30);
  assert(dist(u.x, u.z, dest.x, dest.z) < 0.5, `long: arrives across island (d=${dist(u.x, u.z, dest.x, dest.z).toFixed(2)})`);
  console.log(`testLongRangeAndPerf ok (path ${path.length} wp, ${ms.toFixed(2)}ms)`);
}

/** 7-9. Command system: stale founding state cannot override a move order; training can be interrupted. */
function testCommandOverride(): void {
  const sim = new Sim(new World(23));
  // Spawn the walker on a verified-clear cell: this test targets command override, not cliff-edge worldgen.
  const rally = openCellNear(sim, WORLD / 2, WORLD / 2, 0.5, 6);
  const u = sim.addUnit(BLUE, "walker", rally.x, rally.z);

  // Simulate the hanging founder state that used to block orders
  u.foundKind = "warriorHut";
  u.settleX = u.x;
  u.settleZ = u.z;
  const dest = openCellNear(sim, u.x, u.z, 6, 9);
  sim.sendMove(u, dest.x, dest.z);
  assert(u.foundKind === null, "override: foundKind cleared atomically");
  assert(u.settleX < 0, "override: settle target cleared");
  tickFor(sim, 8);
  assert(dist(u.x, u.z, dest.x, dest.z) < 0.35, "override: arrives despite stale founder state");
  // No re-capture: unit stays put afterwards
  tickFor(sim, 5);
  assert(dist(u.x, u.z, dest.x, dest.z) < 1.0, "override: not re-captured by founding logic");

  // Training queue can be interrupted by a move order
  const camp = sim.placeComplete(BLUE, dest.x + 3, dest.z, 0, "warriorHut", 1);
  assert(!!camp, "interrupt: camp placed");
  u.selected = true;
  const sent = sim.train(BLUE, "warrior");
  assert(sent, "interrupt: train accepted with camp");
  assert(u.job === "train", "interrupt: walker queued for training");
  const retreat = openCellNear(sim, u.x, u.z, 5, 8);
  sim.sendMove(u, retreat.x, retreat.z);
  assert(u.job === "move", "interrupt: move overrides training");
  tickFor(sim, 8);
  assert(dist(u.x, u.z, retreat.x, retreat.z) < 0.35, "interrupt: arrives at retreat point");
  assert(u.kind === "walker", "interrupt: no graduation after interrupt");

  console.log("testCommandOverride ok");
}

function main(): void {
  testPlainStraightMove();
  testCornerAroundHut();
  testWaterDestSnapsToShore();
  testGroupRally();
  testLongRangeAndPerf();
  testCommandOverride();
  console.log("move-check ok");
}

main();
