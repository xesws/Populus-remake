/**
 * v0.33 群岛分裂回归锁（Q1-B 分岛对峙 / Q2-A 掷币定模板 / Q3-A 按岛均等）：
 *   T1 双模式存活：1..40 里分裂与连通都出现（50% 掷币两边都开火）；
 *   T2 分裂地形：split 图恰 2~3 座成岛（≥500 格），连通图恰 1 座；
 *   T3 出生点：分裂模式蓝红必须属于不同终局岛，双方岛均≥2500 格且可走；不存在同岛回退；
 *     连通模式双方仍在同一终局岛；
 *   T4 资源均等：每座成岛野人 == 3；红岛树 ≥ 4；有出生点的岛 16 格内必有树；
 *   T5 红方自理：分裂图跑 60s（RED AIDirector）：红建筑/单位全在本岛、人口增长、
 *     跨海波次 waves == 0（探路取消，只记日志）；
 *   T6 确定性：同 seed 两次模式、终局出生点、attempt 与保护区一致。
 */
import { Sim } from "./sim";
import { BLUE, RED, ISLE_BASE_MIN, ISLE_MIN_CELLS } from "./types";
import { World } from "./world";
import { WorldGen } from "./world-gen";
import { AIDirector, AIProfile } from "./ai";
import { astar } from "./path";

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

function bigIslands(w: World): { label: number; cells: number }[] {
  return w.islands.filter((i) => i.cells >= ISLE_MIN_CELLS);
}

// T1：双模式存活
function testBothModes(): { split: number[]; connected: number[] } {
  const split: number[] = [];
  const connected: number[] = [];
  for (let seed = 1; seed <= 40; seed++) {
    const gen = WorldGen.generate(seed, 289, 0.25);
    (gen.split ? split : connected).push(seed);
  }
  assert(split.length >= 8, `分裂模式须开火（实际 ${split.length}/40）`);
  assert(connected.length >= 8, `连通模式须开火（实际 ${connected.length}/40）`);
  console.log(`testBothModes ok（分裂 ${split.length}/40：${split.slice(0, 8).join(",")}…）`);
  return { split, connected };
}

// T2：分裂地形 2~3 成岛，连通恰 1
function testIslandCounts(seeds: { split: number[]; connected: number[] }): void {
  for (const seed of seeds.split) {
    const w = new World(seed);
    assert(w.splitIsles, `seed=${seed} 应分裂`);
    const n = bigIslands(w).length;
    assert(n >= 2 && n <= 3, `seed=${seed} 分裂图须 2~3 座成岛（实际 ${n}）`);
  }
  for (const seed of seeds.connected) {
    const w = new World(seed);
    assert(!w.splitIsles, `seed=${seed} 应连通`);
    assert(bigIslands(w).length === 1, `seed=${seed} 连通图须恰 1 座成岛`);
  }
  console.log("testIslandCounts ok（分裂 2~3 岛 / 连通单岛）");
}

// T3：出生点分布
function testSpawnSplit(seeds: { split: number[]; connected: number[] }): void {
  for (const seed of seeds.split) {
    const w = new World(seed);
    const lb = w.islandAt(w.starts[0].x, w.starts[0].z);
    const lr = w.islandAt(w.starts[1].x, w.starts[1].z);
    assert(w.walkableAt(w.starts[0].x, w.starts[0].z), `seed=${seed} 蓝出生点须可走`);
    assert(w.walkableAt(w.starts[1].x, w.starts[1].z), `seed=${seed} 红出生点须可走`);
    assert(lb !== lr, `seed=${seed} 分裂图双方出生点必须分属不同终局岛（实际同为 ${lb}）`);
    const blue = w.islands.find((i) => i.label === lb)!;
    const red = w.islands.find((i) => i.label === lr)!;
    assert(blue && blue.cells >= ISLE_BASE_MIN, `seed=${seed} 蓝岛须≥${ISLE_BASE_MIN} 格（实际 ${blue?.cells}）`);
    assert(red && red.cells >= ISLE_BASE_MIN, `seed=${seed} 红岛须≥${ISLE_BASE_MIN} 格（实际 ${red?.cells}）`);
  }
  for (const seed of seeds.connected) {
    const w = new World(seed);
    assert(
      w.islandAt(w.starts[0].x, w.starts[0].z) === w.islandAt(w.starts[1].x, w.starts[1].z),
      `seed=${seed} 连通图双方出生点须同岛`,
    );
  }
  console.log("testSpawnSplit ok（分裂严格分岛/连通同岛）");
}

// T4：资源均等
function testIslandResources(seeds: { split: number[]; connected: number[] }): void {
  const picks = [...seeds.split.slice(0, 4), ...seeds.connected.slice(0, 2)];
  for (const seed of picks) {
    const sim = new Sim(new World(seed));
    const w = sim.world;
    for (const isle of bigIslands(w)) {
      let wild = 0;
      for (const u of sim.units) {
        if (u.kind === "wildman" && u.hp > 0 && w.islandAt(u.x, u.z) === isle.label) wild++;
      }
      assert(wild === 3, `seed=${seed} 岛${isle.label}(${isle.cells}格) 野人须==3（实际 ${wild}）`);
      let trees = 0;
      for (const t of sim.trees) {
        if (w.islandAt(t.x, t.z) === isle.label) trees++;
      }
      const redHere = w.islandAt(w.starts[1].x, w.starts[1].z) === isle.label;
      if (redHere) assert(trees >= 4, `seed=${seed} 红岛须≥4 棵树（实际 ${trees}）`);
      // 有出生点的岛：16 格内必有树（基地有木头砍）。
      const hasStart = [w.starts[0], w.starts[1]].some((s) => w.islandAt(s.x, s.z) === isle.label);
      if (hasStart) {
        let near = false;
        for (const t of sim.trees) {
          if (w.islandAt(t.x, t.z) !== isle.label) continue;
          for (const s of [w.starts[0], w.starts[1]]) {
            if (w.islandAt(s.x, s.z) !== isle.label) continue;
            if ((t.x - s.x) ** 2 + (t.z - s.z) ** 2 <= 16 * 16) near = true;
          }
        }
        assert(near, `seed=${seed} 岛${isle.label} 出生点 16 格内须有树`);
      }
    }
  }
  console.log("testIslandResources ok（每岛野人 3/红岛树≥4/出生点 16 格有树）");
}

