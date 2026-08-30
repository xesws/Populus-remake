/**
 * v0.29 · worker-codec · 快照编解码往返（v0.29c-1 Sim Worker 化的 codec 检查）
 * 场景：固定 seed 建 World+Sim，造少量单位/战斗（tick 一小段），断言：
 *   a) encodeWorld → applyWorld：镜像 heights/swamp/lava/scorch/trees/units/buildings 与源逐字段一致，
 *      镜像 world 的 heightAt/starts/templateId 与源一致；
 *   b) encodeSnapshot → applySnapshot 两轮：镜像 units 数量与关键字段（x,y,z,yaw,hp,kind,team,
 *      homeId,enterT,downT,carry）与源一致；战斗致死后，消失单位从镜像移除；
 *   c) SoA 装载/卸载不越界（长度= n×stride）、kind/team/job/trainKind/disguise/carry 索引映射稳定；
 *   d) terrainTouched：raise/lower cast 与 volcano/quake 激活期为 true，平时 false；
 *      encodeSnapshot 的 terrainDirty/terrain 载荷与 transferOf 行为正确。
 * 跑法：npx tsx src/game/worker-codec-check.ts（零 DOM/Worker 依赖）。
 */
import { Sim } from "./sim";
import { World } from "./world";
import { BLUE, RED } from "./types";
import { cast } from "./spells";
import {
  applySnapshot,
  applyWorld,
  createSimMirror,
  encodeSnapshot,
  encodeUnitSoA,
  encodeWorld,
  JOBS,
  terrainTouched,
  transferOf,
  UF_N,
  UNIT_KINDS,
  UU_N,
} from "./worker/codec";
import type { SimMirror } from "./worker/codec";
import type { Unit } from "./types";

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

/** SoA 载体是 f32，位置/血量允许 1e-4 截断；枚举/整数字段必须精确。 */
const EPS = 1e-4;

/** 造一个带战斗的对局：蓝武士贴脸一个红村民（红方唯一的近战目标，避免误伤干扰断言）。 */
function makeCombatSim(): { sim: Sim; victimId: number } {
  const sim = new Sim(new World(42));
  const s = sim.world.startPad(BLUE);
  const victim = sim.addUnit(RED, "walker", s.x + 1.5, s.z + 1.5);
  sim.addUnit(BLUE, "warrior", s.x + 2.0, s.z + 1.5);
  return { sim, victimId: victim.id };
}

/** 镜像 units 数量 + 关键字段与源逐单位一致（按 id 对齐）。 */
function assertUnitsMatch(sim: Sim, mirror: SimMirror, tag: string): void {
  assert(mirror.units.length === sim.units.length, `${tag}：镜像 units 数量 ${mirror.units.length} === ${sim.units.length}`);
  for (const u of sim.units) {
    const m = mirror.unitsById.get(u.id);
    assert(m !== undefined, `${tag}：镜像缺单位#${u.id}`);
    assert(Math.abs(m!.x - u.x) <= EPS, `${tag}：#${u.id} x ${m!.x} ≈ ${u.x}`);
    assert(Math.abs(m!.y - u.y) <= EPS, `${tag}：#${u.id} y`);
    assert(Math.abs(m!.z - u.z) <= EPS, `${tag}：#${u.id} z`);
    assert(Math.abs(m!.yaw - u.yaw) <= EPS, `${tag}：#${u.id} yaw`);
    assert(Math.abs(m!.hp - u.hp) <= EPS, `${tag}：#${u.id} hp ${m!.hp} ≈ ${u.hp}`);
    assert(m!.kind === u.kind, `${tag}：#${u.id} kind ${m!.kind} === ${u.kind}`);
    assert(m!.team === u.team, `${tag}：#${u.id} team`);
    assert(m!.homeId === u.homeId, `${tag}：#${u.id} homeId`);
    assert(Math.abs(m!.enterT - u.enterT) <= EPS, `${tag}：#${u.id} enterT`);
    assert(Math.abs(m!.downT - u.downT) <= EPS, `${tag}：#${u.id} downT`);
    assert(m!.carry === u.carry, `${tag}：#${u.id} carry`);
  }
}

