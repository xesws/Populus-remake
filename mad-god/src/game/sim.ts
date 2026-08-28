import { astar, nearestLand } from "./path";
import { createBuilding, createTree, createUnit } from "./entities";
import {
  Ankh,
  BLUE,
  Building,
  BuildingKind,
  CAMP_FOR,
  Cell,
  CHOP_TIME,
  clamp,
  dist2,
  FxBolt,
  houseHp,
  houseMaxPop,
  inMap,
  isCampKind,
  isTribe,
  NEUTRAL,
  Order,
  Owner,
  padSize,
  Projectile,
  RED,
  snapYaw,
  Team,
  TeamState,
  TRAIN_FOR_CAMP,
  TrainKind,
  TREE_REGEN,
  Tree,
  Unit,
  UnitKind,
  WATER,
  woodNeedFor,
  WORLD,
} from "./types";
import { inDoorSlit, inPad, Pad, padsOverlap, worldOnPad, World } from "./world";
import {
  CombatSystem,
  HazardSystem,
  MergeSystem,
  PathSystem,
  ProductionSystem,
  TrainingSystem,
  WinSystem,
} from "./systems";
import {
  BlastSpell,
  LightningSpell,
  QuakeSpell,
  TornadoSpell,
  VolcanoSpell,
} from "./spells";

let NEXT = 1;
function nid(): number {
  return NEXT++;
}

export class Sim {
  world: World;
  units: Unit[] = [];
  buildings: Building[] = [];
  trees: Tree[] = [];
  shots: Projectile[] = [];
  ankhs: Ankh[] = [];
  teams: [TeamState, TeamState];
  winner: Team | -1 | null = null;
  time = 0;
  logs: string[] = [];
  toastGen = 0;
  armageddon = false;
  review = false;
  freezeMerge = false;
  freezeProd = false;
  lockWin = false;
  fxBolts: FxBolt[] = [];
  fxShake = 0;
  fxQuake: { x: number; z: number } | null = null;
  fxVolcano: { x: number; z: number } | null = null;
  volcano: { x: number; z: number; t: number; dur: number } | null = null;
  fxSplash: { x: number; z: number }[] = [];
  lavaHurt = false;
  trainJoinN = 1;
  swampKill = false;
  swampKillX = 0;
  swampKillZ = 0;
  quake: {
    x: number;
    z: number;
    t: number;
    dur: number;
    angs: number[];
    lens: number[];
    opened: number[];
  } | null = null;
  quakeKill = false;
  quakeKillX = 0;
  quakeKillZ = 0;
  quakeHutDown = false;
  tornado: {
    x: number;
    z: number;
    vx: number;
    vz: number;
    t: number;
    life: number;
    houseT: number;
  } | null = null;
  tornadoLift = false;
  tornadoLiftX = 0;
  tornadoLiftZ = 0;
  tornadoHouse = false;
  lightningHit = false;
  lightningHitX = 0;
  lightningHitZ = 0;
  lightningHouse = false;
  blast: { x: number; z: number; t: number; life: number } | null = null;
  blastHit = false;
  blastHitX = 0;
  blastHitZ = 0;
  blastFlyer: { x: number; y: number; z: number } | null = null;
  stuckWatch = new Map<number, { x: number; z: number; t: number }>();

  readonly productionSystem = new ProductionSystem();
  readonly trainingSystem = new TrainingSystem();
  readonly pathSystem = new PathSystem();
  readonly combatSystem = new CombatSystem();
  readonly hazardSystem = new HazardSystem();
  readonly mergeSystem = new MergeSystem();
  readonly winSystem = new WinSystem();
  readonly blastSpell = new BlastSpell();
  readonly lightningSpell = new LightningSpell();
  readonly quakeSpell = new QuakeSpell();
  readonly tornadoSpell = new TornadoSpell();
  readonly volcanoSpell = new VolcanoSpell();

  constructor(world: World) {
    this.world = world;
    const b = world.startPad(BLUE);
    const r = world.startPad(RED);
    this.teams = [
      { mana: 70, manaCap: 100, order: "settle", magnetX: b.x, magnetZ: b.z, hasShaman: true, shamanRevive: 0, wanted: [] },
      { mana: 70, manaCap: 100, order: "settle", magnetX: r.x, magnetZ: r.z, hasShaman: true, shamanRevive: 0, wanted: [] },
    ];
    this.seed();
  }

  seed(): void {
    this.placeStart(BLUE);
    this.placeStart(RED);
    this.seedWildmen();
    this.seedTrees();
    this.markHouseBlocks();
  }

  placeStart(team: Team): void {
    const s = this.world.startPad(team);
    const rebirth = this.placeComplete(team, s.x, s.z, s.yaw, "rebirth", 1, 3.2, 3.2);
    const toCx = WORLD * 0.5 - s.x;
    const toCz = WORLD * 0.5 - s.z;
    const len = Math.hypot(toCx, toCz) || 1;
    const fx = toCx / len;
    const fz = toCz / len;
    const px = -fz;
    const pz = fx;
    const h1x = s.x + fx * 4.0 + px * 4.0;
    const h1z = s.z + fz * 4.0 + pz * 4.0;
    const h2x = s.x + fx * 4.0 - px * 4.0;
    const h2z = s.z + fz * 4.0 - pz * 4.0;
    const hut1 = this.placeComplete(team, h1x, h1z, s.yaw + 0.12, "hut", 1);
    const hut2 = this.placeComplete(team, h2x, h2z, s.yaw - 0.12, "hut", 1);
    const sh = this.spawnNear(rebirth) ?? { x: s.x + 0.4, z: s.z + 1.8 };
    this.addUnit(team, "shaman", sh.x, sh.z);
    const w1 = this.spawnNear(hut1) ?? { x: h1x + 1.6, z: h1z + 1.2 };
    const w2 = this.spawnNear(hut2) ?? { x: h2x - 1.6, z: h2z + 1.2 };
    this.addUnit(team, "walker", w1.x, w1.z);
    this.addUnit(team, "walker", w2.x, w2.z);
  }

