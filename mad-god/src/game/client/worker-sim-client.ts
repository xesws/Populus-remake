// v0.29c-2 WorkerSimClient：SimClient 的 Worker 镜像实现（?worker=1 灰度开关专用，默认不启用）。
// SimClient 73 成员按三类落地：
// 1) 镜像字段（getter/setter 直通 SimMirror）：world/units/buildings/trees/shots/meteors/teams/
//    winner/time/logs/toastGen/armageddon/review/freezeProd/lockWin/fx*/swampKill*/blast*/
//    stuckWatch/volcano/quake/tornado/tornadoLift*/tornadoHouse/guardFires——数据由每 tick 的
//    snapshot 刷新，主线程照旧"读后即清"消费 fx；
// 2) 命令（postMessage 给 sim-worker，不等回执）：setOrder/setMagnet/sendMove/orderMove/
//    orderAttackTarget/train/foundSite/assignBuilders/toast + start/pause/aiHold/cast/setFlag/
//    restart/select（扩展指令见 sendXxx / setSelection）；
// 3) 本地复刻（短查询，镜像数据上直接算）：unitAt/occupantAt/buildingAt/buildingById/buildingPad/
//    nearestTree/padEdge/padLocalToWorld/hutDoor/countPop/countHouses/countKind/countWood/
//    chargeState/hasCharge/trainSlotPos/trainQueue/inSwamp/crackPoint/canFound——逻辑与 sim.ts
//    同名方法同构，但只依赖镜像（world 镜像的 heightAt/walkableAt/padReady 等纯数据方法免费用）。
// 已知限制（v0.29c 设计决定）：
// - 导演专用写接口（addUnit/occupy/completeStep/placeComplete/tryPrepFound/markHouseBlocks/
//   upgradeBuilding/fillCharges）只 warn + no-op——导演回放/作弊流在 ?worker=1 下禁用（game.ts）；
// - 选择集主线程自治：镜像 units 的 selected 本地写 + setSelection 同步给 worker；worker 侧因
//   驻扎/进屋改写的 selected 不回传（仅选中环显示细节差异，指令语义不受影响）；
// - volcano 镜像剥掉 origH、tornado 剥掉 flungIds（codec 省带宽），主线程无人读这两个字段，
//   getter 处类型断言收口。
import {
  Building,
  Cell,
  ChargeSlot,
  BuildingKind,
  dist2,
  FxBolt,
  inMap,
  Order,
  Owner,
  padSize,
  Projectile,
  sitePad,
  SKILL_CHARGE,
  Team,
  TeamState,
  Tool,
  TrainKind,
  Tree,
  Unit,
  UnitKind,
} from "../types";
import { inDoorSlit, inPad, PAD_STAND_INFLATE, padsOverlap, worldOnPad, type Pad, World } from "../world";
import { nearestLand } from "../path";
import type { Sim } from "../sim";
import { logger } from "../logger";
import { applySnapshot, applyWorld, createSimMirror, type SimMirror } from "../worker/codec";
import type { AiLevel, MainCmd, WorkerMsg } from "../worker/protocol";
import type { SimClient } from "./sim-client";

export class WorkerSimClient implements SimClient {
  readonly worker: Worker;
  readonly mirror: SimMirror = createSimMirror();

  /** 就绪状态机：worker 脚本 ready → 发 init → 收 world（对局就绪）。 */
  private workerReady = false;
  private hasWorld = false;
  private initCmd: Extract<MainCmd, { t: "init" }> | null = null;
  /** ready 前发出的命令暂存区（ready 后 init 恒先发，再按原序补发——防 start 先于 init 到 worker）。 */
  private outbox: MainCmd[] = [];
  private worldWaiters: (() => void)[] = [];

