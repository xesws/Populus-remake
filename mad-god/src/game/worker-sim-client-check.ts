/**
 * v0.29c-2 · worker-sim-client · 镜像客户端检查（?worker=1 灰度链路的客户端侧）
 * 针对feature：WorkerSimClient implements SimClient——"镜像字段 / 命令化 / 本地复刻"三类落位。
 * 场景：真 World+Sim 建 2s 对局（含战斗掉血与训练排队），经 encodeWorld/encodeSnapshot →
 * applyWorld/applySnapshot 灌入镜像；WorkerSimClient 用桩 worker（Node 无 Worker）持有镜像，断言：
 *   a) 本地复刻查询与真 Sim 同值：canFound（茅屋/训练营/哨塔×多点×多朝向）、buildingAt/
 *      buildingById/buildingPad/unitAt/occupantAt/nearestTree/countPop/countHouses/countKind/
 *      countWood/padEdge/hutDoor/padLocalToWorld/trainSlotPos/trainQueue/inSwamp/crackPoint/
 *      chargeState/hasCharge/selectedOf；
 *   b) 命令化：setOrder/setMagnet/sendMove/orderMove/orderAttackTarget/train/foundSite/
 *      assignBuilders/setSelection/toast/cast/pause/start/aiHold/setFlag/restart 落成正确
 *      MainCmd（按序进桩 worker 的 postMessage）；
 *   c) 就绪状态机：ready 前发 init 先暂存、ready 后补发；world 消息 apply + worldReady() 兑现；
 *   d) 导演专用写接口（addUnit/occupy/completeStep/placeComplete/tryPrepFound/markHouseBlocks/
 *      upgradeBuilding/fillCharges）warn 兜底不崩溃、不改镜像；
 *   e) toast 本地即时显示（镜像 logs/toastGen++）且回执 worker（计数不漂移）。
 * 跑法：npx tsx src/game/worker-sim-client-check.ts（桩 worker，零真实线程）。
 */
import { Sim } from "./sim";
import { World } from "./world";
import { BLUE, RED, TrainKind } from "./types";
import type { MainCmd, WorkerMsg } from "./worker/protocol";
import { applySnapshot, applyWorld, createSimMirror, encodeSnapshot, encodeWorld } from "./worker/codec";
import { WorkerSimClient } from "./client/worker-sim-client";

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

/** 桩 worker：记录 postMessage 序列，消息泵由测试直接喂 onMsg。 */
function makeStubWorker(): { worker: Worker; sent: MainCmd[] } {
  const sent: MainCmd[] = [];
  const worker = {
    postMessage: (m: MainCmd) => {
      sent.push(m);
    },
    onmessage: null,
    onerror: null,
  } as unknown as Worker;
  return { worker, sent };
}

/** 建一个带战斗与训练排队的对局，并把镜像灌到 client（绕过真实消息线程）。 */
function makeClientWithMirror(): { client: WorkerSimClient; sim: Sim; sent: MainCmd[] } {
  const sim = new Sim(new World(42));
  const s = sim.world.startPad(BLUE)!;
  sim.addUnit(RED, "walker", s.x + 1.5, s.z + 1.5); // 给战斗一个目标
  sim.addUnit(BLUE, "warrior", s.x + 2.0, s.z + 1.5);
  // 造训练营 + 排队：tryPrepFound/foundSite 与 sim 同口径
  for (let x = s.x + 3; x < s.x + 12; x += 0.5) {
    if (sim.tryPrepFound(x, s.z + 4, 0, "warriorHut")) {
      sim.foundSite(BLUE, x, s.z + 4, 0, "warriorHut");
      break;
    }
  }
  const camp = sim.buildings.find((b) => b.team === BLUE && b.kind === "warriorHut" && b.hp > 0)!;
  for (let i = 0; i < 120; i++) sim.tick(1 / 60); // 2s：营地完工（存木起升）
  const walkers = sim.units.filter((u) => u.team === BLUE && u.kind === "walker" && u.homeId === 0);
  const kinds: TrainKind[] = ["warrior", "preacher", "firewarrior"];
  walkers.slice(0, 3).forEach((w, i) => sim.trainingSystem.sendWalkerToCamp(sim, w, camp, kinds[i]!));

  const mirror = createSimMirror();
  applyWorld(mirror, encodeWorld(sim.world, sim));
  applySnapshot(mirror, encodeSnapshot(sim));

  const { worker, sent } = makeStubWorker();
  const client = new WorkerSimClient(() => worker);
  // 镜像灌入走公开编解码路径（与真实 worker 消息同构）；client.mirror 即 apply 的目标。
  applyWorld(client.mirror, encodeWorld(sim.world, sim));
  applySnapshot(client.mirror, encodeSnapshot(sim));
  return { client, sim, sent };
}

