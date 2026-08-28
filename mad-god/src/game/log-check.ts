// v0.14 本地日志系统测试（针对 feature：游戏运行日志落盘 logs/game.log）。
// 覆盖：分级过滤 / periodic 周期快照 / throttled 事件合并 / 环形缓冲上限 /
// flush 批量与 sink 容错 / 生产系统埋点集成（茅屋快照、入住/出生事件、全局心跳）。
// 纯 node 可跑：MemorySink + 可注入时钟，不依赖浏览器与网络。

import { HttpSink, Logger, LogLevel, LogSink, MemorySink, logger } from "./logger";
import { Sim } from "./sim";
import { BLUE } from "./types";
import { World } from "./world";

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

interface Rig {
  lg: Logger;
  sink: MemorySink;
  clock: { v: number };
}

function makeRig(ringCap = 100): Rig {
  const sink = new MemorySink();
  const clock = { v: 1_000_000 };
  // flushAt 巨大：默认不自动 flush，由测试手动驱动，断言可控。
  const lg = new Logger(sink, ringCap, 0.5, 1_000_000, () => clock.v);
  return { lg, sink, clock };
}

function testLevelFilter(): void {
  const { lg, sink } = makeRig();
  lg.minLevel = LogLevel.Warn;
  lg.debug("t", "d");
  lg.info("t", "i");
  lg.warn("t", "w");
  lg.error("t", "e");
  lg.flush();
  assert(sink.entries.length === 2, `minLevel=Warn 时只落 warn/error（实际 ${sink.entries.length}）`);
  assert(sink.entries[0].msg === "w" && sink.entries[1].msg === "e", "保序落盘");
  console.log("testLevelFilter ok");
}

function testPeriodicSnapshot(): void {
  const { lg, sink, clock } = makeRig();
  let v = 1;
  lg.periodic("beat", 1000, LogLevel.Debug, "sim", "心跳", () => ({ v }));
  v = 2;
  lg.periodic("beat", 1000, LogLevel.Debug, "sim", "心跳", () => ({ v })); // 窗口内，丢弃
  clock.v += 500;
  lg.periodic("beat", 1000, LogLevel.Debug, "sim", "心跳", () => ({ v })); // 窗口内，丢弃
  clock.v += 600; // 距首条 1100ms，到期
  v = 3;
  lg.periodic("beat", 1000, LogLevel.Debug, "sim", "心跳", () => ({ v }));
  lg.flush();
  assert(sink.entries.length === 2, `周期快照只落到期两条（实际 ${sink.entries.length}）`);
  assert(sink.entries[0].data!.v === 1, "首条立即记录");
  assert(sink.entries[1].data!.v === 3, "到期条取当下最新值");
  console.log("testPeriodicSnapshot ok");
}

function testThrottledMerge(): void {
  const { lg, sink, clock } = makeRig();
  lg.throttled("door", 1000, LogLevel.Warn, "produce", "门口不可走");
  clock.v += 100;
  lg.throttled("door", 1000, LogLevel.Warn, "produce", "门口不可走");
  clock.v += 400;
  lg.throttled("door", 1000, LogLevel.Warn, "produce", "门口不可走");
  clock.v += 600; // 窗口到期
  lg.tick(0.016); // tick 收尾合并窗口
  lg.flush();
  assert(sink.entries.length === 2, `首条 + 合并汇总共两条（实际 ${sink.entries.length}）`);
  assert(sink.entries[0].msg === "门口不可走", "首条立即记录");
  assert(sink.entries[1].msg === "门口不可走 ×3", "窗口内重复事件合并为 ×N");
  console.log("testThrottledMerge ok");
}

function testRingCap(): void {
  const { lg, sink } = makeRig(10);
  for (let i = 0; i < 25; i++) lg.info("t", `m${i}`);
  lg.flush();
  assert(sink.entries.length === 10, `环形缓冲只留最近 10 条（实际 ${sink.entries.length}）`);
  assert(sink.entries[0].msg === "m15" && sink.entries[9].msg === "m24", "保留的是最新条目");
  console.log("testRingCap ok");
}

function testFlushBatchAndSinkFault(): void {
  const { lg } = makeRig();
  lg.info("t", "a");
  lg.info("t", "b");
  lg.flush();
  lg.info("t", "c");
  const boom: LogSink = {
    write(): void {
      throw new Error("sink down");
    },
  };
  lg.setSink(boom);
  let threw = false;
  try {
    lg.flush(); // sink 抛异常必须被吞掉，绝不影响游戏
  } catch {
    threw = true;
  }
  assert(!threw, "sink 故障不影响游戏（flush 不抛）");
  const after = new MemorySink();
  lg.setSink(after);
  lg.flush();
  assert(after.entries.length === 1 && after.entries[0].msg === "c", "故障后缓冲不丢，换 sink 可续传");
  console.log("testFlushBatchAndSinkFault ok");
}

function testProductionLogging(): void {
  const mem = new MemorySink();
  logger.setSink(mem); // 生产系统埋点用的是全局单例
  logger.clear();
  try {
    const sim = new Sim(new World(42));
    const hut = sim.buildings.find((b) => b.team === BLUE && b.kind === "hut" && b.level === 1)!;
    assert(!!hut, "初始有一座蓝方 L1 茅屋");
    const w = sim.addUnit(BLUE, "walker", hut.x + 1, hut.z + 1);
    assert(sim.occupy(w, hut), "村民入住");
    const born0 = hut.born;
    for (let i = 0; i < 600 && hut.born < born0 + 1; i++) sim.tick(0.05);
    assert(hut.born > born0, "茅屋产出一名村民");
    logger.flush();
    const es = mem.entries;
    assert(es.some((e) => e.cat === "produce" && e.msg.includes("入住")), "入住事件落日志");
    assert(es.some((e) => e.cat === "produce" && e.msg.includes("出生")), "出生事件落日志");
    assert(es.some((e) => e.cat === "produce" && e.msg.startsWith(`茅屋#${hut.id}`)), "茅屋周期快照落日志");
    assert(es.some((e) => e.cat === "sim" && e.msg === "心跳"), "全局心跳落日志");
    const born = es.find((e) => e.msg.includes("出生"))!;
    assert(typeof born.data!.pop === "number", "出生日志带 pop 数值（v0.15 起无 cap）");
  } finally {
    logger.setSink(new HttpSink()); // 还原，避免污染其他 check（node 下 HttpSink 失败会静默）
  }
  console.log("testProductionLogging ok");
}

testLevelFilter();
testPeriodicSnapshot();
testThrottledMerge();
testRingCap();
testFlushBatchAndSinkFault();
testProductionLogging();
console.log("log-check all ok");