  constructor(workerFactory?: () => Worker) {
    // workerFactory：测试注入桩用（Node 无 Worker）；浏览器路径恒走默认工厂，行为不变。
    this.worker = workerFactory
      ? workerFactory()
      : new Worker(new URL("../worker/sim-worker.ts", import.meta.url), { type: "module" });
    this.worker.onmessage = (e: MessageEvent<WorkerMsg>) => this.onMsg(e.data);
    this.worker.onerror = (e) => {
      // worker 内未捕获异常走这里（脚本级错误不进 worker 的 window.error 钩子——worker 没有 window）。
      logger.error("worker", `worker 脚本异常: ${e.message}`, { src: `${e.filename}:${e.lineno}` });
    };
  }

  // -------------------------------------------------------------------------
  // 生命周期 / 消息泵
  // -------------------------------------------------------------------------

  /** 发起对局构建（Game 构造时调；worker 未 ready 则暂存，ready 后 init 恒最先补发）。 */
  init(seed: number, ai: AiLevel): void {
    this.post({ t: "init", seed, ai });
  }

  /** 重开对局（Game.restart 调）：worker 重建 World+Sim+AIDirector，回发新 world。 */
  requestRestart(seed: number, ai?: AiLevel): void {
    this.hasWorld = false;
    this.post({ t: "restart", seed, ai });
  }

  /** 等待（下一条）world 全量：初次引导与 restart 后的视图落地都靠它。 */
  worldReady(): Promise<void> {
    if (this.hasWorld) return Promise.resolve();
    return new Promise((res) => this.worldWaiters.push(res));
  }

  private onMsg(m: WorkerMsg): void {
    if (m.t === "ready") {
      this.workerReady = true;
      // ready 前积压的命令按序补发：init 恒最先（状态机约定），其余命令保持发出顺序。
      if (this.initCmd) {
        const init = this.initCmd;
        this.initCmd = null;
        this.worker.postMessage(init);
      }
      const box = this.outbox;
      this.outbox = [];
      for (const c of box) this.worker.postMessage(c);
      return;
    }
    if (m.t === "world") {
      applyWorld(this.mirror, m);
      this.hasWorld = true;
      const waiters = this.worldWaiters;
      this.worldWaiters = [];
      for (const w of waiters) w();
      return;
    }
    if (m.t === "snapshot") {
      applySnapshot(this.mirror, m);
      return;
    }
    if (m.t === "foundRes") {
      // 与本地模式 primary 的成功提示对齐；失败静默（canFound 已在本地预检，竞态失败极罕见）。
      if (m.ok) this.toast("工地已定，勇士前来搭建");
    }
  }

  /** 检查脚本专用：直接喂一条 worker 消息走消息泵（真实链路走 worker.onmessage）。 */
  onMessageForTest(m: WorkerMsg): void {
    this.onMsg(m);
  }

  /** init 特殊：无论 ready 与否都记录（ready 后恒最先发）；其余命令未 ready 时进 outbox。 */
  private post(cmd: MainCmd): void {
    if (!this.workerReady) {
      if (cmd.t === "init") this.initCmd = cmd;
      else this.outbox.push(cmd);
      return;
    }
    this.worker.postMessage(cmd);
  }

  // -------------------------------------------------------------------------
  // 扩展指令（非 SimClient 成员：game.ts 的 worker 分支专用）
  // -------------------------------------------------------------------------

  sendStart(): void {
    this.post({ t: "start" });
  }

  sendPaused(on: boolean): void {
    this.post({ t: "pause", on });
  }

  /** 导演镜头期间暂停 worker 侧 AI（isShotActive 变化沿调）。 */
  sendAiHold(on: boolean): void {
    this.post({ t: "aiHold", on });
  }

  /** 施法命令（点击施法与雕塑按住的每帧一条共用；msg 提示由 worker 侧 toast 回传）。 */
  sendCast(tool: Tool, x: number, z: number, dt?: number): void {
    this.post({ t: "cast", tool, x, z, dt });
  }

  sendSetFlag(flags: { freezeProd?: boolean; review?: boolean }): void {
    this.post({ t: "setFlag", ...flags });
  }