// a) 本地复刻查询与真 Sim 同值
function testLocalQueries(): void {
  const { client, sim } = makeClientWithMirror();
  const w = sim.world;

  // canFound：三种建筑 × 网格点 × 两个朝向，与 sim.canFound 逐点同判。
  const kinds = ["hut", "warriorHut", "tower"] as const;
  let checked = 0;
  for (const kind of kinds) {
    for (let x = 4; x < 68; x += 2.7) {
      for (let z = 4; z < 68; z += 2.7) {
        for (const yaw of [0, 0.6]) {
          assert(
            client.canFound(x, z, 1, yaw, 0, kind) === sim.canFound(x, z, 1, yaw, 0, kind),
            `canFound(${kind},${x.toFixed(1)},${z.toFixed(1)},${yaw}) 镜像与 sim 同判`,
          );
          checked++;
        }
      }
    }
  }
  assert(checked > 1000, `canFound 覆盖 ${checked} 点`);

  // buildingAt / buildingById / buildingPad
  for (const b of sim.buildings) {
    const mb = client.buildingById(b.id);
    assert(mb !== null && mb.id === b.id && mb.kind === b.kind, `buildingById(${b.id}) 同值`);
    assert(client.buildingAt(b.x, b.z)?.id === b.id, `buildingAt(自身圆心)=${b.kind}`);
    const pad = client.buildingPad(mb!);
    assert(pad.x === b.x && pad.z === b.z && pad.w === b.padW && pad.d === b.padD && pad.yaw === b.yaw, "buildingPad 同值");
  }
  assert(client.buildingAt(1, 1) === undefined, "海面无建筑");

  // unitAt / occupantAt / countPop / countKind / countWood / countHouses
  const someUnit = sim.units.find((u) => u.homeId === 0)!;
  assert(client.unitAt(someUnit.x, someUnit.z, 0.55)?.id === someUnit.id, "unitAt 命中同单位");
  assert(client.countPop(BLUE) === sim.countPop(BLUE), `countPop(BLUE)=${sim.countPop(BLUE)}`);
  assert(client.countPop(RED) === sim.countPop(RED), "countPop(RED) 同值");
  assert(client.countKind(BLUE, "walker") === sim.countKind(BLUE, "walker"), "countKind 同值");
  assert(client.countHouses(BLUE) === sim.countHouses(BLUE), "countHouses 同值");
  assert(client.countWood(BLUE) === sim.countWood(BLUE), `countWood(BLUE)=${sim.countWood(BLUE)}`);
  const occupant = sim.units.find((u) => u.homeId > 0);
  if (occupant) {
    const occ = client.occupantAt(occupant.x, occupant.z, 0.9, occupant.team as 0 | 1);
    assert(occ?.id === occupant.id, "occupantAt 拾取驻扎者");
  }

  // nearestTree / inSwamp
  const tree = sim.nearestTree(36, 36);
  const mtree = client.nearestTree(36, 36);
  assert((tree?.id ?? -1) === (mtree?.id ?? -1), "nearestTree 同树");
  for (const u of sim.units.slice(0, 10)) {
    assert(client.inSwamp(u) === sim.inSwamp(u), `inSwamp(#${u.id}) 同判`);
  }

  // padEdge / hutDoor / padLocalToWorld / trainSlotPos（几何复刻与 sim 逐点同值）
  const campB = sim.buildings.find((b) => b.team === BLUE && b.kind === "warriorHut" && b.hp > 0)!;
  for (const [fx, fz] of [[3, 3], [-4, 2], [0, -5], [6, -2]] as const) {
    const a = sim.padEdge(campB.x, campB.z, campB.padW, campB.padD, campB.yaw, campB.x + fx, campB.z + fz);
    const b = client.padEdge(campB.x, campB.z, campB.padW, campB.padD, campB.yaw, campB.x + fx, campB.z + fz);
    assert(Math.abs(a.x - b.x) < 1e-9 && Math.abs(a.z - b.z) < 1e-9, `padEdge(${fx},${fz}) 同点`);
  }
  const hut = sim.buildings.find((b) => b.kind === "hut" && b.level >= 1 && b.hp > 0)!;
  const doorA = sim.hutDoor(hut);
  const doorB = client.hutDoor(client.buildingById(hut.id)!);
  assert(Math.abs(doorA.x - doorB.x) < 1e-9 && Math.abs(doorA.z - doorB.z) < 1e-9, "hutDoor 同点");
  const plwA = sim.padLocalToWorld(campB, 1.3, -0.7);
  const plwB = client.padLocalToWorld(campB, 1.3, -0.7);
  assert(Math.abs(plwA.x - plwB.x) < 1e-9 && Math.abs(plwA.z - plwB.z) < 1e-9, "padLocalToWorld 同点");
  for (const slot of [0, 1, 3, 7]) {
    const a = sim.trainSlotPos(campB, slot);
    const b = client.trainSlotPos(client.buildingById(campB.id)!, slot);
    assert(Math.abs(a.x - b.x) < 1e-9 && Math.abs(a.z - b.z) < 1e-9, `trainSlotPos(${slot}) 同点`);
  }

  // trainQueue：排队序与 channelId 排序一致
  const qA = sim.trainQueue(campB.id).map((u) => u.id);
  const qB = client.trainQueue(campB.id).map((u) => u.id);
  assert(qA.length === qB.length && qA.every((id, i) => id === qB[i]!), `trainQueue 同序（${qA.join(",")}）`);

  // chargeState / hasCharge（镜像 teams 克隆体上懒建槽，与 sim 默认同值）
  for (const tool of ["lightning", "quake", "raise"] as const) {
    const a = sim.chargeState(BLUE, tool);
    const b = client.chargeState(BLUE, tool);
    assert(Math.abs(a.cur - b.cur) < 1e-6 && a.max === b.max && a.recharge === b.recharge, `chargeState(${tool}) 同值`);
    assert(client.hasCharge(BLUE, tool) === sim.hasCharge(BLUE, tool), `hasCharge(${tool}) 同判`);
  }

  // selectedOf / crackPoint
  assert(client.selectedOf(BLUE).length === 0, "初始无选中");
  const quake = sim.quake;
  if (quake) {
    const p1 = sim.crackPoint(quake, 0, 1.5);
    const p2 = client.crackPoint(quake, 0, 1.5);
    assert(Math.abs(p1.x - p2.x) < 1e-9 && Math.abs(p1.z - p2.z) < 1e-9, "crackPoint 同点");
  }
  // 镜像字段直通：winner/time/logs/teams/units 长度
  assert(client.winner === sim.winner && Math.abs(client.time - sim.time) < 1e-4, "winner/time 同值");
  assert(client.units.length === sim.units.length, "镜像 units 数量一致");
  console.log("testLocalQueries ok（canFound×3建筑2000+点同判 + 查询/几何/队列/充能与 sim 同值）");
}

