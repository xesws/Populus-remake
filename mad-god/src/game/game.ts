import { AIDirector, AIProfile } from "./ai";
import { SimClient } from "./client/sim-client";
import type { WorkerSimClient } from "./client/worker-sim-client";
import { bindInput, InputState, maybeStartSculpt, ndcCell, tickCamera } from "./input";
import { View } from "./render";
import { Sim } from "./sim";
import { ShotDirector } from "./shot-director";
import { canUnlock, cast } from "./spells";
import { BLUE, BuildingKind, FxBolt, inMap, isCampKind, Order, RED, snapYaw, Tool, TrainKind } from "./types";
import type { AiLevel } from "./worker/protocol";
import { HUD, showEnd } from "./ui";
import { World } from "./world";
import { logger } from "./logger";

// v0.29 固定步长：模拟以 1/60s 固定步推进，渲染等其余逻辑仍按每帧真实 dt。
const SIM_DT = 1 / 60;

export class Game {
  world: World;
  // v0.29b 主线程只依赖 SimClient 接口；本地模式赋真 Sim（结构化满足），v0.29c 换 Worker 镜像客户端。
  sim: SimClient;
  view: View;
  hud: HUD;
  // v0.29c-2 worker 模式不建 AIDirector（AI 在 worker 内由 sim-worker 驱动）；本地模式恒非空。
  aiDirector: AIDirector | null = null;
  aiProfile: AIProfile;
  shotDirector: ShotDirector;
  // v0.29c-2 ?worker=1 灰度开关（默认关闭 = 本地模式，行为与 v0.29b 完全一致）。
  readonly workerMode: boolean;
  private workerClient: WorkerSimClient | null = null;
  /** worker 模式：导演镜头 aiHold 的变化沿缓存（true=已通知 worker 暂停 AI）。 */
  private aiHeld = false;
  tool: Tool = "select";
  placeKind: BuildingKind | null = null;
  placeYaw = 0;
  paused = false;
  running = false;
  ended = false;
  pendingMagnet = false;
  bolts: FxBolt[] = [];
  input: InputState = {
    keys: new Set(),
    tool: "select",
    mx: 0,
    my: 0,
    dragging: false,
    rDragging: false,
    rotating: false,
    lastX: 0,
    lastY: 0,
    painted: false,
    holdX: 0,
    holdZ: 0,
    holding: false,
    downX: 0,
    downY: 0,
    downTime: 0,
    hitUnit: false,
    pending: false,
    boxSelecting: false,
    sculpting: false,
    placing: false,
  };
  canvas: HTMLCanvasElement;
  last = 0;
  simAcc = 0; // v0.29 固定步长累加器
  seed = 0;

  constructor(canvas: HTMLCanvasElement, workerClient?: WorkerSimClient) {
    this.canvas = canvas;
    this.seed = 1989 + ((Math.random() * 1000) | 0);
    if (workerClient) {
      // v0.29c-2 worker 灰度引导：sim 换镜像客户端，world 用镜像占位（数据未到时全 0，
      // 收到 world 消息后由 onWorkerWorldReady 重建地形）。本地模式构造路径一行未动。
      this.workerMode = true;
      this.workerClient = workerClient;
      this.world = workerClient.mirror.world;
      this.sim = workerClient;
    } else {
      this.workerMode = false;
      this.world = new World(this.seed);
      this.sim = new Sim(this.world);
      this.logWorld("开局");
    }
    this.view = new View(canvas, this.world);
    this.hud = new HUD();
    // v0.17 敌方 AI：URL ?ai=easy|normal|hard 选难度（默认 normal）；AIDirector 支持多部落 brain。
    const level =
      typeof location !== "undefined" ? new URLSearchParams(location.search).get("ai") ?? "normal" : "normal";
    this.aiProfile =
      level === "easy" ? AIProfile.easy() : level === "hard" ? AIProfile.hard() : AIProfile.normal();
    if (!this.workerMode) {
      this.aiDirector = new AIDirector([[RED, this.aiProfile]]);
      // v0.29b ai/ 本阶段未接口化：AIDirector 仍要求真 Sim；本地模式 this.sim 即真 Sim，恒真断言。
      this.aiDirector.attach(this.sim as Sim);
    } else {
      // v0.29c-2 worker 模式：AI 档位随 init 命令交给 worker（sim-worker 内建 AIDirector）。
      workerClient!.init(this.seed, level as AiLevel);
    }
    this.shotDirector = new ShotDirector(this);
    this.view.look.set(30, 0, 44); // v0.24 大地图（72 格）视角：中心偏南俯瞰双方出生带
    this.bind();
    this.view.draw(this.sim, [], 0);
    logger.info("session", "Game 构造完成", {
      seed: this.seed,
      ai: level,
      href: typeof location !== "undefined" ? location.href : "",
      ua: typeof navigator !== "undefined" ? navigator.userAgent : "",
    });
    // 运行时异常也进日志（NaN/越界之类在浏览器里只进 console，这里统一落盘）。
    window.addEventListener("error", (e) => {
      // v0.26b 补堆栈：之前只记 message+文件名，压缩构建里根本没法定位
      //（火山期 "reading '15200'" 三次崩溃都查不到位置）。
      const stack = e.error instanceof Error ? e.error.stack ?? "" : "";
      logger.error("js", e.message, { src: `${e.filename}:${e.lineno}`, stack });
    });
    window.addEventListener("unhandledrejection", (e) => {
      logger.error("js", `unhandled rejection: ${String(e.reason)}`);
    });
  }