  seedWildmen(): void {
    const pts = [
      { x: 26, z: 26 },
      { x: 22, z: 30 },
      { x: 30, z: 22 },
      { x: 24, z: 18 },
      { x: 18, z: 24 },
      { x: 33, z: 28 },
      { x: 28, z: 34 },
    ];
    for (const p of pts) {
      if (this.world.land(p.x, p.z)) this.addUnit(NEUTRAL, "wildman", p.x, p.z);
    }
  }

  seedTrees(): void {
    const rng = this.world.rng;
    const n = rng.int(28, 40);
    const pads: Pad[] = this.buildings.map((b) => this.buildingPad(b));
    for (const s of this.world.starts) pads.push({ x: s.x, z: s.z, w: 3.6, d: 3.6, yaw: s.yaw });
    let tries = 0;
    while (this.trees.length < n && tries < 2000) {
      tries++;
      const x = rng.float(3, WORLD - 3);
      const z = rng.float(3, WORLD - 3);
      if (!this.world.land(x, z)) continue;
      if (this.world.heightAt(x, z) <= WATER + 0.15) continue;
      if (this.world.slopeAt(x, z) > 0.55) continue;
      let blocked = false;
      for (const p of pads) {
        if (inPad(x, z, p, 0.9)) {
          blocked = true;
          break;
        }
      }
      if (blocked) continue;
      for (const t of this.trees) {
        if (dist2(x, z, t.x, t.z) < 4.84) {
          blocked = true;
          break;
        }
      }
      if (blocked) continue;
      this.trees.push(createTree(nid(), x, z, this.world.heightAt(x, z), true, 0));
    }
  }

  addUnit(team: Owner, kind: UnitKind, x: number, z: number, str = 1): Unit {
    const u = createUnit(nid(), team, kind, x, z, this.world.heightAt(x, z), str);
    if (isTribe(team)) {
      u.order = this.teams[team].order;
    }
    this.units.push(u);
    if (kind === "shaman" && isTribe(team)) this.teams[team].hasShaman = true;
    return u;
  }

  buildingPad(b: Building): Pad {
    return { x: b.x, z: b.z, w: b.padW, d: b.padD, yaw: b.yaw };
  }

  canFound(x: number, z: number, level: number, yaw: number, ignoreId = 0): boolean {
    const pad = padSize(level);
    if (!this.world.padReady(x, z, pad.w, pad.d, yaw)) return false;
    const mine: Pad = { x, z, w: pad.w, d: pad.d, yaw };
    for (const b of this.buildings) {
      if (b.hp <= 0 || b.id === ignoreId) continue;
      if (padsOverlap(mine, this.buildingPad(b))) return false;
    }
    return true;
  }

  padEdge(cx: number, cz: number, w: number, d: number, yaw: number, fromX: number, fromZ: number): Cell {
    const pad: Pad = { x: cx, z: cz, w, d, yaw };
    const inflate = 0.62;
    const local = (px: number, pz: number) => {
      const dx = px - pad.x;
      const dz = pz - pad.z;
      const c = Math.cos(-pad.yaw);
      const s = Math.sin(-pad.yaw);
      return { x: dx * c - dz * s, z: dx * s + dz * c };
    };
    const l = local(fromX, fromZ);
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
    const safe = nearestLand(this.world, first.x, first.z);
    return safe ?? first;
  }

  trueRim(x: number, z: number, pad: Pad): boolean {
    if (!this.world.walkableAt(x, z)) return false;
    if (inPad(x, z, pad) && !inDoorSlit(x, z, pad)) return false;
    return true;
  }