// b) 命令化 + e) toast 回执
function testCommands(): void {
  const { client, sim, sent } = makeClientWithMirror();
  client.onMessageForTest({ t: "ready" }); // 置 ready：此后命令直发桩 worker（否则进 outbox 暂存）
  sent.length = 0;

  client.setSelection([7, 9]);
  client.setOrder(BLUE, "fight");
  client.setMagnet(BLUE, 12, 34);
  const u = sim.units.find((o) => o.team === BLUE)!;
  client.sendMove(u, 20, 21);
  client.orderMove(BLUE, 22, 23);
  const foe = sim.units.find((o) => o.team === RED)!;
  client.orderAttackTarget(BLUE, foe);
  const b0 = sim.buildings.find((x) => x.hp > 0)!;
  client.train(BLUE, "warrior");
  client.foundSite(BLUE, 30, 31, 0.5, "hut");
  client.assignBuilders(BLUE, b0);
  client.sendCast("lightning", 10, 11);
  client.sendStart();
  client.sendPaused(true);
  client.sendAiHold(true);
  client.sendSetFlag({ freezeProd: true, review: true });
  client.toast("检查：本地 toast");

  const types = sent.map((m) => m.t);
  assert(
    JSON.stringify(types) ===
      JSON.stringify([
        "select", "order", "magnet", "move", "orderMove", "attack",
        "train", "found", "assignBuilders", "cast", "start", "pause",
        "aiHold", "setFlag", "toast",
      ]),
    `命令序列 ${types.join(",")}`,
  );
  const move = sent.find((m) => m.t === "move") as Extract<MainCmd, { t: "move" }>;
  assert(move.ids.length === 1 && move.ids[0] === u.id && move.x === 20 && move.z === 21, "move 命令载荷");
  const atk = sent.find((m) => m.t === "attack") as Extract<MainCmd, { t: "attack" }>;
  assert(atk.targetId === foe.id, "attack 命令载荷");
  // toast：本地即时显示（logs/toastGen++）+ 回执 worker（防止 worker 计数不增吞掉后续 toast）
  assert(client.mirror.logs.includes("检查：本地 toast"), "toast 进镜像 logs");
  assert(client.toastGen === sim.toastGen + 1, `toastGen 本地递增（${client.toastGen}）`);
  assert(client.foundSite(BLUE, 0, 0, 0, "hut") === null, "foundSite 无返回值（worker 权威复核）");
  console.log("testCommands ok（15 条命令序列与载荷 + toast 本地显示/worker 回执）");
}