  /**
   * v0.29c-2 worker 模式：world 全量到达后的视图落地（初次引导与每次重开共用）。
   * 镜像 world 对象恒定（applyWorld 原地换字段），重点是让 TerrainMesh 整图重建。
   */
  onWorkerWorldReady(when: "开局" | "重开"): void {
    if (!this.workerClient) return;
    this.view.world = this.workerClient.mirror.world;
    this.view.rebuildTerrain();
    this.logWorld(when);
  }

  /** v0.29c-2 选择集同步：镜像 selected 本地写完后把当前选中 id 发给 worker
   *（worker 侧 selectedOf 依赖它执行 order/train/assign 等选择集指令）。本地模式 no-op。 */
  private syncSelection(): void {
    if (!this.workerClient) return;
    this.workerClient.setSelection(this.sim.units.filter((u) => u.selected).map((u) => u.id));
  }

  bind(): void {
    bindInput(this.canvas, this.view, this.input, {
      onPrimary: (x, z) => this.primary(x, z),
      onSecondary: (x, z, sx, sy) => this.secondary(x, z, sx, sy),
      onSelect: (x, z) => this.selectAt(x, z),
      onPick: (sx, sy, cell) => this.pickAt(sx, sy, cell),
      onBoxSelect: (x0, y0, x1, y1) => this.selectBox(x0, y0, x1, y1),
      onClearSelect: () => this.clearSelect(),
      onPause: () => {
        this.togglePause();
      },
      onTool: (t) => this.setTool(t),
      onOrder: (o) => this.setOrder(o),
      onTrain: (k) => this.train(k),
      isPlacing: () => this.placeKind !== null,
      onYaw: (dir) => {
        this.placeYaw = snapYaw(this.placeYaw + dir * (Math.PI / 4));
      },
    });
    this.hud.bind(
      (t) => this.setTool(t),
      (o) => this.setOrder(o),
      (k) => this.train(k),
      (x, z) => this.view.jump(x, z),
      (k) => this.setBuild(k),
      () => {
        this.togglePause();
      },
    );
    this.hud.setTool(this.tool);
    this.hud.setBuild(null);
    this.hud.setOrder("settle");
  }

  setTool(t: Tool): void {
    this.clearPlace();
    if (t !== "select") {
      if (this.sim.armageddon) {
        this.sim.toast("末日已开，神迹封闭");
        return;
      }
      if (!canUnlock(t, this.sim.teams[BLUE].manaCap)) {
        this.sim.toast("神迹尚未解锁 — 扩建屋宇以提升法力上限");
        return;
      }
    }
    this.tool = t;
    this.input.tool = t;
    this.hud.setTool(t);
  }

