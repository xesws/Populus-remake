// v0.29c-1 Sim Worker 入口（薄）。
// ⚠ 此文件只跑在 Worker 线程：禁止 import three.js / DOM——只允许 import
//   sim/world/ai/spells/types（纯模拟侧）与 ./protocol、./codec（纯类型/纯函数）。
// 职责：
// - 收 MainCmd：init/start/pause/restart/select/... 直接调真 Sim 对应方法
//   （AIDirector 在 init/restart 里建，AIProfile 按难度档）；不认识的消息忽略；
// - 自驱固定步长循环：start 后按 performance.now 累加器跑 60Hz sim.tick(1/60)，
//   每 real-time 窗口最多 3 步、落后丢步（与 game.ts 本地模式 simAcc 封顶同语义），
//   每步 postMessage(encodeSnapshot(sim))，typed arrays 走 transfer list；
// - aiHold=true 时 tick 照跑但跳过 aiDirector.update（对应主线程 isShotActive 门）。
// 消息时序：脚本加载即回 {t:"ready"}；init/restart 完成后回 world 消息（主线程以收到
// world 消息为"对局就绪"）；found 命令回 foundRes（foundSite 成败在 worker 侧才知道）。
import { Sim } from "../sim";
import { World } from "../world";
import { AIDirector, AIProfile } from "../ai";
import { cast } from "../spells";
import { BLUE, RED, Tool } from "../types";
import { logger } from "../logger";
import { encodeSnapshot, encodeWorld, terrainTouched, transferOf } from "./codec";
import type { AiLevel, MainCmd, WorkerMsg, WorldMsg, SnapMsg } from "./protocol";

const SIM_DT = 1 / 60;
/** 地形系活动（火山/地震/雕塑/沼泽）结束后仍继续传地形全量的秒数：岩浆冷却约 5~10s，留足余量。 */
const TERRAIN_TAIL_SEC = 12;

let sim: Sim | null = null;
let aiDirector: AIDirector | null = null;
let aiLevel: AiLevel = "normal";
let running = false;
let paused = true;
let aiHold = false;
let lastMs = 0;
let acc = 0;
let loopTimer: ReturnType<typeof setTimeout> | null = null;
/** 最近一次 cast 命令的工具（terrainTouched 的输入，快照编码后清空）。 */
let lastCastTool: Tool | null = null;
/** 地形尾部计数（tick 数）：激活期结束后继续传 TERRAIN_TAIL_SEC 秒，等岩浆干涸/焦土收尾。 */
let terrainTailTicks = 0;

// Worker 上下文最小视图（不引 DOM/WebWorker lib，直接断言本作用域能力）。
const ctx = self as unknown as {
  postMessage(m: WorkerMsg, transfer?: Transferable[]): void;
  addEventListener(type: "message", cb: (e: MessageEvent) => void): void;
};

function post(msg: WorkerMsg): void {
  // 只有 world/snapshot 携带 typed arrays；ready/foundRes 的 transfer list 为空。
  ctx.postMessage(msg, transferOf(msg as WorldMsg | SnapMsg));
}

/** 建/重建对局：World+Sim+AIDirector，回发 world 全量（主线程以收到 world 消息为对局就绪）。 */
function buildSession(seed: number, level: AiLevel): void {
  aiLevel = level;
  const world = new World(seed);
  sim = new Sim(world);
  const profile = level === "easy" ? AIProfile.easy() : level === "hard" ? AIProfile.hard() : AIProfile.normal();
  aiDirector = new AIDirector([[RED, profile]]);
  aiDirector.attach(sim);
  running = false;
  paused = true;
  aiHold = false;
  acc = 0;
  lastCastTool = null;
  terrainTailTicks = 0;
  if (loopTimer !== null) {
    clearTimeout(loopTimer);
    loopTimer = null;
  }
  post(encodeWorld(world, sim));
  logger.info("worker", "对局已构建", { seed, ai: level });
}

