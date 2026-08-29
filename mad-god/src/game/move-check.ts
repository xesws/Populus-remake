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

/**
 * v0.24：按"到没到"推进，而不是给一个写死的秒数窗口。
 * 72 格模板图比原来 52 格的平缓图丘陵得多：walker 上坡要按坡度降速（下限 0.5 格/s）、
 * 还要绕建筑地基，实测同样 7 格的路程需要 3~9 秒（还受 think 计时与暴击击退的随机抖动影响），
 * 所以写死 tickFor(sim, 8) 会偶发误报（10 次挂 2 次）。本用例真正要断言的是
 * 「指令目的地会被走到并清掉」，速度另有 terrain-gen-check 的用例负责。
 * 这里给宽容上限、到达即提前退出，因此不会拖慢测试。
 */
function untilArrived(sim: Sim, u: Unit, capSec: number): number {
  const steps = Math.round(capSec / 0.05);
  for (let i = 0; i < steps; i++) {
    sim.tick(0.05);
    // 判据用游戏自己的"到达事件"（onArrive 会清掉 move 目的地），
    // 而不是"离目标 0.35 格内"——后者会在单位还没走完路径时就抢先返回。
    if (u.moveX < 0) return (i + 1) * 0.05;
  }
  return -1;
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
  const tArr = untilArrived(sim, u, 20);
  assert(tArr > 0, `plain: arrives (d=${dist(u.x, u.z, dest.x, dest.z).toFixed(2)} 20s 内没走到)`);
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
  const tCorner = untilArrived(sim, u, 24);
  const endD = dist(u.x, u.z, dest.x, dest.z);
  assert(tCorner > 0 && endD < 0.35, `corner: arrives past hut (d=${endD.toFixed(2)})`);
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

/**
 * 5-6. Long-range path is not truncated and astar is fast.
 * v0.25 断言修正：原来拿"航点数 > 30"当"路径没被截断"的代理指标，但航点数取决于路径
 * 被拉直简化到什么程度，是个脆弱口径——v0.25 把起伏拉大后，同样 18 格路程的航点数
 * 正好落到 30，代理指标假报警（实测末点距 dest 0.00 格、折线长 19.06 > 直线 17.95，
 * 路径本来是完整的）。现在直接断言"截断"这件事：末点必须落在 dest 上，
 * 且折线总长不短于直线距离——真被截断时这两条都会挂，比数航点数贴语义也不会随地形抖动。
 */
function testLongRangeAndPerf(): void {
  const sim = new Sim(new World(19));
  const u = blueWalker(sim);
  const dest = openCellNear(sim, u.x, u.z, 18, 26);
  const t0 = performance.now();
  const path = astar(sim.world, u.x, u.z, dest.x, dest.z);
  const ms = performance.now() - t0;
  const last = path.length ? path[path.length - 1]! : null;
  const straight = dist(u.x, u.z, dest.x, dest.z);
  assert(!!last && dist(last.x, last.z, dest.x, dest.z) < 0.01, `long: path reaches dest, not truncated (len=${path.length})`);
  let polyline = 0;
  for (let i = 1; i < path.length; i++) polyline += dist(path[i]!.x, path[i]!.z, path[i - 1]!.x, path[i - 1]!.z);
  assert(path.length >= 8, `long: multi-waypoint path (len=${path.length})`);
  assert(polyline >= straight * 0.95, `long: polyline ${polyline.toFixed(1)} ≥ straight ${straight.toFixed(1)}`);
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
  assert(dist(u.x, u.z, dest.x, dest.z) < 0.5, "override: arrives despite stale founder state");
  // No re-capture: unit stays put afterwards
  tickFor(sim, 5);
  assert(dist(u.x, u.z, dest.x, dest.z) < 1.0, "override: not re-captured by founding logic");
  // Training queue can be interrupted by a move order
  // Pick the retreat point first, then place the camp on the opposite side of it:
  // if the pad sits inside the retreat corridor, v0.6 stuck/unstick mechanics can
  // stall the walker (pre-existing flake unrelated to command override).
  const retreat = openCellNear(sim, u.x, u.z, 5, 8);
  const awayX = u.x - retreat.x;
  const awayZ = u.z - retreat.z;
  const awayLen = Math.hypot(awayX, awayZ) || 1;
  const campSpot = openCellNear(sim, u.x + (awayX / awayLen) * 3, u.z + (awayZ / awayLen) * 3, 0.5, 3);
  const camp = sim.placeComplete(BLUE, campSpot.x, campSpot.z, 0, "warriorHut", 1);
  assert(!!camp, "interrupt: camp placed");
  u.selected = true;
  const sent = sim.train(BLUE, "warrior");
  assert(sent, "interrupt: train accepted with camp");
  assert(u.job === "train", "interrupt: walker queued for training");
  sim.sendMove(u, retreat.x, retreat.z);
  assert(u.job === "move", "interrupt: move overrides training");
  tickFor(sim, 8);
  assert(dist(u.x, u.z, retreat.x, retreat.z) < 0.5, "interrupt: arrives at retreat point");
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