  setBuild(kind: BuildingKind): void {
    const sel = this.sim.selectedOf(BLUE);
    if (!sel.length) {
      this.sim.toast("先选人");
      return;
    }
    if (!sel.some((u) => u.kind === "walker")) {
      this.sim.toast("选勇士去盖");
      return;
    }
    this.tool = "select";
    this.input.tool = "select";
    this.input.placing = true;
    this.hud.setTool("select");
    this.placeKind = kind;
    this.placeYaw = 0;
    this.pendingMagnet = false;
    this.input.placing = true;
    this.hud.setBuild(kind);
    const names: Record<string, string> = {
      hut: "茅屋",
      warriorHut: "武士营",
      temple: "神庙",
      fireHut: "火战士营",
      spyHut: "间谍营",
      tower: "哨塔",
      rebirth: "重生",
    };
    this.sim.toast(`建造：${names[kind] ?? kind}`);
  }

  clearPlace(): void {
    this.placeKind = null;
    this.input.placing = false;
    this.view.hideGhost();
    this.hud.setBuild(null);
  }

  cancelMode(): void {
    if (this.placeKind || this.pendingMagnet || this.tool !== "select") {
      this.tool = "select";
      this.input.tool = "select";
      this.hud.setTool("select");
      this.pendingMagnet = false;
      this.clearPlace();
      return;
    }
    this.clearSelect();
  }

  setOrder(o: Order): void {
    const n = this.sim.selectedOf(BLUE).length;
    if (!n) {
      this.sim.toast("先选人");
      return;
    }
    this.sim.setOrder(BLUE, o);
    this.hud.setOrder(o);
    const label: Record<Order, string> = {
      settle: "谕令：去砍树 / 空闲",
      gather: "谕令：向标记聚集（再点击地图放置标记）",
      fight: "谕令：出击",
      shaman: "谕令：到祭司身边集合",
      guard: "谕令：围篝火守卫休整（跳舞回血，遇敌自动迎战）",
    };
    this.sim.toast(label[o]);
    if (o === "gather") {
      this.pendingMagnet = true;
      this.clearPlace();
    }
  }

  train(k: TrainKind): void {
    this.clearPlace();
    this.sim.train(BLUE, k);
  }

  primary(x: number, z: number): void {
    if (!this.running || this.ended) return;
    if (this.pendingMagnet) {
      this.sim.setMagnet(BLUE, x, z);
      this.pendingMagnet = false;
      this.sim.toast("聚集标记已落下");
      return;
    }
    if (this.placeKind) {
      if (!this.sim.canFound(x, z, 1, this.placeYaw, 0, this.placeKind ?? "hut")) return;
      const made = this.sim.foundSite(BLUE, x, z, this.placeYaw, this.placeKind);
      if (made) {
        this.sim.assignBuilders(BLUE, made);
        this.sim.toast("工地已定，勇士前来搭建");
        this.shotDirector.onBuildingFound(made);
      }
      return;
    }
    if (this.tool === "select") {
      this.clearSelect();
      return;
    }
    if (this.tool === "raise" || this.tool === "lower") return;
    if (this.sim.armageddon) {
      this.sim.toast("末日已开，神迹封闭");
      return;
    }
    if (this.workerClient) {
      // v0.29c-2 法术点击：改发 cast 命令（r.msg 主线程拿不到——失败/提示由 worker 侧
      // toast 回传快照 logs），本地不再重复提示。
      this.workerClient.sendCast(this.tool, x, z);
      return;
    }
    const r = cast(this.sim, BLUE, this.tool, x, z);
    if (r.msg) this.sim.toast(r.msg);
  }