/** 处理一条主线程命令；sim 未就绪时除 init/restart 外一律忽略。 */
function handle(cmd: MainCmd): void {
  switch (cmd.t) {
    case "init":
      buildSession(cmd.seed, cmd.ai);
      return;
    case "restart":
      buildSession(cmd.seed, cmd.ai ?? aiLevel);
      return;
    case "start":
      running = true;
      paused = false;
      lastMs = performance.now();
      acc = 0;
      if (loopTimer === null) loopTimer = setTimeout(stepLoop, 4);
      return;
    case "pause":
      paused = cmd.on;
      return;
    case "aiHold":
      aiHold = cmd.on;
      return;
    case "select": {
      if (!sim) return;
      const ids = new Set(cmd.ids);
      for (const u of sim.units) u.selected = ids.has(u.id);
      return;
    }
    case "order":
      sim?.setOrder(BLUE, cmd.order);
      return;
    case "magnet":
      sim?.setMagnet(BLUE, cmd.x, cmd.z);
      return;
    case "train":
      sim?.train(BLUE, cmd.k);
      return;
    case "move": {
      if (!sim) return;
      // = game.ts secondary 末尾的右键空地循环：清 atkId 后逐个 sendMove。
      for (const id of cmd.ids) {
        const u = sim.units.find((o) => o.id === id);
        if (!u) continue;
        u.atkId = 0;
        sim.sendMove(u, cmd.x, cmd.z);
      }
      return;
    }
    case "orderMove":
      sim?.orderMove(BLUE, cmd.x, cmd.z);
      return;
    case "attack": {
      if (!sim) return;
      const tu = sim.unitById(cmd.targetId);
      const tb = tu ? null : sim.buildingById(cmd.targetId);
      const target = tu ?? tb;
      if (target) sim.orderAttackTarget(BLUE, target);
      return;
    }
    case "found": {
      if (!sim) return;
      const made = sim.foundSite(BLUE, cmd.x, cmd.z, cmd.yaw, cmd.kind);
      if (made) sim.assignBuilders(BLUE, made);
      post({ t: "foundRes", ok: made !== null, id: made?.id ?? 0 });
      return;
    }
    case "cast": {
      if (!sim) return;
      lastCastTool = cmd.tool;
      // 雕塑流式施法与本地模式同构：主线程每帧发一条 cast（dt=帧长），worker 直调 spells.cast。
      const r = cast(sim, BLUE, cmd.tool, cmd.x, cmd.z, cmd.dt ?? 0.2);
      if (r.msg) sim.toast(r.msg);
      return;
    }
    case "setFlag":
      if (!sim) return;
      if (cmd.freezeProd !== undefined) sim.freezeProd = cmd.freezeProd;
      if (cmd.review !== undefined) sim.review = cmd.review;
      return;
    // v0.29c-2 镜像客户端的本地 toast 回执：worker 侧同步入 logs/toastGen（计数以 worker 为准）。
    case "toast":
      sim?.toast(cmd.msg);
      return;
    // v0.29c-2 右键自家未完工工地：对 worker 侧同 id 建筑指派建工（目标消失/已完工则忽略）。
    case "assignBuilders": {
      if (!sim) return;
      const b = sim.buildingById(cmd.targetId);
      if (b) sim.assignBuilders(BLUE, b);
      return;
    }
  }
}

/** 自驱循环：累加器固定步长，每窗口最多 3 步，落后丢步；每步回发一份 snapshot。 */
function stepLoop(): void {
  loopTimer = null;
  if (!running) return;
  const now = performance.now();
  if (!paused && sim) {
    acc = Math.min(acc + (now - lastMs) / 1000, SIM_DT * 3);
    let steps = 0;
    while (acc >= SIM_DT && steps < 3) {
      sim.tick(SIM_DT);
      if (aiDirector && !aiHold) aiDirector.update(sim, SIM_DT);
      // 地形置脏 = 纯判定（激活期/地形系 cast）∪ 尾部计数（等岩浆干涸）。
      const dirty = terrainTouched(sim, lastCastTool) || terrainTailTicks > 0;
      terrainTailTicks = dirty ? Math.ceil(TERRAIN_TAIL_SEC / SIM_DT) : Math.max(0, terrainTailTicks - 1);
      post(encodeSnapshot(sim, dirty));
      // fx 一次性事件随快照带走了：本地模式下 game.ts/render 也在读后即清，语义相同。
      sim.fxBolts.length = 0;
      sim.fxSplash.length = 0;
      sim.fxShake = 0;
      sim.fxQuake = null;
      sim.fxVolcano = null;
      acc -= SIM_DT;
      steps++;
    }
    lastCastTool = null;
  }
  // v0.29c-2 worker 侧日志节拍：驱动周期快照与批量上报（logger 修复后 worker 也有 fetch 上报
  // 通道；主线程的 logger.tick 在 frame() 里，worker 需自驱动）。
  logger.tick(Math.min(0.05, (now - lastMs) / 1000));
  lastMs = now;
  loopTimer = setTimeout(stepLoop, 4);
}

ctx.addEventListener("message", (e: MessageEvent) => {
  handle(e.data as MainCmd);
});

// 脚本加载即报就绪（主线程收到后发 init）。
post({ t: "ready" });
