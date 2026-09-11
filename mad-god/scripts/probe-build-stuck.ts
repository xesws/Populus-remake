// v0.38 建筑工地卡死探针（脚本，不进 npm run check）：复刻玩家建房链路，找出"几个房子死活建不起来"。
//
// 用法：npx tsx scripts/probe-build-stuck.ts [seed] [秒数] [房屋数]
//
// 复刻的玩家链路（与 game.ts primary/右键一致）：
//   选村民 → sim.canFound 判定 → sim.foundSite(BLUE,…) → sim.assignBuilders(BLUE, site)
// 之后村民砍树/运木/交付/渐进建造全部由 sim 的既有逻辑接管。本脚本只观测：
//   ① 每座工地 300s 后是否完工；② 未完工的工地：木材进度/建工数量/建工卡在哪一步；
//   ③ 建工携带木料却送不进去时，打印可走性、到边缘点距离、astar 是否能到边缘点。

import { Sim } from "../src/game/sim";
import { astar, nearestLand } from "../src/game/path";
import { BLUE, Building, dist2, inMap, Unit } from "../src/game/types";
import { World } from "../src/game/world";

const seed = Number(process.argv[2] ?? "42");
const seconds = Number(process.argv[3] ?? "300");
const wantHuts = Number(process.argv[4] ?? "12");

const sim = new Sim(new World(seed));
const pad = sim.world.startPad(BLUE);

/** 把 (cx,cz) 周围可落基的点收集起来（模拟玩家在 UI 里点到合法格）。 */
function collectSpots(cx: number, cz: number, want: number): Array<{ x: number; z: number }> {
  const out: Array<{ x: number; z: number }> = [];
  for (let r = 2; r <= 26 && out.length < want; r += 0.25) {
    for (let a = 0; a < 48 && out.length < want; a++) {
      const ang = (a / 48) * Math.PI * 2;
      const x = Math.round((cx + Math.cos(ang) * r) * 2) / 2;
      const z = Math.round((cz + Math.sin(ang) * r) * 2) / 2;
      if (!inMap(x, z)) continue;
      if (!sim.canFound(x, z, 1, 0, 0, "hut")) continue;
      // 互不重叠（否则落基时会因 new 建筑而失败，测不到真正的卡死）
      if (out.some((o) => dist2(o.x, o.z, x, z) < 3.4 * 3.4)) continue;
      out.push({ x, z });
    }
  }
  return out;
}

// 玩家方：先补一批村民（村民从茅屋出生，这里直接放在出生点附近）
const walkers: Unit[] = [];
for (let i = 0; i < 24; i++) {
  const ang = (i / 24) * Math.PI * 2;
  const x = pad.x + Math.cos(ang) * (2 + (i % 4) * 0.5);
  const z = pad.z + Math.sin(ang) * (2 + (i % 4) * 0.5);
  walkers.push(sim.addUnit(BLUE, "walker", x, z));
}

const spots = collectSpots(pad.x, pad.z, wantHuts);
const sites: Building[] = [];
for (const s of spots) {
  const made = sim.foundSite(BLUE, s.x, s.z, 0, "hut");
  if (!made) continue;
  // 模拟玩家"选中最近 2 名村民 + 建房"：选中 → assignBuilders
  for (const u of walkers) u.selected = false;
  walkers
    .slice()
    .sort((a, b) => dist2(a.x, a.z, made.x, made.z) - dist2(b.x, b.z, made.x, made.z))
    .slice(0, 2)
    .forEach((u) => {
      u.selected = true;
    });
  sim.assignBuilders(BLUE, made);
  for (const u of walkers) u.selected = false;
  sites.push(made);
}
console.log(`probe-build-stuck: seed=${seed} 工地 ${sites.length} 座，村民 ${walkers.length} 名，跑 ${seconds}s`);

for (let t = 0; t < seconds; t += 0.05) {
  sim.tick(0.05);
  sim.winner = null;
}

const done = sites.filter((b) => b.level >= 1);
const stuck = sites.filter((b) => b.level < 1);
console.log(`\n完工 ${done.length}/${sites.length}；卡住 ${stuck.length} 座`);
console.log("工地 | 等级 | 木料 | 进度built | 建工数 | 建工状态");
for (const b of sites) {
  const crew = sim.units.filter((u) => u.team === BLUE && u.buildId === b.id && u.hp > 0);
  const state = crew
    .map((u) => {
      const edge = sim.padEdge(b.x, b.z, b.padW, b.padD, b.yaw, u.x, u.z);
      const rimOk = sim.world.walkableAt(edge.x, edge.z);
      const path = astar(sim.world, u.x, u.z, edge.x, edge.z, 20736, 0);
      const end = path[path.length - 1];
      const reach = !!end && Math.hypot(end.x - edge.x, end.z - edge.z) < 0.01;
      return `#${u.id}(${u.job},carry=${u.carry},距边${Math.hypot(u.x - edge.x, u.z - edge.z).toFixed(1)},边可走=${rimOk},可达边=${reach})`;
    })
    .join(" ");
  console.log(
    `(${b.x.toFixed(1)},${b.z.toFixed(1)}) | L${b.level} | ${b.wood}/${b.need} | ${b.built.toFixed(2)} | ${crew.length} | ${state || "无建工"}`,
  );
}
const idle = sim.units.filter((u) => u.team === BLUE && u.kind === "walker" && u.hp > 0 && u.carry === 0 && u.buildId === 0);
console.log(`\n未挂任何建工任务的空闲村民：${idle.length}（玩家链路只给被指派者挂 buildId）`);
const carriers = sim.units.filter((u) => u.team === BLUE && u.kind === "walker" && u.hp > 0 && u.carry === 1);
console.log(`扛着木头的村民：${carriers.length}`);
for (const u of carriers.slice(0, 8)) {
  const site = sim.buildingById(u.targetId) ?? sim.nearestNeedSite(BLUE, u.x, u.z);
  const edge = site ? sim.padEdge(site.x, site.z, site.padW, site.padD, site.yaw, u.x, u.z) : null;
  const land = nearestLand(sim.world, u.x, u.z);
  console.log(
    `  #${u.id} job=${u.job} 站(${u.x.toFixed(1)},${u.z.toFixed(1)}) 可走=${sim.world.walkableAt(u.x, u.z)} 最近陆地=${land ? `${land.x.toFixed(1)},${land.z.toFixed(1)}` : "无"} 目标工地=${site ? `#${site.id}(${site.wood}/${site.need})` : "无"} 距边=${edge ? Math.hypot(u.x - edge.x, u.z - edge.z).toFixed(1) : "-"}`,
  );
}