  secondary(x: number, z: number, sx = -9999, sy = -9999): void {
    if (this.placeKind) {
      this.clearPlace();
      return;
    }
    if (this.pendingMagnet) {
      this.pendingMagnet = false;
      return;
    }
    if (this.tool !== "select") {
      this.setTool("select");
      return;
    }
    if (!this.running || this.ended) return;
    const selected = this.sim.selectedOf(BLUE);
    if (!selected.length) return;
    const cell = inMap(x, z) ? { x, z } : null;
    const foe = this.closestRed(sx, sy, cell);
    if (foe) {
      this.sim.orderAttackTarget(BLUE, foe);
      return;
    }
    const b = cell ? this.sim.buildingAt(cell.x, cell.z) : undefined;
    if (b && b.team === RED && b.hp > 0 && b.level >= 1) {
      this.sim.orderAttackTarget(BLUE, b);
      return;
    }
    if (b && b.team === BLUE && b.hp > 0) {
      if (b.level === 0) {
        this.sim.assignBuilders(BLUE, b);
        this.view.showMoveMark(b.x, b.z);
        return;
      }
      if (b.kind === "hut" || isCampKind(b.kind) || b.kind === "tower") {
        // v0.28e 修游戏内实锤断链：哨塔此前落不进 orderMove，右键只会让牛战士走到塔边傻站
        //（检查脚本直调 sim.orderMove 测不到这层）。塔的进/出驻扎分支在 sim.orderMove 内。
        this.sim.orderMove(BLUE, b.x, b.z);
        return;
      }
    }
    if (!cell) return;
    for (const u of selected) {
      u.atkId = 0;
      this.sim.sendMove(u, x, z);
    }
    this.view.showMoveMark(x, z);
  }

  pickLabel(kind: string): string {
    const pick: Record<string, string> = {
      shaman: "选中祭司",
      warrior: "选中武士",
      preacher: "选中传教士",
      firewarrior: "选中火战士",
      spy: "选中间谍",
      walker: "选中勇士",
    };
    return pick[kind] ?? "选中子民";
  }

  closestRed(sx: number, sy: number, cell: { x: number; z: number } | null) {
    let best = undefined as (typeof this.sim.units)[number] | undefined;
    let bestD = 28 * 28;
    for (const u of this.sim.units) {
      if (u.team !== RED || u.homeId > 0 || u.hp <= 0) continue;
      const p = this.view.worldToCanvas(u.x, u.y + 0.28, u.z, this.canvas);
      const d = (p.x - sx) * (p.x - sx) + (p.y - sy) * (p.y - sy);
      if (d <= bestD) {
        bestD = d;
        best = u;
      }
    }
    if (best) return best;
    if (cell) {
      const u = this.sim.unitAt(cell.x, cell.z, 0.7);
      if (u && u.team === RED && u.hp > 0 && u.homeId === 0) return u;
    }
    return undefined;
  }

  closestBlue(sx: number, sy: number, cell: { x: number; z: number } | null) {
    let best = undefined as (typeof this.sim.units)[number] | undefined;
    let bestD = 28 * 28;
    for (const u of this.sim.units) {
      // v0.27h 屋顶村民/塔上牛战士可点选（坐标已在建筑上，屏幕投影正确）；
      // 进屋动画中（enterT>0）的不选。
      if (u.team !== BLUE || u.enterT > 0) continue;
      const p = this.view.worldToCanvas(u.x, u.y + 0.28, u.z, this.canvas);
      const d = (p.x - sx) * (p.x - sx) + (p.y - sy) * (p.y - sy);
      if (d <= bestD) {
        bestD = d;
        best = u;
      }
    }
    if (best) return best;
    if (cell) {
      const u = this.sim.unitAt(cell.x, cell.z, 1.05);
      if (u && u.team === BLUE) return u;
    }
    return undefined;
  }

  pickAt(sx: number, sy: number, cell: { x: number; z: number } | null): boolean {
    if (cell) {
      const hasSel = this.sim.units.some((o) => o.team === BLUE && o.selected);
      if (hasSel) {
        const b = this.sim.buildingAt(cell.x, cell.z);
        if (
          b &&
          b.team === BLUE &&
          b.hp > 0 &&
          b.level >= 1 &&
          (b.kind === "hut" || isCampKind(b.kind))
        ) {
          return false;
        }
      }
    }
    const u = this.closestBlue(sx, sy, cell);
    if (!u) return false;
    for (const o of this.sim.units) o.selected = false;
    u.selected = true;
    this.syncSelection();
    this.sim.toast(this.pickLabel(u.kind));
    return true;
  }