  nearestRim(pad: Pad, inflate: number, fromX: number, fromZ: number): Cell | null {
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

  treeRim(tree: Tree, fromX: number, fromZ: number): Cell {
    const r = 0.38 + 0.30;
    let dx = fromX - tree.x;
    let dz = fromZ - tree.z;
    let len = Math.hypot(dx, dz);
    if (len < 1e-4) {
      dx = 0;
      dz = 1;
      len = 1;
    }
    const base = Math.atan2(dz, dx);
    for (let k = 0; k < 16; k++) {
      const sign = k % 2 === 0 ? 1 : -1;
      const n = Math.ceil(k / 2);
      const ang = base + sign * n * (Math.PI / 8);
      const x = tree.x + Math.cos(ang) * r;
      const z = tree.z + Math.sin(ang) * r;
      if (this.world.walkableAt(x, z)) return { x, z };
    }
    const fx = tree.x + (dx / len) * r;
    const fz = tree.z + (dz / len) * r;
    return nearestLand(this.world, fx, fz) ?? { x: fx, z: fz };
  }

  markHouseBlocks(): void {
    const pads: Pad[] = [];
    for (const b of this.buildings) {
      if (b.hp <= 0) continue;
      pads.push(this.buildingPad(b));
    }
    this.world.setPads(pads);
    const trees = [];
    for (const t of this.trees) {
      if (!t.alive) continue;
      trees.push({ x: t.x, z: t.z, r: 0.38 });
    }
    this.world.setTrees(trees);
  }

  placeComplete(
    team: Team,
    x: number,
    z: number,
    yaw: number,
    kind: BuildingKind,
    level: number,
    padW?: number,
    padD?: number,
  ): Building {
    const pad = padW !== undefined && padD !== undefined ? { w: padW, d: padD } : padSize(kind === "hut" ? Math.max(1, level) : 1);
    const h = Math.max(this.world.heightAt(x, z), 0.8);
    this.world.flattenPad(x, z, pad.w, pad.d, yaw, h);
    const y = this.world.heightAt(x, z);
    const hp = kind === "rebirth" ? 40 : houseHp(Math.max(1, level));
    const b = createBuilding(
      nid(),
      team,
      kind,
      x,
      z,
      y,
      level,
      yaw,
      pad.w,
      pad.d,
      hp,
      hp,
      woodNeedFor(kind, level),
    );
    this.buildings.push(b);
    this.markHouseBlocks();
    return b;
  }

  foundSite(team: Team, x: number, z: number, yaw: number, kind: BuildingKind): Building | null {
    if (!this.canFound(x, z, 1, yaw)) return null;
    const pad = padSize(1);
    const h = this.world.heightAt(x, z);
    this.world.flattenPad(x, z, pad.w, pad.d, yaw, h);
    const y = this.world.heightAt(x, z);
    const b = createBuilding(
      nid(),
      team,
      kind,
      x,
      z,
      y,
      0,
      yaw,
      pad.w,
      pad.d,
      12,
      12,
      woodNeedFor(kind, 0),
    );
    this.buildings.push(b);
    this.markHouseBlocks();
    return b;
  }

  buildingAt(x: number, z: number): Building | undefined {
    return this.buildings.find((b) => b.hp > 0 && inPad(x, z, this.buildingPad(b)));
  }

  unitAt(x: number, z: number, r = 0.55): Unit | undefined {
    let best: Unit | undefined;
    let bestD = r * r;
    for (const u of this.units) {
      if (u.homeId > 0) continue;
      const d = dist2(u.x, u.z, x, z);
      if (d <= bestD) {
        bestD = d;
        best = u;
      }
    }
    return best;
  }

  countPop(team: Team): number {
    return this.units.filter((u) => u.team === team).length;
  }

  popCap(team: Team): number {
    let n = 0;
    for (const b of this.buildings) {
      if (b.team === team && b.hp > 0 && b.kind === "hut" && b.level >= 1) n += houseMaxPop(b.level);
    }
    return n;
  }

  countKind(team: Owner, kind: UnitKind): number {
    return this.units.filter((u) => u.team === team && u.kind === kind).length;
  }

  countHouses(team: Team): number {
    return this.buildings.filter((b) => b.team === team && b.hp > 0 && b.kind === "hut" && b.level >= 1).length;
  }

  countWood(team: Team): number {
    let n = 0;
    for (const u of this.units) if (u.team === team) n += u.carry;
    for (const b of this.buildings) if (b.team === team && b.hp > 0) n += b.wood;
    return n;
  }

  spend(team: Team, cost: number): boolean {
    const t = this.teams[team];
    if (t.mana < cost) return false;
    t.mana -= cost;
    return true;
  }

  toast(msg: string): void {
    this.logs.push(msg);
    if (this.logs.length > 8) this.logs.shift();
    this.toastGen++;
  }

  selectedOf(team: Team): Unit[] {
    return this.units.filter((u) => u.team === team && u.selected);
  }

  private clearOrders(u: Unit): void {
    u.foundKind = null;
    u.targetId = 0;
    u.atkId = 0;
    u.channel = 0;
    u.channelId = 0;
    u.trainKind = null;
    u.settleX = -1;
    u.settleZ = -1;
    u.moveX = -1;
    u.moveZ = -1;
  }

  sendMove(u: Unit, x: number, z: number): void {
    if (u.hp <= 0) return;
    if (u.job === "train") {
      u.channel = 0;
      u.channelId = 0;
      u.targetId = 0;
      u.trainKind = null;
    }
    this.clearOrders(u);
    let dest = this.world.walkableAt(x, z) ? { x, z } : nearestLand(this.world, x, z);
    if (!dest) {
      // Deep unreachable target (open sea): walk as close as possible instead of dropping the order.
      for (const t of [0.7, 0.45, 0.25]) {
        dest = nearestLand(this.world, u.x + (x - u.x) * t, u.z + (z - u.z) * t);
        if (dest) break;
      }
    }
    if (!dest) return;
    u.job = "move";
    u.moveX = dest.x;
    u.moveZ = dest.z;
    u.think = 40;
    u.path = astar(this.world, u.x, u.z, dest.x, dest.z);
    if (!u.path.length) u.path = [{ x: dest.x, z: dest.z }];
    u.pathI = 0;
    this.stuckWatch.set(u.id, { x: u.x, z: u.z, t: this.time });
  }

  orderMove(team: Team, x: number, z: number): void {
    const selected = this.selectedOf(team);
    if (!selected.length) return;
    const b = this.buildingAt(x, z);
    if (b && b.team === team && b.hp > 0 && b.level >= 1 && b.kind === "hut") {
      let sent = 0;
      for (const u of selected) {
        if (u.kind === "walker" && u.homeId === 0 && !this.inSwamp(u)) {
          const door = this.hutDoor(b);
          this.sendMove(u, door.x, door.z);
          u.targetId = b.id;
          u.atkId = 0;
          sent++;
        } else {
          u.atkId = 0;
          this.sendMove(u, x, z);
        }
      }
      if (sent && team === BLUE) this.toast("前往入住");
      return;
    }
    if (b && b.team === team && b.hp > 0 && b.level >= 1 && isCampKind(b.kind)) {
      const kind = TRAIN_FOR_CAMP[b.kind];
      if (!kind) return;
      const walkers = selected.filter((u) => u.kind === "walker" && u.homeId === 0 && !this.inSwamp(u));
      if (!walkers.length) {
        this.toast("选勇士去训练");
        return;
      }
      for (const w of walkers) this.sendWalkerToCamp(w, b, kind);
      if (team === BLUE) this.toast("前往训练");
      return;
    }
    for (const u of selected) {
      u.atkId = 0;
      this.sendMove(u, x, z);
    }
  }

  isBuildingTarget(t: Unit | Building): t is Building {
    return (t as Building).padW !== undefined;
  }

  unitById(id: number): Unit | null {
    if (!id) return null;
    return this.units.find((u) => u.id === id && u.hp > 0 && u.homeId === 0) ?? null;
  }

  liveAttackUnit(u: Unit): Unit | null {
    return this.unitById(u.atkId);
  }

  liveAttackDest(u: Unit): { x: number; z: number } | null {
    if (!u.atkId) return null;
    const tu = this.unitById(u.atkId);
    if (tu) return { x: tu.x, z: tu.z };
    const b = this.buildingById(u.atkId);
    if (b) return this.padEdge(b.x, b.z, b.padW, b.padD, b.yaw, u.x, u.z);
    u.atkId = 0;
    return null;
  }

  chaseAttack(u: Unit): void {
    const dest = this.liveAttackDest(u);
    if (!dest) {
      u.atkId = 0;
      u.job = "idle";
      return;
    }
    const atkId = u.atkId;
    this.clearOrders(u);
    u.atkId = atkId;
    u.job = "move";
    u.path = astar(this.world, u.x, u.z, dest.x, dest.z);
    if (!u.path.length) u.path = [{ x: dest.x, z: dest.z }];
    u.pathI = 0;
    u.think = 0.55;
  }

  orderAttack(team: Team, x: number, z: number): void {
    const u = this.unitAt(x, z, 0.7);
    if (u && u.team !== team && u.hp > 0 && u.homeId === 0) {
      this.orderAttackTarget(team, u);
      return;
    }
    const b = this.buildingAt(x, z);
    if (b && b.team !== team && b.hp > 0) this.orderAttackTarget(team, b);
  }

  orderAttackTarget(team: Team, target: Unit | Building): void {
    const selected = this.selectedOf(team);
    if (!selected.length) return;
    const isB = this.isBuildingTarget(target);
    let sent = 0;
    for (const u of selected) {
      if (u.job === "train" || u.homeId > 0 || u.hp <= 0) continue;
      u.order = "fight";
      const dest = isB
        ? this.padEdge(target.x, target.z, target.padW, target.padD, target.yaw, u.x, u.z)
        : { x: target.x, z: target.z };
      this.sendMove(u, dest.x, dest.z);
      u.atkId = target.id;
      u.think = 0.55;
      sent++;
    }
    if (sent && team === BLUE) this.toast(isB ? "拆屋" : "进攻");
  }

  assignBuilders(team: Team, site: Building): void {
    const walkers = this.selectedOf(team).filter((u) => u.kind === "walker" && u.hp > 0);
    for (const u of walkers) {
      let edge = this.padEdge(site.x, site.z, site.padW, site.padD, site.yaw, u.x, u.z);
      if (Math.hypot(u.x - edge.x, u.z - edge.z) < 0.45) {
        edge = this.padEdge(site.x, site.z, site.padW, site.padD, site.yaw, site.x - (u.x - site.x), site.z - (u.z - site.z));
      }
      this.sendMove(u, edge.x, edge.z);
      u.targetId = site.id;
      u.atkId = 0;
    }
  }

  setOrder(team: Team, order: Order): void {
    this.teams[team].order = order;
    const selected = this.selectedOf(team);
    const pool = selected.length ? selected : team === BLUE ? [] : this.units.filter((u) => u.team === team);
    if (team === BLUE && !selected.length) {
      this.toast("先选人");
      return;
    }
    for (const u of pool) {
      if (u.homeId > 0) continue;
      if (u.kind !== "walker" && u.kind !== "shaman" && u.kind !== "spy") continue;
      if (u.job === "train") continue;
      this.clearOrders(u);
      u.order = order;
      u.path = [];
      u.think = 0;
    }
  }

  setMagnet(team: Team, x: number, z: number): void {
    this.teams[team].magnetX = x;
    this.teams[team].magnetZ = z;
  }

  sendWalkerToCamp(u: Unit, camp: Building, kind: TrainKind): void {
    this.trainingSystem.sendWalkerToCamp(this, u, camp, kind);
  }

  padLocalToWorld(camp: Building, lx: number, lz: number): { x: number; z: number } {
    const c = Math.cos(camp.yaw);
    const s = Math.sin(camp.yaw);
    return { x: camp.x + lx * c - lz * s, z: camp.z + lx * s + lz * c };
  }

  trainDoor(camp: Building): { x: number; z: number; fx: number; fz: number } {
    return this.trainingSystem.trainDoor(camp);
  }

  /** Walkable cell just outside the hut door (local +Z), not inside the pad. */
  hutDoor(b: Building): Cell {
    const pad = this.buildingPad(b);
    for (const extra of [0.55, 0.72, 0.92, 1.15, 1.4]) {
      const p = this.padLocalToWorld(b, 0, b.padD / 2 + extra);
      if (this.world.walkableAt(p.x, p.z) && !inPad(p.x, p.z, pad)) return p;
    }
    for (const side of [0.22, -0.22, 0.4, -0.4]) {
      const p = this.padLocalToWorld(b, side, b.padD / 2 + 0.7);
      if (this.world.walkableAt(p.x, p.z) && !inPad(p.x, p.z, pad)) return p;
    }
    const front = this.padLocalToWorld(b, 0, b.padD / 2 + 0.7);
    return this.padEdge(b.x, b.z, b.padW, b.padD, b.yaw, front.x, front.z);
  }

  occupy(u: Unit, hut: Building): boolean {
    return this.productionSystem.occupy(this, u, hut);
  }

  tryOccupy(u: Unit): boolean {
    return this.productionSystem.tryOccupy(this, u);
  }

  snapTrainSlot(camp: Building, raw: { x: number; z: number }): { x: number; z: number } {
    return this.trainingSystem.snapTrainSlot(this, camp, raw);
  }

  trainSlotPos(camp: Building, slot: number): { x: number; z: number } {
    return this.trainingSystem.trainSlotPos(this, camp, slot);
  }

  trainQueue(campId: number): Unit[] {
    return this.trainingSystem.trainQueue(this, campId);
  }

  assignCampFounder(u: Unit, campKind: BuildingKind): void {
    u.foundKind = campKind;
    u.job = "idle";
    u.think = 0;
    u.path = [];
    u.pathI = 0;
    const site = this.findCampSite(u);
    if (!site) {
      u.foundKind = null;
      return;
    }
    u.settleX = site.x;
    u.settleZ = site.z;
    const made = this.foundSite(u.team as Team, site.x, site.z, u.settleYaw, campKind);
    if (made) {
      u.foundKind = null;
      u.settleX = -1;
      u.settleZ = -1;
      return;
    }
    const pad = padSize(1);
    const edge = this.padEdge(site.x, site.z, pad.w, pad.d, u.settleYaw, u.x, u.z);
    u.path = astar(this.world, u.x, u.z, edge.x, edge.z);
  }

  train(team: Team, kind: TrainKind): boolean {
    return this.trainingSystem.train(this, team, kind);
  }

  tick(dt: number): void {
    if (this.winner !== null) return;
    this.time += dt;
    this.tickVolcano(dt);
    this.world.tickFx(dt);
    this.tickTrees(dt);
    this.refreshHouses();
    this.markHouseBlocks();
    this.regenMana(dt);
    this.produce(dt);
    this.thinkUnits(dt);
    this.moveUnits(dt);
    this.tickEnter(dt);
    this.watchStuck();
    this.tickBlast(dt);
    this.tickQuake(dt);
    this.tickTornado(dt);
    this.combat(dt);
    this.projectiles(dt);
    this.hazards(dt);
    this.mergeWalkers();
    this.respawnShamans(dt);
    this.cull();
    this.checkWin();
  }

  tickEnter(dt: number): void {
    this.productionSystem.tickEnter(this, dt);
  }

  tickTrees(dt: number): void {
    this.productionSystem.tickTrees(this, dt);
  }

  regenMana(dt: number): void {
    this.productionSystem.regenMana(this, dt);
  }

  refreshHouses(): void {
    this.productionSystem.refreshHouses(this);
  }

  produce(dt: number): void {
    this.productionSystem.produce(this, dt);
  }

  spawnNear(b: Building): Cell | null {
    const pad = this.buildingPad(b);
    for (let k = 0; k < 20; k++) {
      const ang = (k / 20) * Math.PI * 2 + b.yaw;
      const x = b.x + Math.cos(ang) * (b.padW * 0.5 + 0.62);
      const z = b.z + Math.sin(ang) * (b.padD * 0.5 + 0.62);
      if (this.world.walkableAt(x, z) && !inPad(x, z, pad)) return { x, z };
    }
    return this.padEdge(b.x, b.z, b.padW, b.padD, b.yaw, b.x + 1, b.z + 1);
  }

  inSwamp(u: Unit): boolean {
    if (!inMap(u.x, u.z)) return false;
    return this.world.swamp[this.world.sampleAt(u.x, u.z)]! > 0;
  }

  thinkUnits(dt: number): void {
    for (const u of this.units) {
      if (u.homeId > 0) continue;
      u.think -= dt;
      if (this.tryOccupy(u)) continue;
      if (this.inSwamp(u)) {
        u.path = [];
        u.pathI = 0;
        if (u.job === "chop") u.channel = 0;
        continue;
      }
      if (u.job === "train") {
        this.advanceTrain(u, dt);
        continue;
      }
      if (u.job === "move") {
        if (u.order === "fight" && u.atkId) {
          if (!u.path.length || u.think <= 0) this.chaseAttack(u);
          continue;
        }
        if (!u.path.length) {
          u.job = "idle";
          u.moveX = -1;
          u.moveZ = -1;
        } else continue;
      }
      if (u.kind === "walker" && this.advanceWalker(u, dt)) {
        u.path = [];
        continue;
      }
      if (u.kind === "preacher" && u.channel > 0) continue;
      if (u.think > 0 && u.path.length) continue;
      u.think = 0.6 + Math.random() * 0.5;
      this.repath(u);
    }
  }

  advanceWalker(u: Unit, dt: number): boolean {
    if (u.homeId > 0) return true;
    if (this.tryOccupy(u)) return true;
    if (u.job === "train") return this.advanceTrain(u, dt);
    if (u.order !== "settle") return false;
    if (!isTribe(u.team)) return false;

    if (u.carry === 1) {
      const site = this.buildingById(u.targetId) ?? this.nearestNeedSite(u.team, u.x, u.z);
      if (!site || !this.needsWood(site)) return false;
      const edge = this.padEdge(site.x, site.z, site.padW, site.padD, site.yaw, u.x, u.z);
      if (dist2(u.x, u.z, edge.x, edge.z) > 1.6 && dist2(u.x, u.z, site.x, site.z) > 2.6) return false;
      u.carry = 0;
      u.job = "idle";
      u.targetId = 0;
      this.deliverWood(site);
      if (u.trainKind && isTribe(u.team)) {
        const campKind = CAMP_FOR[u.trainKind];
        const camp = this.buildings.find((b) => b.team === u.team && b.kind === campKind && b.level >= 1 && b.hp > 0);
        if (camp) {
          this.sendWalkerToCamp(u, camp, u.trainKind);
          return true;
        }
      }
      return true;
    }

    if (u.job === "chop") {
      const tree = this.trees.find((t) => t.id === u.targetId);
      if (!tree || !tree.alive) {
        u.job = "idle";
        u.targetId = 0;
        u.channel = 0;
        return false;
      }
      if (dist2(u.x, u.z, tree.x, tree.z) > 0.95) return false;
      u.channel += dt;
      if (u.channel >= CHOP_TIME) {
        u.channel = 0;
        u.carry = 1;
        u.job = "haul";
        tree.alive = false;
        tree.regen = TREE_REGEN;
        u.targetId = 0;
      }
      return true;
    }

    if (u.settleX >= 0 && !this.buildingAt(u.settleX, u.settleZ)) {
      const pad = padSize(1);
      const edge = this.padEdge(u.settleX, u.settleZ, pad.w, pad.d, u.settleYaw, u.x, u.z);
      if (dist2(u.x, u.z, edge.x, edge.z) <= 1.5) {
        const kind = u.foundKind ?? "hut";
        if (kind === "hut" && this.hasNeedSite(u.team)) {
          u.settleX = -1;
          u.settleZ = -1;
          return false;
        }
        const made = this.foundSite(u.team, u.settleX, u.settleZ, u.settleYaw, kind);
        u.settleX = -1;
        u.settleZ = -1;
        if (made) u.foundKind = null;
        if (made && kind !== "hut") this.toast(u.team === BLUE ? "开始搭建训练营" : "敌方开建训练营");
        return !!made;
      }
    }
    return false;
  }

  walkableTrainDest(u: Unit, dest: { x: number; z: number }): { x: number; z: number } {
    return this.trainingSystem.walkableTrainDest(this, u, dest);
  }

  pathToSlot(u: Unit, dest: { x: number; z: number }): void {
    this.trainingSystem.pathToSlot(this, u, dest);
  }

  advanceTrain(u: Unit, dt: number): boolean {
    return this.trainingSystem.advanceTrain(this, u, dt);
  }

  finishTrain(u: Unit, camp: Building): void {
    this.trainingSystem.finishTrain(this, u, camp);
  }

  deliverWood(b: Building): void {
    this.productionSystem.deliverWood(this, b);
  }

  completeStep(b: Building): void {
    this.productionSystem.completeStep(this, b);
  }

  upgradeBuilding(b: Building, level: number): void {
    this.productionSystem.upgradeBuilding(this, b, level);
  }

  needsWood(b: Building): boolean {
    return this.productionSystem.needsWood(b);
  }

  hasNeedSite(team: Team): boolean {
    return this.productionSystem.hasNeedSite(this, team);
  }

  nearestNeedSite(team: Team, x: number, z: number): Building | null {
    return this.productionSystem.nearestNeedSite(this, team, x, z);
  }

  buildingById(id: number): Building | null {
    if (!id) return null;
    return this.buildings.find((b) => b.id === id && b.hp > 0) ?? null;
  }

  wantedCampToFound(team: Team): BuildingKind | null {
    for (const k of this.teams[team].wanted) {
      const exists = this.buildings.some((b) => b.team === team && b.kind === k && b.hp > 0);
      if (!exists) return k;
    }
    return null;
  }

  nearestTree(x: number, z: number): Tree | null {
    let best: Tree | null = null;
    let bestD = 1e9;
    for (const t of this.trees) {
      if (!t.alive) continue;
      const d = dist2(x, z, t.x, t.z);
      if (d < bestD) {
        bestD = d;
        best = t;
      }
    }
    return best;
  }

  repath(u: Unit): void {
    if (u.team === NEUTRAL) {
      this.wander(u);
      return;
    }
    const team = this.teams[u.team as Team];
    if (this.armageddon) {
      u.order = "fight";
      this.combatSystem.acquireTarget(this, u);
      if (!u.atkId) {
        u.path = astar(this.world, u.x, u.z, WORLD * 0.5, WORLD * 0.5);
        u.pathI = 0;
      }
      return;
    }

    // v0.8 自动索敌：在 order/job 分派之前尝试拿一个最近敌人；失败再走原逻辑。
    this.combatSystem.acquireTarget(this, u);

    if (u.job === "train" && u.targetId) {
      const camp = this.buildingById(u.targetId);
      if (camp) {
        const queue = this.trainQueue(camp.id);
        let slot = queue.findIndex((o) => o.id === u.id);
        if (slot < 0) slot = queue.length;
        const dest = this.trainSlotPos(camp, slot);
        if (dist2(u.x, u.z, dest.x, dest.z) <= 0.18 * 0.18) {
          u.path = [];
          u.pathI = 0;
        } else {
          this.pathToSlot(u, dest);
        }
        return;
      }
    }

    if (u.atkId) {
      const tgt = this.liveAttackDest(u);
      if (tgt) {
        u.path = astar(this.world, u.x, u.z, tgt.x, tgt.z);
        u.pathI = 0;
        return;
      }
      u.job = "idle";
    }

    if (u.kind === "shaman" && u.order === "settle") {
      const home = this.nearestHouse(u.team as Team, u.x, u.z);
      if (home && dist2(u.x, u.z, home.x, home.z) > 9) {
        u.path = astar(this.world, u.x, u.z, home.x, home.z);
        u.pathI = 0;
      } else {
        this.wander(u);
      }
      return;
    }

    if (u.order === "shaman") {
      const sh = this.units.find((o) => o.team === u.team && o.kind === "shaman");
      if (sh) {
        u.path = astar(this.world, u.x, u.z, sh.x, sh.z);
        u.pathI = 0;
        return;
      }
    }

    if (u.order === "gather") {
      u.path = astar(this.world, u.x, u.z, team.magnetX, team.magnetZ);
      u.pathI = 0;
      return;
    }

    if (u.kind === "walker" && u.order === "settle") {
      this.repathSettle(u);
      return;
    }
    this.wander(u);
  }

  isAssignedFounder(u: Unit): boolean {
    return (
      u.kind === "walker" &&
      u.settleX >= 0 &&
      u.carry === 0 &&
      u.job !== "chop" &&
      u.job !== "haul" &&
      u.job !== "train"
    );
  }

  mayFoundCamp(u: Unit, wantCamp: BuildingKind | null): boolean {
    if (!wantCamp || u.foundKind !== wantCamp || u.carry !== 0) return false;
    if (u.job === "chop" || u.job === "haul" || u.job === "train") return false;
    return true;
  }

  tryPrepFound(x: number, z: number, yaw: number): boolean {
    if (!inMap(x, z)) return false;
    if (this.world.heightAt(x, z) <= WATER) return false;
    const pad = padSize(1);
    const mine: Pad = { x, z, w: pad.w + 0.7, d: pad.d + 0.7, yaw };
    for (const b of this.buildings) {
      if (b.hp <= 0) continue;
      if (padsOverlap(mine, this.buildingPad(b))) return false;
    }
    const h = Math.max(this.world.heightAt(x, z), 0.8);
    this.world.flattenPad(x, z, pad.w + 1.0, pad.d + 1.0, yaw, h);
    return this.canFound(x, z, 1, yaw);
  }

  findCampSite(u: Unit): Cell | null {
    const home = isTribe(u.team) ? this.nearestHouse(u.team, u.x, u.z) : null;
    const ox = home ? home.x : u.x;
    const oz = home ? home.z : u.z;
    const yaw = snapYaw(home ? home.yaw : u.yaw);
    const toCx = WORLD * 0.5 - ox;
    const toCz = WORLD * 0.5 - oz;
    const len = Math.hypot(toCx, toCz) || 1;
    const fx = toCx / len;
    const fz = toCz / len;
    const px = -fz;
    const pz = fx;
    const dists = [6.2, 7.6, 5.4, 9.0];
    const sides = [0, 1.1, -1.1, 2.1, -2.1];
    for (const dist of dists) {
      for (const side of sides) {
        const x = clamp(ox + fx * dist + px * side * 2.4, 3, WORLD - 3);
        const z = clamp(oz + fz * dist + pz * side * 2.4, 3, WORLD - 3);
        if (this.tryPrepFound(x, z, yaw)) {
          u.settleYaw = yaw;
          return { x, z };
        }
      }
    }
    const site = this.findSettleSite(u);
    if (site && this.tryPrepFound(site.x, site.z, u.settleYaw)) return site;
    return site;
  }

  repathSettle(u: Unit): void {
    if (!isTribe(u.team)) {
      this.wander(u);
      return;
    }
    if (u.carry === 1) {
      const site = this.nearestNeedSite(u.team, u.x, u.z);
      if (site) {
        u.job = "haul";
        u.targetId = site.id;
        const edge = this.padEdge(site.x, site.z, site.padW, site.padD, site.yaw, u.x, u.z);
        u.path = astar(this.world, u.x, u.z, edge.x, edge.z);
        u.pathI = 0;
        return;
      }
    }

    const wantCamp = u.foundKind && u.moveX < 0 && u.job === "idle" ? u.foundKind : null;
    if (wantCamp && this.mayFoundCamp(u, wantCamp)) {
      let site: Cell | null = null;
      if (u.settleX >= 0 && this.tryPrepFound(u.settleX, u.settleZ, u.settleYaw)) site = { x: u.settleX, z: u.settleZ };
      if (!site) site = this.findCampSite(u);
      if (site) {
        const made = this.foundSite(u.team as Team, site.x, site.z, u.settleYaw, wantCamp);
        u.settleX = -1;
        u.settleZ = -1;
        if (made) {
          u.foundKind = null;
          this.toast(u.team === BLUE ? "开始搭建训练营" : "敌方开建训练营");
        }
      }
    }

    if (this.hasNeedSite(u.team) && u.carry === 0) {
      const tree = this.nearestTree(u.x, u.z);
      if (tree) {
        u.job = "chop";
        u.targetId = tree.id;
        u.channel = 0;
        u.settleX = -1;
        u.settleZ = -1;
        const dest = this.treeRim(tree, u.x, u.z);
        if (dest) {
          u.path = astar(this.world, u.x, u.z, dest.x, dest.z);
          u.pathI = 0;
          return;
        }
      }
    }

    if (!this.hasNeedSite(u.team) && !wantCamp) {
      if (u.team === BLUE) {
        if (u.think > 0) return; // holding position after a player move order
        this.wander(u);
        return;
      }
      let site: Cell | null = null;
      if (u.settleX >= 0 && this.canFound(u.settleX, u.settleZ, 1, u.settleYaw) && !this.buildingAt(u.settleX, u.settleZ)) {
        site = { x: u.settleX, z: u.settleZ };
      }
      if (!site) site = this.findSettleSite(u);
      if (site) {
        u.settleX = site.x;
        u.settleZ = site.z;
        const pad = padSize(1);
        const edge = this.padEdge(site.x, site.z, pad.w, pad.d, u.settleYaw, u.x, u.z);
        u.path = astar(this.world, u.x, u.z, edge.x, edge.z);
        u.pathI = 0;
        return;
      }
    }
    this.wander(u);
  }

  wander(u: Unit): void {
    for (let i = 0; i < 8; i++) {
      const tx = clamp(u.x + Math.random() * 10 - 5, 1, WORLD - 1);
      const tz = clamp(u.z + Math.random() * 10 - 5, 1, WORLD - 1);
      if (this.world.walkableAt(tx, tz)) {
        u.path = astar(this.world, u.x, u.z, tx, tz);
        u.pathI = 0;
        return;
      }
    }
    u.path = [];
  }

  findSettleSite(u: Unit): Cell | null {
    const home = isTribe(u.team) ? this.nearestHouse(u.team, u.x, u.z) : null;
    const ox = home ? home.x : u.x;
    const oz = home ? home.z : u.z;
    const yaw = snapYaw(u.yaw);
    for (let i = 0; i < 36; i++) {
      const baseX = i < 18 ? ox : u.x;
      const baseZ = i < 18 ? oz : u.z;
      const x = clamp(baseX + Math.random() * 18 - 9, 2, WORLD - 2);
      const z = clamp(baseZ + Math.random() * 18 - 9, 2, WORLD - 2);
      if (!this.canFound(x, z, 1, yaw)) continue;
      u.settleYaw = yaw;
      return { x, z };
    }
    return null;
  }

  nearestThreat(u: Unit, enemy: Team): { x: number; z: number } | null {
    let best: { x: number; z: number } | null = null;
    let bestD = 1e9;
    for (const o of this.units) {
      if (o.team !== enemy) continue;
      const d = dist2(u.x, u.z, o.x, o.z);
      if (d < bestD) {
        bestD = d;
        best = o;
      }
    }
    for (const b of this.buildings) {
      if (b.team !== enemy) continue;
      const d = dist2(u.x, u.z, b.x, b.z) * 0.85;
      if (d < bestD) {
        bestD = d;
        best = { x: b.x, z: b.z };
      }
    }
    return best;
  }

  nearestHouse(team: Team, x: number, z: number): Building | null {
    let best: Building | null = null;
    let bestD = 1e9;
    for (const b of this.buildings) {
      if (b.team !== team || b.hp <= 0) continue;
      const d = dist2(x, z, b.x, b.z);
      if (d < bestD) {
        bestD = d;
        best = b;
      }
    }
    return best;
  }

  moveUnits(dt: number): void {
    this.pathSystem.moveUnits(this, dt);
  }

  trainAllows(u: Unit, x: number, z: number): boolean {
    return this.trainingSystem.trainAllows(this, u, x, z);
  }

  onArrive(u: Unit): void {
    this.pathSystem.onArrive(this, u);
  }

  goalCell(u: Unit): Cell | null {
    return this.pathSystem.goalCell(this, u);
  }

  repathKeepJob(u: Unit, dest: Cell): void {
    this.pathSystem.repathKeepJob(this, u, dest);
  }

  detourAround(u: Unit, dest: Cell): Cell | null {
    return this.pathSystem.detourAround(this, u, dest);
  }

  unstick(u: Unit): void {
    this.pathSystem.unstick(this, u);
  }

  watchStuck(): void {
    this.pathSystem.watchStuck(this);
  }

  resolveCollisions(): void {
    this.pathSystem.resolveCollisions(this);
  }

  hurtBuilding(b: Building, dmg: number): void {
    this.combatSystem.hurtBuilding(this, b, dmg);
  }

  combat(dt: number): void {
    this.combatSystem.combat(this, dt);
  }

  preach(u: Unit, dt: number): void {
    this.combatSystem.preach(this, u, dt);
  }

  nearestConvertible(u: Unit): Unit | null {
    return this.combatSystem.nearestConvertible(this, u);
  }

  pushUnit(u: Unit, fromX: number, fromZ: number, dist: number): void {
    this.combatSystem.pushUnit(this, u, fromX, fromZ, dist);
  }

  closestEnemyUnit(u: Unit, enemy: Team, range: number): Unit | null {
    return this.combatSystem.closestEnemyUnit(this, u, enemy, range);
  }

  projectiles(dt: number): void {
    this.combatSystem.projectiles(this, dt);
  }

  hazards(dt: number): void {
    this.hazardSystem.hazards(this, dt);
  }

  holdPadsNearVolcano(): void {
    this.volcanoSpell.holdPadsNearVolcano(this);
  }

  lavaOnPad(b: Building): boolean {
    return this.hazardSystem.lavaOnPad(this, b);
  }

  burnBuildings(dt: number): void {
    this.hazardSystem.burnBuildings(this, dt);
  }

  blastAt(x: number, z: number): void {
    this.blastSpell.blastAt(this, x, z);
  }

  tickBlast(dt: number): void {
    this.blastSpell.tick(this, dt);
  }

  strikeLightning(x: number, z: number): void {
    this.lightningSpell.strikeLightning(this, x, z);
  }

  beginTornado(x: number, z: number): boolean {
    return this.tornadoSpell.beginTornado(this, x, z);
  }

  tickTornado(dt: number): void {
    this.tornadoSpell.tick(this, dt);
  }

  beginQuake(x: number, z: number): boolean {
    return this.quakeSpell.beginQuake(this, x, z);
  }

  crackPoint(q: { x: number; z: number; angs: number[] }, k: number, s: number): { x: number; z: number } {
    return this.quakeSpell.crackPoint(q, k, s);
  }

  nearestOpenCrack(x: number, z: number): { d: number; x: number; z: number } {
    return this.quakeSpell.nearestOpenCrack(this, x, z);
  }

  tickQuake(dt: number): void {
    this.quakeSpell.tick(this, dt);
  }

  slideIntoCracks(dt: number): void {
    this.quakeSpell.slideIntoCracks(this, dt);
  }

  collapseCutHouses(): void {
    this.quakeSpell.collapseCutHouses(this);
  }

  beginVolcano(x: number, z: number): boolean {
    return this.volcanoSpell.beginVolcano(this, x, z);
  }

  tickVolcano(dt: number): void {
    this.volcanoSpell.tick(this, dt);
  }

  mergeWalkers(): void {
    this.mergeSystem.mergeWalkers(this);
  }

  respawnShamans(dt: number): void {
    for (const team of [BLUE, RED] as Team[]) {
      const t = this.teams[team];
      if (t.hasShaman) continue;
      t.shamanRevive -= dt;
      if (t.shamanRevive > 0) continue;
      const rebirth = this.buildings.find((b) => b.team === team && b.kind === "rebirth" && b.hp > 0);
      const home = rebirth ?? this.nearestHouse(team, t.magnetX, t.magnetZ);
      const s = this.world.startPad(team);
      let x = s.x;
      let z = s.z + 1.2;
      if (home) {
        const spot = this.spawnNear(home);
        if (spot) {
          x = spot.x;
          z = spot.z;
        } else {
          x = home.x + 0.6;
          z = home.z + 1.2;
        }
      }
      this.addUnit(team, "shaman", x, z);
      t.shamanRevive = 0;
      this.toast(team === BLUE ? "祭司在再生点归来" : "敌方祭司复活");
    }
  }

  cull(): void {
    for (const u of this.units) {
      if (u.hp > 0) continue;
      if (u.kind === "shaman" && isTribe(u.team)) {
        this.teams[u.team].hasShaman = false;
        this.teams[u.team].shamanRevive = 8;
        this.toast(u.team === BLUE ? "祭司陨落，将在再生点归来" : "敌方祭司陨落");
      }
    }
    this.units = this.units.filter((u) => u.hp > 0);
    const wrecked = this.buildings.filter((b) => b.hp <= 0);
    if (wrecked.length) {
      for (const b of wrecked) {
        if (b.team === BLUE && (b.kind === "hut" || isCampKind(b.kind))) this.toast("一座屋宇被毁");
      }
    }
    this.buildings = this.buildings.filter((b) => b.hp > 0);
  }

  checkWin(): void {
    this.winSystem.checkWin(this);
  }

  damageArea(cx: number, cz: number, r: number, dmg: number, team?: Team): void {
    for (const u of this.units) {
      if (team !== undefined && u.team === team) continue;
      if (dist2(u.x, u.z, cx, cz) <= r * r) u.hp -= dmg;
    }
    for (const b of this.buildings) {
      if (team !== undefined && b.team === team) continue;
      if (dist2(b.x, b.z, cx, cz) <= r * r) b.hp -= dmg;
    }
  }
}