  /** 选择集同步：镜像 selected 本地写完后调（worker 侧 selectedOf 依赖它执行选择集指令）。 */
  setSelection(ids: number[]): void {
    this.post({ t: "select", ids });
  }

  // -------------------------------------------------------------------------
  // 镜像字段
  // -------------------------------------------------------------------------

  get world(): World {
    return this.mirror.world;
  }
  get units(): Unit[] {
    return this.mirror.units;
  }
  get buildings(): Building[] {
    return this.mirror.buildings;
  }
  get trees(): Tree[] {
    return this.mirror.trees;
  }
  get shots(): Projectile[] {
    return this.mirror.shots;
  }
  get meteors(): { x: number; z: number; y: number; vy: number; team: Team }[] {
    return this.mirror.meteors;
  }
  get teams(): [TeamState, TeamState] {
    return this.mirror.teams;
  }
  get winner(): Team | -1 | null {
    return this.mirror.winner;
  }
  get time(): number {
    return this.mirror.time;
  }
  get logs(): string[] {
    return this.mirror.logs;
  }
  get toastGen(): number {
    return this.mirror.toastGen;
  }
  get armageddon(): boolean {
    return this.mirror.armageddon;
  }
  get review(): boolean {
    return this.mirror.review;
  }
  set review(v: boolean) {
    this.mirror.review = v; // 仅镜像展示用；worker 侧权威值随快照回填（game.ts 走 sendSetFlag）
  }
  get freezeProd(): boolean {
    return this.mirror.freezeProd;
  }
  set freezeProd(v: boolean) {
    this.mirror.freezeProd = v;
  }
  get lockWin(): boolean {
    return this.mirror.lockWin;
  }

  // fx 一次性事件：game.ts/render 读后即清的语义照旧（清镜像，worker 侧在编码后已清）。
  get fxBolts(): FxBolt[] {
    return this.mirror.fxBolts;
  }
  set fxBolts(v: FxBolt[]) {
    this.mirror.fxBolts = v;
  }
  get fxShake(): number {
    return this.mirror.fxShake;
  }
  set fxShake(v: number) {
    this.mirror.fxShake = v;
  }
  get fxQuake(): { x: number; z: number } | null {
    return this.mirror.fxQuake;
  }
  set fxQuake(v: { x: number; z: number } | null) {
    this.mirror.fxQuake = v;
  }
  get fxVolcano(): { x: number; z: number } | null {
    return this.mirror.fxVolcano;
  }
  set fxVolcano(v: { x: number; z: number } | null) {
    this.mirror.fxVolcano = v;
  }
  get fxSplash(): { x: number; z: number }[] {
    return this.mirror.fxSplash;
  }
  set fxSplash(v: { x: number; z: number }[]) {
    this.mirror.fxSplash = v;
  }

  get swampKill(): boolean {
    return this.mirror.swampKill;
  }
  get swampKillX(): number {
    return this.mirror.swampKillX;
  }
  get swampKillZ(): number {
    return this.mirror.swampKillZ;
  }
  get blast(): { x: number; z: number; t: number; life: number } | null {
    return this.mirror.blast;
  }
  get blastFlyer(): { x: number; y: number; z: number } | null {
    return this.mirror.blastFlyer;
  }
  get stuckWatch(): Map<number, { x: number; z: number; t: number }> {
    return this.mirror.stuckWatch;
  }
  /** 镜像剥掉 origH（20KB Float32Array，主线程不读）——类型断言收口，见文件头注释。 */
  get volcano(): Sim["volcano"] {
    return this.mirror.volcano as unknown as Sim["volcano"];
  }
  get quake(): Sim["quake"] {
    return this.mirror.quake;
  }
  /** 镜像剥掉 flungIds（sim 内部甩飞判定集，主线程不读）。 */
  get tornado(): Sim["tornado"] {
    return this.mirror.tornado as unknown as Sim["tornado"];
  }
  get tornadoLift(): boolean {
    return this.mirror.tornadoLift;
  }
  get tornadoLiftX(): number {
    return this.mirror.tornadoLiftX;
  }
  get tornadoLiftZ(): number {
    return this.mirror.tornadoLiftZ;
  }
  get tornadoHouse(): boolean {
    return this.mirror.tornadoHouse;
  }
  get guardFires(): { x: number; z: number; team: Team }[] {
    return this.mirror.guardFires;
  }