  selectBox(x0: number, y0: number, x1: number, y1: number): void {
    const minX = Math.min(x0, x1);
    const maxX = Math.max(x0, x1);
    const minY = Math.min(y0, y1);
    const maxY = Math.max(y0, y1);
    for (const u of this.sim.units) u.selected = false;
    let n = 0;
    let last = undefined as (typeof this.sim.units)[number] | undefined;
    for (const u of this.sim.units) {
      if (u.team !== BLUE || u.homeId > 0) continue;
      const p = this.view.worldToCanvas(u.x, u.y + 0.12, u.z, this.canvas);
      if (p.x >= minX && p.x <= maxX && p.y >= minY && p.y <= maxY) {
        u.selected = true;
        n++;
        last = u;
      }
    }
    if (n === 1 && last) this.sim.toast(this.pickLabel(last.kind));
    else if (n > 1) this.sim.toast(`选中 ${n} 人`);
    this.syncSelection();
  }

  clearSelect(): void {
    for (const u of this.sim.units) u.selected = false;
    this.syncSelection();
  }

  selectAt(x: number, z: number): void {
    for (const u of this.sim.units) u.selected = false;
    // v0.27h 地面拾取兜底：点在茅屋/哨塔上时优先选中驻扎者（屋顶站位坐标）。
    const occ = this.sim.occupantAt(x, z, 0.9, BLUE);
    if (occ) {
      occ.selected = true;
      this.syncSelection();
      this.sim.toast(this.pickLabel(occ.kind));
      return;
    }
    const u = this.sim.unitAt(x, z, 0.8);
    if (u && u.team === BLUE) {
      u.selected = true;
      this.syncSelection();
      this.sim.toast(this.pickLabel(u.kind));
    } else {
      this.syncSelection();
    }
  }

  start(): void {
    if (this.running) return;
    // v0.29c-2 worker 模式禁用导演回放：shot-director 直写 sim 内部（u.path/.job/.think、
    // placeComplete/addUnit 等作弊流）过不了消息边界——入口处拦下并提示。本地模式不受影响。
    if (this.workerMode) {
      if (typeof location !== "undefined" && location.search.includes("shot=")) {
        this.sim.toast("导演回放仅本地模式（?worker=1 不支持 ?shot=）");
      }
    } else {
      this.shotDirector.handleUrlParams();
    }
    this.running = true;
    this.workerClient?.sendStart(); // worker 自驱循环开跑（本地模式无客户端，no-op）
    logger.info("session", "对局开始", { seed: this.seed });
    this.last = performance.now();
    requestAnimationFrame((t) => this.frame(t));
  }

  /**
   * v0.24 把本局地图的身份写进日志系统（seed / 地貌模板 / 出生点 / 强制平滑的改动量）。
   * 手测时一句「这图怎么这么挤」就能靠日志定位到底是哪张模板、平滑器改了多少格。
   */
  private logWorld(when: string): void {
    const w = this.world;
    const r = w.smoothReport;
    logger.info(
      "world",
      `${when}：seed=${w.genSeed} 地貌=${w.templateId}(${w.templateName}) 出生点=(${w.starts[0].x.toFixed(0)},${w.starts[0].z.toFixed(0)})↔(${w.starts[1].x.toFixed(0)},${w.starts[1].z.toFixed(0)}) 平滑=填缺${r ? r.filled : 0}/削刺${r ? r.pruned : 0}/尖峰${r ? r.spikes : 0}`,
    );
  }