// c) 就绪状态机（init 暂存 → ready 补发；world 消息兑现 worldReady）
async function testReadyStateMachine(): Promise<void> {
  const { worker, sent } = makeStubWorker();
  const client = new WorkerSimClient(() => worker);
  const sim = new Sim(new World(7));

  client.init(1234, "hard");
  assert(sent.length === 0, "worker 未 ready：init 暂存");
  client.sendStart(); // ready 前发 start：进 outbox 暂存（防 start 先于 init 到 worker）
  assert(sent.length === 0, "worker 未 ready：start 暂存");
  client.onMessageForTest({ t: "ready" });
  assert(sent.length === 2 && sent[0]!.t === "init" && sent[1]!.t === "start", `ready 后按序补发 init→start（${sent.map((m) => m.t).join(",")}）`);
  const init = sent[0] as Extract<MainCmd, { t: "init" }>;
  assert(init.seed === 1234 && init.ai === "hard", "init 载荷（seed/ai 档位）");

  let worldResolved = false;
  void client.worldReady().then(() => {
    worldResolved = true;
  });
  client.onMessageForTest({ t: "world", ...stripTag(encodeWorld(sim.world, sim)) } as WorkerMsg);
  await Promise.resolve(); // worldReady 兑现走微任务
  assert(worldResolved, "world 消息兑现 worldReady()");
  assert(client.mirror.world.genSeed === sim.world.genSeed, "world 数据落地镜像");
  assert(client.units.length === sim.units.length, "初始实体落地镜像");
  // restart：重置 hasWorld → 重新等待下一条 world
  client.requestRestart(555);
  let restartResolved = false;
  void client.worldReady().then(() => {
    restartResolved = true;
  });
  client.onMessageForTest({ t: "snapshot", ...makeMinimalSnap() } as WorkerMsg);
  await Promise.resolve();
  assert(!restartResolved, "snapshot 不兑现 restart 的 world 等待");
  client.onMessageForTest({ t: "world", ...stripTag(encodeWorld(sim.world, sim)) } as WorkerMsg);
  await Promise.resolve();
  assert(restartResolved, "restart 后新 world 兑现等待");
  console.log("testReadyStateMachine ok（init 暂存/补发 + worldReady 生命周期 + restart 重置）");
}