  // -------------------------------------------------------------------------
  // 主循环 / 提示
  // -------------------------------------------------------------------------

  /** worker 自驱 60Hz tick，主线程不再驱动模拟。 */
  tick(_dt: number): void {}

  /**
   * toast 本地即时显示（镜像 logs + toastGen++），同时回执 worker 侧 sim.toast：
   * toastGen/logs 以 worker 为准——若不回执，worker 计数不增，HUD 的 toastGen 去重
   * 会在下一帧把这条本地 toast 的 gen 差值"吃掉"，吞掉 worker 后续的 toast。
   */
  toast(msg: string): void {
    this.mirror.logs.push(msg);
    if (this.mirror.logs.length > 8) this.mirror.logs.shift();
    this.mirror.toastGen++;
    this.post({ t: "toast", msg });
  }

  selectedOf(team: Team): Unit[] {
    return this.mirror.units.filter((u) => u.team === team && u.selected);
  }

  // -------------------------------------------------------------------------
  // 玩家指令（命令化）
  // -------------------------------------------------------------------------

  setOrder(team: Team, order: Order): void {
    this.post({ t: "order", order }); // 选择集在 worker 侧（setSelection 已同步）
  }

  setMagnet(team: Team, x: number, z: number): void {
    this.post({ t: "magnet", x, z });
  }

  sendMove(u: Unit, x: number, z: number): void {
    this.post({ t: "move", ids: [u.id], x, z });
  }

  orderMove(team: Team, x: number, z: number): void {
    this.post({ t: "orderMove", x, z });
  }

  orderAttackTarget(team: Team, target: Unit | Building): void {
    this.post({ t: "attack", targetId: target.id });
  }

  /** 训兵：worker 侧训练系统排队；本方法恒 true（成败提示走 worker toast 回传）。 */
  train(team: Team, kind: TrainKind): boolean {
    this.post({ t: "train", k: kind });
    return true;
  }

  // -------------------------------------------------------------------------
  // 建造
  // -------------------------------------------------------------------------

  /**
   * 放置幽灵每帧要调，必须本地判（不能走消息往返）：sim.canFound 判定逻辑在镜像数据上复刻
   * ——padReady（world 镜像纯数据方法）+ 既有建筑 pad 不重叠。worker 侧 found 命令仍权威复核。
   */
  canFound(x: number, z: number, level: number, yaw: number, ignoreId = 0, kind: BuildingKind = "hut"): boolean {
    const pad = kind === "hut" ? padSize(level) : sitePad(kind);
    if (!this.mirror.world.padReady(x, z, pad.w, pad.d, yaw)) return false;
    const mine: Pad = { x, z, w: pad.w, d: pad.d, yaw };
    for (const b of this.mirror.buildings) {
      if (b.hp <= 0 || b.id === ignoreId) continue;
      if (padsOverlap(mine, this.buildingPad(b))) return false;
    }
    return true;
  }

  /** 落基 = 发 found 命令；本地拿不到返回值（worker 权威复核），foundRes ok 时 toast 回传。 */
  foundSite(team: Team, x: number, z: number, yaw: number, kind: BuildingKind): Building | null {
    this.post({ t: "found", x, z, yaw, kind });
    return null;
  }

  /** 右键未完工工地指派建工（game.ts secondary）；found 命令的指派在 worker 侧内联完成。 */
  assignBuilders(team: Team, site: Building): void {
    this.post({ t: "assignBuilders", targetId: site.id });
  }