  restart(): void {
    if (this.workerClient) {
      // v0.29c-2 worker 模式重开：命令 worker 重建对局（新 world 到达后重建视图），
      // 不再跑本地 new World/Sim/AIDirector 与 applyReviewCheats（导演流已禁用）。
      // 消息序 FIFO：restart → world 回发 → start，worker 侧顺序处理，无竞态。
      this.seed = 1989 + ((Math.random() * 9999) | 0);
      this.workerClient.requestRestart(this.seed);
      void this.workerClient.worldReady().then(() => this.onWorkerWorldReady("重开"));
      this.view.resetFx();
      this.ended = false;
      this.paused = false;
      this.workerClient.sendStart();
      this.tool = "select";
      this.input.tool = "select";
      this.input.holding = false;
      this.input.sculpting = false;
      this.input.rDragging = false;
      this.pendingMagnet = false;
      this.placeKind = null;
      this.placeYaw = 0;
      this.input.placing = false;
      this.view.hideGhost();
      this.hud.setTool(this.tool);
      this.hud.setBuild(null);
      this.hud.setOrder("settle");
      this.bolts = [];
      document.getElementById("end")!.hidden = true;
      logger.info("session", "重开对局", { seed: this.seed, mode: "worker" });
      return;
    }
    this.seed = 1989 + ((Math.random() * 9999) | 0);
    this.world = new World(this.seed);
    this.sim = new Sim(this.world);
    this.logWorld("重开");
    this.view.world = this.world;
    this.view.resetFx();
    this.view.rebuildTerrain();
    this.view.look.set(30, 0, 44); // v0.24 大地图（72 格）视角：中心偏南俯瞰双方出生带
    this.aiDirector = new AIDirector([[RED, this.aiProfile]]);
    this.aiDirector.attach(this.sim as Sim); // v0.29b 同构造函数：ai/ 未接口化，见上
    this.shotDirector.reset();
    this.ended = false;
    this.paused = false;
    this.tool = "select";
    this.input.tool = "select";
    this.input.holding = false;
    this.input.sculpting = false;
    this.input.rDragging = false;
    this.pendingMagnet = false;
    this.placeKind = null;
    this.placeYaw = 0;
    this.input.placing = false;
    this.view.hideGhost();
    this.hud.setTool(this.tool);
    this.hud.setBuild(null);
    this.hud.setOrder("settle");
    this.bolts = [];
    document.getElementById("end")!.hidden = true;
    this.shotDirector.applyReviewCheats();
    logger.info("session", "重开对局", { seed: this.seed });
  }

  togglePause(): void {
    this.paused = !this.paused;
    this.workerClient?.sendPaused(this.paused); // v0.29c-2：worker 侧循环暂停/恢复
    if (this.paused) return;
    this.shotDirector.shotHeld = true;
    if (this.workerClient) {
      // v0.29c-2：freezeProd/review 直写改为命令（镜像字段由快照回填，本地写会被覆盖）。
      this.workerClient.sendSetFlag({ freezeProd: false, review: false });
      return;
    }
    this.sim.freezeProd = false;
    this.sim.review = false;
  }