// a) world 全量往返
function testWorldRoundtrip(): void {
  const sim = new Sim(new World(42));
  const mirror = createSimMirror();
  applyWorld(mirror, encodeWorld(sim.world, sim));
  const w = sim.world;
  const mw = mirror.world;
  assert(mw.h.length === w.h.length, "heights 长度一致");
  for (let i = 0; i < w.h.length; i++) {
    assert(mw.h[i] === w.h[i], `heights[${i}] 逐字段一致`);
  }
  for (let i = 0; i < w.swamp.length; i++) {
    assert(mw.swamp[i] === w.swamp[i], `swamp[${i}] 逐字段一致`);
  }
  assert(mw.lava.length === w.lava.length && mw.scorch.length === w.scorch.length, "lava/scorch 全量落地");
  assert(mw.genSeed === w.genSeed && mw.templateId === w.templateId, `世界元数据一致（${mw.templateId}）`);
  assert(mw.starts[0]!.x === w.starts[0]!.x && mw.starts[1]!.z === w.starts[1]!.z, "starts 一致");
  // 镜像 world 的纯数据方法可用且与源同值（主线程渲染/寻路判据的数据基础）。
  for (let k = 0; k < 20; k++) {
    const x = 3 + k * 3.3;
    const z = 2 + k * 3.7;
    assert(Math.abs(mw.heightAt(x, z) - w.heightAt(x, z)) <= EPS, `mirror.heightAt(${x},${z}) 与源一致`);
    assert(mw.sampleAt(x, z) === w.sampleAt(x, z), `mirror.sampleAt(${x},${z}) 与源一致`);
  }
  assert(mirror.trees.length === sim.trees.length, "trees 数量一致");
  for (let i = 0; i < sim.trees.length; i++) {
    const t = sim.trees[i]!;
    const mt = mirror.trees[i]!;
    assert(mt.id === t.id && mt.x === t.x && mt.z === t.z && mt.y === t.y && mt.alive === t.alive && mt.regen === t.regen, `tree#${t.id} 逐字段一致`);
  }
  assert(mirror.buildings.length === sim.buildings.length, "初始 buildings 数量一致");
  for (const b of sim.buildings) {
    const mb = mirror.buildings.find((o) => o.id === b.id)!;
    assert(mb.kind === b.kind && mb.level === b.level && mb.hp === b.hp && mb.padW === b.padW && mb.padD === b.padD, `building#${b.id}(${b.kind}) 逐字段一致`);
  }
  assertUnitsMatch(sim, mirror, "world");
  console.log("testWorldRoundtrip ok（heights/swamp/trees/实体/元数据 + 镜像 world 方法）");
}

// b) snapshot 两轮往返 + 消失单位移除
function testSnapshotRoundtrip(): void {
  const { sim, victimId } = makeCombatSim();
  const mirror = createSimMirror();
  applyWorld(mirror, encodeWorld(sim.world, sim));

  for (let i = 0; i < 120; i++) sim.tick(1 / 60); // 2s：接战、掉血
  applySnapshot(mirror, encodeSnapshot(sim));
  assertUnitsMatch(sim, mirror, "round1");
  assert(Math.abs(mirror.time - sim.time) <= EPS, "time 一致");
  assert(mirror.teams[0]!.manaCap === sim.teams[0]!.manaCap, "teams[0].manaCap 一致");
  assert(mirror.teams[1]!.order === sim.teams[1]!.order, "teams[1].order 一致");
  assert(mirror.logs.length === sim.logs.length && mirror.toastGen === sim.toastGen, "logs/toastGen 一致");

  sim.toast("codec-check：toast 往返");
  applySnapshot(mirror, encodeSnapshot(sim));
  assert(mirror.logs.includes("codec-check：toast 往返"), "toast 尾巴进镜像");
  assert(mirror.toastGen === sim.toastGen, "toastGen 递增同步");

  // 战斗打到红村民死亡：round2 里该单位必须从镜像移除。
  let dead = false;
  for (let i = 0; i < 600 && !dead; i++) {
    sim.tick(1 / 60);
    dead = sim.units.every((u) => u.id !== victimId);
  }
  assert(dead, "红村民在 10s 内被蓝武士击杀（战斗链路就绪）");
  applySnapshot(mirror, encodeSnapshot(sim));
  assertUnitsMatch(sim, mirror, "round2");
  assert(mirror.unitsById.get(victimId) === undefined, "消失单位已从镜像 unitsById 移除");
  assert(!mirror.units.some((u) => u.id === victimId), "消失单位已从镜像 units 数组移除");
  console.log("testSnapshotRoundtrip ok（两轮往返逐字段一致 + 消失单位移除 + toast 同步）");
}