  // 以下导演专用写接口在 worker 模式全部禁用（game.ts 入口已拦 ?shot=，这里是兜底）。
  private disabled(name: string): void {
    console.warn(`[worker-sim-client] ${name} 仅本地模式可用：导演回放/作弊流在 ?worker=1 下已禁用（v0.29c 已知限制）`);
  }

  tryPrepFound(_x: number, _z: number, _yaw: number, _kind?: BuildingKind): boolean {
    this.disabled("tryPrepFound");
    return false;
  }

  placeComplete(
    _team: Team,
    _x: number,
    _z: number,
    _yaw: number,
    _kind: BuildingKind,
    _level: number,
    _padW?: number,
    _padD?: number,
  ): Building {
    this.disabled("placeComplete");
    return Object.create(Building.prototype) as unknown as Building;
  }

  markHouseBlocks(): void {
    this.disabled("markHouseBlocks"); // 镜像 pads/treeBlocks 由 snapshot 刷新
  }

  upgradeBuilding(_b: Building, _level: number): void {
    this.disabled("upgradeBuilding");
  }

  // -------------------------------------------------------------------------
  // 查询（本地复刻：sim.ts 同名方法的纯数据版）
  // -------------------------------------------------------------------------

  buildingAt(x: number, z: number): Building | undefined {
    return this.mirror.buildings.find((b) => b.hp > 0 && inPad(x, z, this.buildingPad(b)));
  }

  buildingById(id: number): Building | null {
    if (!id) return null;
    return this.mirror.buildings.find((b) => b.id === id && b.hp > 0) ?? null;
  }

  buildingPad(b: Building): Pad {
    return { x: b.x, z: b.z, w: b.padW, d: b.padD, yaw: b.yaw };
  }

  unitAt(x: number, z: number, r = 0.55): Unit | undefined {
    let best: Unit | undefined;
    let bestD = r * r;
    for (const u of this.mirror.units) {
      if (u.homeId > 0) continue;
      const d = dist2(u.x, u.z, x, z);
      if (d <= bestD) {
        bestD = d;
        best = u;
      }
    }
    return best;
  }

  occupantAt(x: number, z: number, r: number, team: Team): Unit | null {
    let best: Unit | null = null;
    let bestD = r * r;
    for (const u of this.mirror.units) {
      if (u.team !== team || u.homeId <= 0 || u.enterT > 0) continue;
      const d = dist2(x, z, u.x, u.z);
      if (d < bestD) {
        bestD = d;
        best = u;
      }
    }
    return best;
  }

  nearestTree(x: number, z: number): Tree | null {
    let best: Tree | null = null;
    let bestD = 1e9;
    for (const t of this.mirror.trees) {
      if (!t.alive) continue;
      const d = dist2(x, z, t.x, t.z);
      if (d < bestD) {
        bestD = d;
        best = t;
      }
    }
    return best;
  }

  padEdge(cx: number, cz: number, w: number, d: number, yaw: number, fromX: number, fromZ: number): Cell {
    const pad: Pad = { x: cx, z: cz, w, d, yaw };
    const inflate = PAD_STAND_INFLATE;
    const dx = fromX - pad.x;
    const dz = fromZ - pad.z;
    const c = Math.cos(-pad.yaw);
    const s = Math.sin(-pad.yaw);
    const l = { x: dx * c - dz * s, z: dx * s + dz * c };
    const hw = w / 2 + inflate;
    const hd = d / 2 + inflate;
    let lx = l.x;
    let lz = l.z;
    if (Math.abs(lx) < 1e-6 && Math.abs(lz) < 1e-6) {
      lz = hd;
    } else {
      const t = Math.max(Math.abs(lx) / hw, Math.abs(lz) / hd, 1e-6);
      lx /= t;
      lz /= t;
    }
    const first = worldOnPad(lx, lz, pad);
    if (this.trueRim(first.x, first.z, pad)) return first;
    const rim = this.nearestRim(pad, inflate, fromX, fromZ);
    if (rim) return rim;
    return nearestLand(this.mirror.world, first.x, first.z) ?? first;
  }

