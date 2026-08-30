/**
 * v0.29 · probe-perf · 尖刺定位探针：复刻 perf-budget-check 场景，
 * 记录每个 tick 的耗时 + 当 tick 寻路/索敌统计，找出 p99 尖刺的元凶
 * （JIT 热身 / A* 预算饱和 / 尸体 cull / GC）。
 */
import { World } from "../src/game/world";
import { Sim } from "../src/game/sim";
import { pathStats } from "../src/game/path";
import { combatAcquireStats } from "../src/game/systems/combat-system";
import { BLUE, RED } from "../src/game/types";

// 与 perf-budget-check.ts 相同的军团生成（简化复制，保证同场景）
function spawnLegion(sim: Sim, team: number, cx: number, cz: number, n: number) {
  const kinds = ["walker", "warrior", "firewarrior"] as const;
  let made = 0;
  const cells: { x: number; z: number; d: number }[] = [];
  for (let r = 0; r < 40 && cells.length < n * 2; r++) {
    for (let dz = -r; dz <= r; dz++) {
      for (let dx = -r; dx <= r; dx++) {
        const x = cx + dx * 1.1;
        const z = cz + dz * 1.1;
        if (sim.world.walkableAt(x, z)) cells.push({ x, z, d: dx * dx + dz * dz });
      }
    }
  }
  cells.sort((a, b) => a.d - b.d);
  for (const c of cells) {
    if (made >= n) break;
    const u = sim.addUnit(team, kinds[made % 3] as never, c.x, c.z);
    if (!u) continue;
    u.order = "fight";
    made++;
  }
  return made;
}

const world = new World(4242);
const sim = new Sim(world);
const nB = spawnLegion(sim, BLUE, 28, 56, 350);
const nR = spawnLegion(sim, RED, 46, 56, 200);
console.log(`spawn 蓝${nB} 红${nR}`);

const N = 1800;
const rec: { t: number; ms: number; used: number; denied: number; acq: number }[] = [];
for (let i = 0; i < N; i++) {
  const t0 = performance.now();
  sim.tick(1 / 60);
  const ms = performance.now() - t0;
  rec.push({ t: i, ms, used: pathStats.lastUsed, denied: pathStats.lastDenied, acq: combatAcquireStats.lastMs });
}
const sorted = [...rec].sort((a, b) => b.ms - a.ms);
console.log("top12 尖刺：");
for (const r of sorted.slice(0, 12)) {
  console.log(
    `tick=${r.t} ms=${r.ms.toFixed(2)} paths=${r.used}(拒${r.denied}) acquireMs=${r.acq.toFixed(2)}`,
  );
}
// 分段均值：看尖刺是热身期还是全程
for (let s = 0; s < 6; s++) {
  const seg = rec.slice(s * 300, s * 300 + 300);
  const mean = seg.reduce((a, b) => a + b.ms, 0) / seg.length;
  const p99 = seg.slice().sort((a, b) => b.ms - a.ms)[2]!.ms;
  const paths = seg.reduce((a, b) => a + b.used, 0) / 300;
  console.log(`段${s} tick[${s * 300},${s * 300 + 300}) mean=${mean.toFixed(2)} p99≈${p99.toFixed(2)} 均paths/tick=${paths.toFixed(1)}`);
}