// c) SoA 边界与索引映射
function testSoAIndices(): void {
  // 空集：不越界、零长
  const empty = encodeUnitSoA([]);
  assert(empty.f32.length === 0 && empty.u8.length === 0, "空单位集 SoA 零长");

  const sim = new Sim(new World(42));
  // 每个兵种一只 + 野人：kind 索引全覆盖；再设 job/trainKind/disguise/carry 验证 u8 面。
  const units: Unit[] = [];
  for (const kind of UNIT_KINDS) {
    units.push(sim.addUnit(BLUE, kind, 10 + units.length, 10));
  }
  const spy = units.find((u) => u.kind === "spy")!;
  spy.disguise = RED;
  spy.job = "chop";
  spy.trainKind = "warrior";
  spy.carry = 1;
  spy.channelId = 5; // v0.29c-2 训练排队序号随 SoA 传输（trainQueue 排序依据）
  const walker = units.find((u) => u.kind === "walker")!;
  walker.job = "haul";
  walker.channelId = 3;

  const { f32, u8 } = encodeUnitSoA(units);
  assert(f32.length === units.length * UF_N, `f32 长度 = n×UF_N（${f32.length}）`);
  assert(u8.length === units.length * UU_N, `u8 长度 = n×UU_N（${u8.length}）`);

  const mirror = createSimMirror();
  applyWorld(mirror, encodeWorld(sim.world, sim));
  applySnapshot(mirror, encodeSnapshot(sim));
  // 镜像 units 含 sim 全量单位（种子单位 + 本测 7 只）；断言测试单位全部装载。
  assert(units.every((u) => mirror.unitsById.get(u.id) !== undefined), "SoA 装载：7 只测试单位全部在镜像");
  for (const u of units) {
    const m = mirror.unitsById.get(u.id)!;
    assert(m.kind === u.kind, `kind 索引映射稳定（${u.kind}）`);
    assert(m.team === u.team, "team 索引映射稳定");
    assert(m.job === u.job, `job 映射（${u.job}）`);
    assert(m.trainKind === u.trainKind, `trainKind 映射（${u.trainKind}）`);
    assert(m.channelId === u.channelId, `channelId 映射（v0.29c-2，${u.channelId}）`);
    assert(m.disguise === u.disguise, `disguise 映射（${u.disguise}）`);
    assert(m.carry === u.carry, `carry 位映射（${u.carry}）`);
  }
  assert(mirror.unitsById.get(spy.id)!.disguise === RED, "spy 伪装 = RED");
  assert(mirror.unitsById.get(walker.id)!.job === "haul", "walker job = haul");
  assert(JOBS.length === 5 && UNIT_KINDS.length === 7, "索引表规模符合预期（追加新值只能 push 到末尾）");
  console.log("testSoAIndices ok（SoA 不越界 + kind/team/job/trainKind/disguise/carry 映射稳定）");
}

// d) 地形置脏判定与快照地形载荷
function testTerrainTouched(): void {
  const sim = new Sim(new World(42));
  const s = sim.world.startPad(BLUE);
  // 平时：无地形系 cast、无激活期 → false；无关工具不置脏。
  assert(terrainTouched(sim, null) === false, "平时不置脏");
  assert(terrainTouched(sim, "lightning") === false, "lightning 不改地形 → 不置脏");

  // 雕塑 cast：raise / lower 置脏（lastCastTool 语义，worker 编码后清空）。
  sim.fillCharges(BLUE);
  assert(terrainTouched(sim, "raise") === true, "raise cast → true");
  assert(terrainTouched(sim, "lower") === true, "lower cast → true");
  assert(terrainTouched(sim, "swamp") === true, "swamp cast → true（swamp 场在脏载荷里）");
  cast(sim, BLUE, "raise", s.x + 3, s.z + 3, 0.2);
  assert(terrainTouched(sim, null) === false, "cast 清空后（无激活期）回到 false");

  // 地震激活期（quake 非空直到 t > dur+4）。
  const q = cast(sim, BLUE, "quake", s.x + 5, s.z + 3, 0);
  assert(q.ok, "quake cast 成功");
  assert(sim.quake !== null, "quake 激活期对象就位");
  assert(terrainTouched(sim, null) === true, "quake 激活期 → true");

  // 火山激活期（volcano 非空直到 t > dur+8）。
  const v = cast(sim, BLUE, "volcano", s.x + 3, s.z + 5, 0);
  assert(v.ok, "volcano cast 成功");
  assert(sim.volcano !== null, "volcano 激活期对象就位");
  assert(terrainTouched(sim, null) === true, "volcano 激活期 → true");

  // 快照载荷：不脏不带；脏则四场地形全量与源一致，transferOf 列出全部 buffer。
  const clean = encodeSnapshot(sim, false);
  assert(clean.terrainDirty === false && clean.terrain === null, "不脏：terrain 载荷为空");
  const dirty = encodeSnapshot(sim, true);
  assert(dirty.terrainDirty === true && dirty.terrain !== null, "脏：terrain 载荷就位");
  assert(dirty.terrain!.h.length === sim.world.h.length, "脏载荷 heights 全量");
  for (let i = 0; i < sim.world.h.length; i++) {
    assert(dirty.terrain!.h[i] === sim.world.h[i], `脏载荷 heights[${i}] 与源一致`);
  }
  const tf = transferOf(dirty);
  assert(tf.length === 6, `脏快照 transfer 6 块（units×2 + 地形×4），实际 ${tf.length}`);
  assert(transferOf(clean).length === 2, "净快照 transfer 2 块（units×2）");
  console.log("testTerrainTouched ok（raise/lower/swamp cast + volcano/quake 激活期置脏 + 载荷/transfer 正确）");
}

function main(): void {
  testWorldRoundtrip();
  testSnapshotRoundtrip();
  testSoAIndices();
  testTerrainTouched();
  console.log("worker-codec ok");
}

main();