  private trueRim(x: number, z: number, pad: Pad): boolean {
    if (!this.mirror.world.walkableAt(x, z)) return false;
    if (inPad(x, z, pad) && !inDoorSlit(x, z, pad)) return false;
    return true;
  }

  private nearestRim(pad: Pad, inflate: number, fromX: number, fromZ: number): Cell | null {
    const hw = pad.w / 2 + inflate;
    const hd = pad.d / 2 + inflate;
    const step = 0.25;
    let best: Cell | null = null;
    let bestD = 1e9;
    const consider = (lx: number, lz: number) => {
      const w = worldOnPad(lx, lz, pad);
      if (!this.trueRim(w.x, w.z, pad)) return;
      const d = dist2(w.x, w.z, fromX, fromZ);
      if (d < bestD) {
        bestD = d;
        best = { x: w.x, z: w.z };
      }
    };
    for (let x = -hw; x <= hw + 1e-6; x += step) {
      consider(x, hd);
      consider(x, -hd);
    }
    for (let z = -hd; z <= hd + 1e-6; z += step) {
      consider(hw, z);
      consider(-hw, z);
    }
    return best;
  }

  padLocalToWorld(camp: Building, lx: number, lz: number): { x: number; z: number } {
    const c = Math.cos(camp.yaw);
    const s = Math.sin(camp.yaw);
    return { x: camp.x + lx * c - lz * s, z: camp.z + lx * s + lz * c };
  }

  hutDoor(b: Building): Cell {
    const pad = this.buildingPad(b);
    for (const extra of [0.55, 0.72, 0.92, 1.15, 1.4]) {
      const p = this.padLocalToWorld(b, 0, b.padD / 2 + extra);
      if (this.mirror.world.walkableAt(p.x, p.z) && !inPad(p.x, p.z, pad)) return p;
    }
    for (const side of [0.22, -0.22, 0.4, -0.4]) {
      const p = this.padLocalToWorld(b, side, b.padD / 2 + 0.7);
      if (this.mirror.world.walkableAt(p.x, p.z) && !inPad(p.x, p.z, pad)) return p;
    }
    const front = this.padLocalToWorld(b, 0, b.padD / 2 + 0.7);
    return this.padEdge(b.x, b.z, b.padW, b.padD, b.yaw, front.x, front.z);
  }

  countPop(team: Team): number {
    return this.mirror.units.filter((u) => u.team === team).length;
  }

  countHouses(team: Team): number {
    return this.mirror.buildings.filter((b) => b.team === team && b.hp > 0 && b.kind === "hut" && b.level >= 1).length;
  }

  countKind(team: Owner, kind: UnitKind): number {
    return this.mirror.units.filter((u) => u.team === team && u.kind === kind).length;
  }

  countWood(team: Team): number {
    let n = 0;
    for (const u of this.mirror.units) if (u.team === team) n += u.carry;
    for (const b of this.mirror.buildings) if (b.team === team && b.hp > 0) n += b.wood;
    return n;
  }

  /** 训练营门口站位（TrainingSystem.trainSlotPos 的镜像复刻，含贴边吸附）。 */
  trainSlotPos(camp: Building, slot: number): { x: number; z: number } {
    const inflate = 0.62;
    if (slot <= 0) {
      const doorRim = this.padLocalToWorld(camp, 0, camp.padD / 2 + inflate);
      return this.snapTrainSlot(camp, doorRim);
    }
    const hw = camp.padW / 2 + inflate;
    const hd = camp.padD / 2 + inflate;
    const segs: Array<[[number, number], [number, number]]> = [
      [[0, hd], [-hw, hd]],
      [[-hw, hd], [-hw, -hd]],
      [[-hw, -hd], [hw, -hd]],
      [[hw, -hd], [hw, hd]],
      [[hw, hd], [0, hd]],
    ];
    let remain = Math.max(0, slot) * 0.7;
    const loop = 4 * (hw + hd);
    if (loop > 0.01) remain = remain % loop;
    let lx = 0;
    let lz = hd;
    for (const [a, b] of segs) {
      const dx = b[0] - a[0];
      const dz = b[1] - a[1];
      const len = Math.hypot(dx, dz);
      if (remain <= len) {
        const t = len < 1e-6 ? 0 : remain / len;
        lx = a[0] + dx * t;
        lz = a[1] + dz * t;
        break;
      }
      remain -= len;
      lx = b[0];
      lz = b[1];
    }
    return this.snapTrainSlot(camp, this.padLocalToWorld(camp, lx, lz));
  }