  frame(now: number): void {
    const dt = Math.min(0.05, (now - this.last) / 1000);
    this.last = now;
    logger.tick(dt);
    tickCamera(this.view, this.input.keys, dt);

    const cell = ndcCell({ clientX: this.input.mx, clientY: this.input.my }, this.canvas, this.view);
    if (this.placeKind && cell && inMap(cell.x, cell.z)) {
      const legal = this.sim.canFound(cell.x, cell.z, 1, this.placeYaw, 0, this.placeKind ?? "hut");
      this.view.showGhost(this.placeKind, BLUE, cell.x, cell.z, this.placeYaw, legal);
      this.view.hover(0, 0, false);
    } else {
      this.view.hideGhost();
      if (this.paused) {
        if (this.shotDirector.fightHoverMode === "fight") {
          this.view.hover(this.shotDirector.fightHoverX, this.shotDirector.fightHoverZ, true, "fight");
        } else {
          this.view.hover(0, 0, false);
        }
      } else if (cell && inMap(cell.x, cell.z)) {
        const hasSel = this.sim.selectedOf(BLUE).length > 0;
        if (this.tool === "select" && hasSel) {
          const foe = this.closestRed(this.input.mx, this.input.my, cell);
          const eb = this.sim.buildingAt(cell.x, cell.z);
          if (foe) this.view.hover(foe.x, foe.z, true, "fight");
          else if (eb && eb.team === RED && eb.hp > 0 && eb.level >= 1) this.view.hover(eb.x, eb.z, true, "fight");
          else this.view.hover(cell.x, cell.z, true, "move");
        } else if (this.tool !== "select") {
          // 法术/雕刻工具：光标即落点指示，照常显示。
          this.view.hover(cell.x, cell.z, true, "move");
        } else {
          // v0.28g 修复：select 工具下**没有任何选中单位**时不显示光标——
          // 旧实现这里无条件亮"移动光标"，点空地取消选择后光标仍跟着鼠标跑，
          // 玩家分不清到底有没有选中人。
          this.view.hover(0, 0, false);
        }
      } else this.view.hover(0, 0, false);
    }

    // v0.18 雕刻指示器：选中 raise/lower 且鼠标在图内时，半透明脉动选框实时显示 3.0 格生效范围。
    if ((this.tool === "raise" || this.tool === "lower") && cell && inMap(cell.x, cell.z)) {
      this.view.updateSculptIndicator(this.tool, cell.x, cell.z, dt);
    } else {
      this.view.updateSculptIndicator("off", 0, 0, dt);
    }

    // v0.26 转化范围圈：选中 convert 且鼠标在图内时显示；距己方存活大祭司超 4 格或大祭司陨落则红灰。
    if (this.tool === "convert" && cell && inMap(cell.x, cell.z)) {
      const sh = this.sim.units.find((u) => u.team === 0 && u.kind === "shaman" && u.hp > 0);
      const ok = !!sh && Math.hypot(sh.x - cell.x, sh.z - cell.z) <= 4;
      this.view.updateConvertIndicator("cast", ok, cell.x, cell.z, dt);
    } else {
      this.view.updateConvertIndicator("off", false, 0, 0, dt);
    }

    maybeStartSculpt(this.input);
    if (this.running && !this.paused && !this.ended) {
      if (
        this.input.holding &&
        this.input.sculpting &&
        !this.input.rDragging &&
        !this.input.boxSelecting &&
        !this.input.hitUnit &&
        (this.tool === "raise" || this.tool === "lower")
      ) {
        const hx = cell?.x ?? this.input.holdX;
        const hz = cell?.z ?? this.input.holdZ;
        if (inMap(hx, hz)) {
          if (this.workerClient) {
            // v0.29c-2 雕塑按住施法：每帧发一条 cast（dt=真实帧长），worker 直调 spells.cast；
            // r.msg 本地拿不到——提示由 worker 侧 toast 回传快照 logs。
            this.workerClient.sendCast(this.tool, hx, hz, dt);
          } else {
            const r = cast(this.sim, BLUE, this.tool, hx, hz, dt);
            if (r.msg && r.msg !== "") this.sim.toast(r.msg);
          }
        }
      }
      if (this.workerClient) {
        // v0.29c-2 worker 自驱：主线程不跑 sim.tick 子步循环与 aiDirector；
        // 导演镜头沿变化沿同步 aiHold（true=worker 暂停 AI；导演已禁用故恒 false，留作 C3 接口）。
        const held = this.shotDirector.isShotActive();
        if (held !== this.aiHeld) {
          this.aiHeld = held;
          this.workerClient.sendAiHold(held);
        }
      } else {
        // v0.29 固定步长：sim.tick / aiDirector.update 按 1/60s 子步推进，每帧最多 3 步；
        // 超出 3 步的余量直接丢弃（simAcc 封顶），防止低帧率下积压螺旋。
        this.simAcc = Math.min(this.simAcc + dt, SIM_DT * 3);
        let steps = 0;
        while (this.simAcc >= SIM_DT && steps < 3) {
          this.sim.tick(SIM_DT);
          if (!this.shotDirector.isShotActive()) this.aiDirector!.update(this.sim as Sim, SIM_DT);
          this.simAcc -= SIM_DT;
          steps++;
        }
      }
      for (const b of this.bolts) b.life -= dt;
      this.bolts = this.bolts.filter((b) => b.life > 0);
      if (this.sim.winner !== null) {
        this.ended = true;
        showEnd(this.sim.winner === BLUE, this.sim.winner === -1);
      }
      this.shotDirector.checkFrameHold(this.bolts);
    }
    if (this.sim.fxBolts.length) {
      this.bolts.push(...this.sim.fxBolts);
      this.sim.fxBolts = [];
    }
    this.view.shake = Math.max(this.view.shake, this.sim.fxShake);
    this.sim.fxShake = 0;
    this.shotDirector.postRender();
    this.hud.sync(this.sim, this.tool, this.paused, dt);
    this.view.draw(this.sim, this.bolts, dt, this.paused);
    requestAnimationFrame((t) => this.frame(t));
  }
}

export { RED };