// T5：红方自理（分裂图 60s）
function testRedLocality(seeds: { split: number[] }): void {
  const seed = seeds.split.find((s) => {
    const w = new World(s);
    return w.islandAt(w.starts[0].x, w.starts[0].z) !== w.islandAt(w.starts[1].x, w.starts[1].z);
  });
  assert(seed, "1..40 里须有分岛出生的分裂图");
  const sim = new Sim(new World(seed));
  const dir = new AIDirector([[RED, AIProfile.normal()]]);
  dir.attach(sim);
  const w = sim.world;
  const redIsle = w.islandAt(w.starts[1].x, w.starts[1].z);
  const pop0 = sim.units.filter((u) => u.team === RED && u.hp > 0).length;
  for (let t = 0; t < 60; t += 0.05) {
    sim.tick(0.05);
    dir.update(sim, 0.05);
  }
  // 整地 wobble  settling：岸边反复落基会让地形逐帧起伏，单位可能恰好采样在
  // 不可走的瞬时帧——resolveCollisions 下帧即弹回可走格；多跑 1s 再断言，滤瞬态。
  for (let t = 0; t < 1; t += 0.05) {
    sim.tick(0.05);
    dir.update(sim, 0.05);
  }
  for (const u of sim.units) {
    // 住户（homeId>0）站屋顶/甲板：pad 本来就不可走，随建筑走，建筑另查——这里只查自由单位。
    if (u.team !== RED || u.hp <= 0 || u.homeId > 0) continue;
    const lb = w.islandAt(u.x, u.z);
    if (lb === redIsle) continue;
    // 填海标签过期（AI 整地填水造陆，被顶出的新陆地标签为 -1）：
    // 真不变式是“走得到”——从红出生点 astar 能连过去即合法（填出来的岸），连不过去才是真出岛。
    if (!w.walkableAt(u.x, u.z)) throw new Error(`红单位#${u.id}(${u.kind}) 站在不可走格（@${u.x.toFixed(1)},${u.z.toFixed(1)}）`);
    const p = astar(w, w.starts[1].x, w.starts[1].z, u.x, u.z, 20736, 0);
    assert(p.length > 0, `红单位#${u.id}(${u.kind}) 真出岛（@${u.x.toFixed(1)},${u.z.toFixed(1)}） astar 不可达`);
  }
  for (const b of sim.buildings) {
    if (b.team !== RED || b.hp <= 0) continue;
    if (w.islandAt(b.x, b.z) === redIsle) continue;
    // 同上：填海造陆的标签过期——3 格内有本岛可走格即合法（贴岸新填地）。
    let ok = false;
    for (let k = 0; k < 12 && !ok; k++) {
      const a = (k / 12) * Math.PI * 2;
      const x = b.x + Math.cos(a) * 3;
      const z = b.z + Math.sin(a) * 3;
      if (w.walkableAt(x, z) && w.islandAt(x, z) === redIsle) ok = true;
    }
    assert(ok, `红建筑#${b.id}(${b.kind}) 真出岛（@${b.x.toFixed(1)},${b.z.toFixed(1)}）`);
  }
  const pop1 = sim.units.filter((u) => u.team === RED && u.hp > 0).length;
  assert(pop1 > pop0, `红方人口须增长（${pop0}→${pop1}，本岛经济须转起来）`);
  assert(dir.brains[0]!.war.waves === 0, "跨海波次须取消（waves==0，只记日志）");
  console.log(`testRedLocality ok（seed=${seed} 红守本岛/人口${pop0}→${pop1}/零波次）`);
}

// T6：确定性
function testDeterministic(): void {
  for (const seed of [1, 12, 18, 42]) {
    const ga = WorldGen.generate(seed, 289, 0.25);
    const gb = WorldGen.generate(seed, 289, 0.25);
    assert(ga.split === gb.split, `seed=${seed} split 标志须稳定`);
    assert(
      ga.protectedZones.length === gb.protectedZones.length &&
        ga.protectedZones.every((s, i) => s.x === gb.protectedZones[i]!.x && s.z === gb.protectedZones[i]!.z),
      `seed=${seed} 地形保护区须稳定`,
    );
    const a = new World(seed);
    const b = new World(seed);
    assert(a.genAttempt === b.genAttempt, `seed=${seed} 接受 attempt 须稳定`);
    assert(a.splitIsles === b.splitIsles, `seed=${seed} 终局模式须稳定`);
    assert(
      a.starts.every((s, i) => s.x === b.starts[i]!.x && s.z === b.starts[i]!.z && s.yaw === b.starts[i]!.yaw),
      `seed=${seed} 终局出生点须稳定`,
    );
  }
  console.log("testDeterministic ok（同 seed 模式/保护区/attempt/终局出生点稳定）");
}

function main(): void {
  const seeds = testBothModes();
  testIslandCounts(seeds);
  testSpawnSplit(seeds);
  testIslandResources(seeds);
  testRedLocality(seeds);
  testDeterministic();
  console.log("island-check ok");
}

main();