// d) 导演专用写接口 warn 兜底
function testDisabledDirectors(): void {
  const { client, sim } = makeClientWithMirror();
  const b = client.buildings[0]!;
  const u = client.units[0]!;
  const warn = console.warn;
  let warns = 0;
  console.warn = () => {
    warns++;
  };
  try {
    client.addUnit(BLUE, "walker", 1, 1);
    assert(client.occupy(u, b) === false, "occupy 兜底 false");
    client.completeStep(b);
    client.placeComplete(BLUE, 1, 1, 0, "hut", 1);
    assert(client.tryPrepFound(1, 1, 0) === false, "tryPrepFound 兜底 false");
    client.markHouseBlocks();
    client.upgradeBuilding(b, 2);
    client.fillCharges(BLUE);
    client.tick(1 / 60); // no-op，不抛
  } finally {
    console.warn = warn;
  }
  assert(warns === 8, `导演专用接口逐个 warn（${warns}/8）`);
  assert(client.buildings.length === sim.buildings.length, "禁用接口不改镜像建筑集");
  console.log("testDisabledDirectors ok（8 个导演专用接口 warn 兜底、镜像不变）");
}

// —— 测试辅助：WorldMsg 带 t 标签拼装 / 最小 SnapMsg 骨架 ——
function stripTag(msg: Omit<Extract<WorkerMsg, { t: "world" }>, "t">): Omit<Extract<WorkerMsg, { t: "world" }>, "t"> {
  return msg;
}

function makeMinimalSnap(): Omit<Extract<WorkerMsg, { t: "snapshot" }>, "t"> {
  return {
    time: 0,
    winner: null,
    toastGen: 0,
    logs: [],
    armageddon: false,
    review: false,
    freezeProd: false,
    lockWin: false,
    unitF32: new Float32Array(0),
    unitU8: new Uint8Array(0),
    buildings: [],
    trees: [],
    shots: [],
    meteors: [],
    guardFires: [],
    teams: [
      { manaCap: 100, charges: {}, order: "settle", magnetX: 0, magnetZ: 0, hasShaman: true, shamanRevive: 0, wanted: [] },
      { manaCap: 100, charges: {}, order: "settle", magnetX: 0, magnetZ: 0, hasShaman: true, shamanRevive: 0, wanted: [] },
    ],
    volcano: null,
    quake: null,
    tornado: null,
    blast: null,
    blastFlyer: null,
    swampKill: false,
    swampKillX: 0,
    swampKillZ: 0,
    tornadoLift: false,
    tornadoLiftX: 0,
    tornadoLiftZ: 0,
    tornadoHouse: false,
    stuckWatch: new Map(),
    fxBolts: [],
    fxShake: 0,
    fxQuake: null,
    fxVolcano: null,
    fxSplash: [],
    pads: [],
    treeBlocks: [],
    riverTips: [],
    riverCells: [],
    lastSwampX: 0,
    lastSwampZ: 0,
    terrainDirty: false,
    terrain: null,
  };
}

async function main(): Promise<void> {
  testLocalQueries();
  testCommands();
  await testReadyStateMachine();
  testDisabledDirectors();
  console.log("worker-sim-client ok");
}

void main();