  private snapTrainSlot(camp: Building, raw: { x: number; z: number }): { x: number; z: number } {
    const pad = this.buildingPad(camp);
    if (this.trueRim(raw.x, raw.z, pad)) return raw;
    const edge = this.padEdge(camp.x, camp.z, camp.padW, camp.padD, camp.yaw, raw.x, raw.z);
    if (this.trueRim(edge.x, edge.z, pad)) return edge;
    const rim = this.nearestRim(pad, 0.62, raw.x, raw.z);
    if (rim) return rim;
    return nearestLand(this.mirror.world, raw.x, raw.z) ?? edge;
  }

  /** 训练队列（TrainingSystem.trainQueue 的镜像复刻；channelId 由 v0.29c-2 codec 槽位传输）。 */
  trainQueue(campId: number): Unit[] {
    return this.mirror.units
      .filter((u) => u.job === "train" && u.targetId === campId)
      .sort((a, b) => a.channelId - b.channelId || a.id - b.id);
  }

  // -------------------------------------------------------------------------
  // 技能充能（镜像 charges 上直接读写；worker 侧权威值随快照回填）
  // -------------------------------------------------------------------------

  chargeState(team: Team, tool: Tool): ChargeSlot {
    const t = this.mirror.teams[team];
    let c = t.charges[tool];
    if (!c) {
      const spec = SKILL_CHARGE[tool];
      c = spec
        ? { cur: spec.cur, fill: 0, max: spec.max, recharge: spec.recharge, continuous: spec.continuous }
        : { cur: 0, fill: 0, max: 0, recharge: 0 };
      t.charges[tool] = c;
    }
    return c;
  }

  hasCharge(team: Team, tool: Tool): boolean {
    const c = this.chargeState(team, tool);
    return c.continuous ? c.cur >= 1e-3 : c.cur >= 1;
  }

  /** 导演专用（摆拍填槽）：worker 模式禁用——真实充能在 worker 侧，本地填了也会被快照覆盖。 */
  fillCharges(_team: Team): void {
    this.disabled("fillCharges");
  }

  // -------------------------------------------------------------------------
  // 导演专用写接口（禁用兜底）与纯查询
  // -------------------------------------------------------------------------

  addUnit(_team: Owner, _kind: UnitKind, _x: number, _z: number, _str = 1): Unit {
    this.disabled("addUnit");
    return Object.create(Unit.prototype) as unknown as Unit;
  }

  occupy(_u: Unit, _hut: Building): boolean {
    this.disabled("occupy");
    return false;
  }

  completeStep(_b: Building): void {
    this.disabled("completeStep");
  }

  inSwamp(u: Unit): boolean {
    if (!inMap(u.x, u.z)) return false;
    return this.mirror.world.swamp[this.mirror.world.sampleAt(u.x, u.z)]! > 0;
  }

  /** 地震裂缝取点（QuakeSpell.crackPoint 的纯函数复刻，只依赖 q 的坐标与角度表）。 */
  crackPoint(q: { x: number; z: number; angs: number[] }, k: number, s: number): { x: number; z: number } {
    const ang = q.angs[k]!;
    const wob = Math.sin(s * 2.1 + k * 1.3) * 0.22;
    const c = Math.cos(ang);
    const si = Math.sin(ang);
    return { x: q.x + c * s - si * wob, z: q.z + si * s + c * wob };
  }
}
