import { astar, nearestLand } from "./path";
import { createBuilding, createTree, createUnit } from "./entities";
import {
  Ankh,
  BLUE,
  Building,
  BuildingKind,
  CAMP_FOR,
  TRAIN_FOR_CAMP,
  canConvert,
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
  TRAIN_TIME,
  TrainKind,
  TREE_REGEN,
  Tree,
  UNIT_RADIUS,
  Unit,
  UnitKind,
  unitHp,
  WATER,
  woodNeedFor,
  WORLD,
} from "./types";
import { inDoorSlit, inPad, Pad, padsOverlap, pushCircleFromPad, TREE_BLOCK_R, worldOnPad, World } from "./world";

let NEXT = 1;
function nid(): number {
  return NEXT++;
}

const TRAIN_DONE: Record<TrainKind, string> = {
  warrior: "一名勇士成为武士",
  preacher: "一名勇士成为传教士",
  firewarrior: "一名勇士成为火战士",
  spy: "一名勇士成为间谍",
};

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
    const r = TREE_BLOCK_R + 0.30;
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
      trees.push({ x: t.x, z: t.z, r: TREE_BLOCK_R });
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

  sendMove(u: Unit, x: number, z: number): void {
    if (u.hp <= 0 || u.job === "train") return;
    const dest = this.world.walkableAt(x, z) ? { x, z } : nearestLand(this.world, x, z);
    if (!dest) return;
    u.job = "move";
    u.think = 40;
    u.settleX = -1;
    u.settleZ = -1;
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
        if (u.kind !== "walker" || u.homeId > 0) continue;
        const door = this.hutDoor(b);
        u.targetId = b.id;
        u.atkId = 0;
        this.sendMove(u, door.x, door.z);
        sent++;
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
      u.atkId = target.id;
      const dest = isB
        ? this.padEdge(target.x, target.z, target.padW, target.padD, target.yaw, u.x, u.z)
        : { x: target.x, z: target.z };
      this.sendMove(u, dest.x, dest.z);
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
      u.targetId = site.id;
      u.atkId = 0;
      this.sendMove(u, edge.x, edge.z);
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
      u.order = order;
      u.atkId = 0;
      u.path = [];
      u.think = 0;
    }
  }

  setMagnet(team: Team, x: number, z: number): void {
    this.teams[team].magnetX = x;
    this.teams[team].magnetZ = z;
  }

  sendWalkerToCamp(u: Unit, camp: Building, kind: TrainKind): void {
    u.job = "train";
    u.trainKind = kind;
    u.targetId = camp.id;
    u.atkId = 0;
    u.carry = 0;
    u.channel = 0;
    u.channelId = this.trainJoinN++;
    u.path = [];
    u.pathI = 0;
    u.think = 0;
    const q = this.trainQueue(camp.id);
    const slot = Math.max(0, q.findIndex((o) => o.id === u.id));
    this.pathToSlot(u, this.trainSlotPos(camp, slot));
  }

  padLocalToWorld(camp: Building, lx: number, lz: number): { x: number; z: number } {
    const c = Math.cos(camp.yaw);
    const s = Math.sin(camp.yaw);
    return { x: camp.x + lx * c - lz * s, z: camp.z + lx * s + lz * c };
  }

  trainDoor(camp: Building): { x: number; z: number; fx: number; fz: number } {
    const fx = -Math.sin(camp.yaw);
    const fz = Math.cos(camp.yaw);
    const dist = camp.padD / 2 + 0.12;
    return { x: camp.x + fx * dist, z: camp.z + fz * dist, fx, fz };
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
    if (u.kind !== "walker" || u.homeId > 0) return false;
    if (hut.kind !== "hut" || hut.level < 1 || hut.hp <= 0) return false;
    if (hut.team !== u.team) return false;
    if (hut.dwell >= houseMaxPop(hut.level)) return false;
    hut.dwell += 1;
    u.homeId = hut.id;
    u.selected = false;
    u.path = [];
    u.pathI = 0;
    u.job = "idle";
    u.think = 99;
    u.targetId = 0;
    u.atkId = 0;
    u.carry = 0;
    u.channel = 0;
    return true;
  }

  tryOccupy(u: Unit): boolean {
    if (u.kind !== "walker" || u.homeId > 0 || !u.targetId) return false;
    const hut = this.buildingById(u.targetId);
    if (!hut || hut.kind !== "hut" || hut.level < 1 || hut.hp <= 0 || hut.team !== u.team) return false;
    const door = this.hutDoor(hut);
    if (dist2(u.x, u.z, door.x, door.z) > 1.2 * 1.2) return false;
    if (!this.occupy(u, hut)) return false;
    u.enterT = 0.42;
    return true;
  }

  snapTrainSlot(camp: Building, raw: { x: number; z: number }): { x: number; z: number } {
    const pad = this.buildingPad(camp);
    if (this.trueRim(raw.x, raw.z, pad)) return raw;
    const edge = this.padEdge(camp.x, camp.z, camp.padW, camp.padD, camp.yaw, raw.x, raw.z);
    if (this.trueRim(edge.x, edge.z, pad)) return edge;
    const rim = this.nearestRim(pad, 0.62, raw.x, raw.z);
    if (rim) return rim;
    const safe = nearestLand(this.world, raw.x, raw.z);
    return safe ?? edge;
  }

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

  trainQueue(campId: number): Unit[] {
    return this.units
      .filter((u) => u.job === "train" && u.targetId === campId)
      .sort((a, b) => a.channelId - b.channelId || a.id - b.id);
  }

  assignCampFounder(u: Unit, campKind: BuildingKind): void {
    u.foundKind = campKind;
    u.job = "idle";
    u.think = 0;
    u.path = [];
    u.pathI = 0;
    const site = this.findCampSite(u);
    if (!site) return;
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
    const selected = this.selectedOf(team);
    let walkers: Unit[];
    if (team === BLUE) {
      if (!selected.length) {
        this.toast("先选人");
        return false;
      }
      walkers = selected.filter((u) => u.kind === "walker" && u.homeId === 0 && !this.inSwamp(u));
      if (!walkers.length) {
        this.toast("选中的人不能训练");
        return false;
      }
    } else {
      walkers = this.units.filter((u) => u.team === team && u.kind === "walker" && u.homeId === 0);
      if (!walkers.length) return false;
    }
    const campKind = CAMP_FOR[kind];
    const camps = this.buildings.filter((b) => b.team === team && b.kind === campKind && b.level >= 1 && b.hp > 0);
    if (!camps.length) {
      if (team !== BLUE) {
        const t = this.teams[team];
        if (!t.wanted.includes(campKind)) t.wanted.push(campKind);
        const already = this.units.find((u) => u.team === team && u.kind === "walker" && u.foundKind === campKind);
        if (!already) {
          const idle = walkers.find((u) => u.carry === 0 && u.job !== "train" && u.job !== "haul" && u.job !== "chop")
            ?? walkers.find((u) => u.carry === 0 && u.job !== "train");
          if (idle) this.assignCampFounder(idle, campKind);
        }
      }
      this.toast("先盖训练营");
      return false;
    }
    const queued = walkers.filter((w) => w.job === "train");
    const ready = walkers.filter((w) => w.job !== "train");
    if (!ready.length) return true;
    let camp = camps[0]!;
    const follow = queued[0] ? this.buildingById(queued[0].targetId) : undefined;
    if (follow && follow.hp > 0 && follow.level >= 1) {
      camp = follow;
    } else {
      let cx = 0;
      let cz = 0;
      for (const w of ready) {
        cx += w.x;
        cz += w.z;
      }
      cx /= ready.length;
      cz /= ready.length;
      let bestD = dist2(cx, cz, camp.x, camp.z);
      for (const c of camps) {
        const d = dist2(cx, cz, c.x, c.z);
        if (d < bestD) {
          bestD = d;
          camp = c;
        }
      }
    }
    for (const w of ready) this.sendWalkerToCamp(w, camp, kind);
    if (team === BLUE) this.toast("前往训练");
    return true;
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
    for (const u of this.units) {
      if (u.enterT <= 0) continue;
      const hut = this.buildingById(u.homeId);
      const dest = hut ? this.padLocalToWorld(hut, 0, hut.padD * 0.12) : { x: u.x, z: u.z };
      const dx = dest.x - u.x;
      const dz = dest.z - u.z;
      const len = Math.hypot(dx, dz);
      if (len > 0.02) {
        const step = Math.min(len, 2.6 * dt);
        u.x += (dx / len) * step;
        u.z += (dz / len) * step;
        u.yaw = Math.atan2(dx, dz);
      }
      u.y = this.world.heightAt(u.x, u.z);
      u.enterT -= dt;
      if (u.enterT <= 0) {
        u.enterT = 0;
        if (u.team === BLUE && hut) {
          this.toast(`勇士住进茅屋（${hut.dwell}/${houseMaxPop(hut.level)}）`);
        }
      }
    }
  }

  tickTrees(dt: number): void {
    for (const t of this.trees) {
      if (t.alive) continue;
      t.regen -= dt;
      if (t.regen > 0) continue;
      if (this.world.heightAt(t.x, t.z) <= WATER) {
        t.regen = 4;
        continue;
      }
      t.alive = true;
      t.regen = 0;
      t.y = this.world.heightAt(t.x, t.z);
    }
  }

  regenMana(dt: number): void {
    for (const team of [BLUE, RED] as Team[]) {
      const t = this.teams[team];
      let cap = 80;
      let regen = 1.2;
      for (const b of this.buildings) {
        if (b.team !== team || b.kind !== "hut" || b.level < 1) continue;
        cap += b.level * 18;
        regen += b.level * 0.85;
      }
      const pop = this.countPop(team);
      cap += Math.min(80, pop * 2);
      regen += pop * 0.1;
      t.manaCap = cap;
      t.mana = clamp(t.mana + regen * dt, 0, t.manaCap);
    }
  }

  refreshHouses(): void {
    for (const b of this.buildings) {
      if (this.world.heightAt(b.x, b.z) <= WATER) {
        b.hp = 0;
        continue;
      }
      if (b.shell || this.lavaOnPad(b)) continue;
      if (b.kind === "hut") {
        if (this.world.houseLevelAt(b.x, b.z, b.yaw) === 0) b.hp = 0;
      } else if (isCampKind(b.kind)) {
        const s = this.world.padStats(b.x, b.z, b.padW, b.padD, b.yaw);
        if (s.n === 0 || s.land < 0.55 || s.mean <= WATER) b.hp = 0;
      }
    }
  }

  produce(dt: number): void {
    if (this.freezeProd) return;
    for (const b of this.buildings) {
      if (b.hp <= 0 || b.kind !== "hut" || b.level < 1) continue;
      if (b.wantLevel > b.level) {
        if (b.level === 1) this.upgradeBuilding(b, 2);
        else if (b.level === 2) this.upgradeBuilding(b, 3);
        b.wantLevel = 0;
      }
      if (b.dwell <= 0) continue;
      if (b.dwell >= houseMaxPop(b.level)) continue;
      if (this.countPop(b.team) >= this.popCap(b.team)) continue;
      const rate = b.level === 3 ? 0.28 : b.level === 2 ? 0.18 : b.dwell >= 2 ? 0.14 : 0.1;
      b.prod += rate * dt;
      if (b.prod >= 1) {
        const spot = this.hutDoor(b);
        if (!this.world.walkableAt(spot.x, spot.z)) {
          const fallback = this.spawnNear(b);
          if (!fallback) continue;
          spot.x = fallback.x;
          spot.z = fallback.z;
        }
        b.prod = 0;
        b.born += 1;
        const baby = this.addUnit(b.team, "walker", spot.x, spot.z);
        baby.homeId = 0;
        const out = this.padLocalToWorld(b, 0, b.padD / 2 + 2.0);
        this.sendMove(baby, out.x, out.z);
        if (b.born >= 2 && b.level === 1) b.wantLevel = 2;
        else if (b.born >= 5 && b.level === 2) b.wantLevel = 3;
      }
    }
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
      u.atkCd -= dt;
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
        if (!u.path.length) u.job = "idle";
        else continue;
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
    if (this.world.walkableAt(dest.x, dest.z)) return dest;
    const camp = this.buildingById(u.targetId);
    if (camp) {
      const edge = this.padEdge(camp.x, camp.z, camp.padW, camp.padD, camp.yaw, dest.x, dest.z);
      if (this.world.walkableAt(edge.x, edge.z)) return edge;
    }
    return nearestLand(this.world, dest.x, dest.z) ?? dest;
  }

  pathToSlot(u: Unit, dest: { x: number; z: number }): void {
    const d = this.walkableTrainDest(u, dest);
    const last = u.path.length ? u.path[u.path.length - 1] : null;
    if (last && dist2(last.x, last.z, d.x, d.z) <= 0.16) return;
    u.path = astar(this.world, u.x, u.z, d.x, d.z);
    if (!u.path.length) {
      const safe = this.world.walkableAt(d.x, d.z) ? d : nearestLand(this.world, d.x, d.z);
      u.path = safe ? [safe] : [];
    }
    u.pathI = 0;
  }

  advanceTrain(u: Unit, dt: number): boolean {
    const camp = this.buildings.find((b) => b.id === u.targetId && b.hp > 0 && b.level >= 1);
    if (!camp || !u.trainKind) {
      u.job = "idle";
      u.trainKind = null;
      u.channel = 0;
      u.targetId = 0;
      return false;
    }
    const queue = this.trainQueue(camp.id);
    let slot = queue.findIndex((o) => o.id === u.id);
    if (slot < 0) slot = queue.length;
    const dest = this.trainSlotPos(camp, slot);
    if (dist2(u.x, u.z, dest.x, dest.z) > 0.18 * 0.18) {
      this.pathToSlot(u, dest);
      return true;
    }
    u.path = [];
    u.pathI = 0;
    u.x = dest.x;
    u.z = dest.z;
    u.y = this.world.heightAt(u.x, u.z);
    u.yaw = Math.atan2(camp.x - u.x, camp.z - u.z);
    if (slot === 0) {
      u.channel += dt;
      if (u.channel >= TRAIN_TIME) this.finishTrain(u, camp);
    } else {
      u.channel = 0;
    }
    return true;
  }

  finishTrain(u: Unit, camp: Building): void {
    const kind = u.trainKind!;
    u.kind = kind;
    u.str = Math.max(u.str, 1);
    u.hp = u.maxHp = unitHp(kind, u.str);
    u.order = kind === "spy" ? this.teams[u.team as Team].order : "fight";
    u.job = "idle";
    u.trainKind = null;
    u.channel = 0;
    u.channelId = 0;
    u.carry = 0;
    u.targetId = 0;
    u.disguise = kind === "spy" ? null : u.disguise;
    const door = this.trainDoor(camp);
    const rx = Math.cos(camp.yaw);
    const rz = -Math.sin(camp.yaw);
    let sx = door.x + rx * 0.8;
    let sz = door.z + rz * 0.8;
    if (!this.world.walkableAt(sx, sz)) {
      sx = door.x - rx * 0.8;
      sz = door.z - rz * 0.8;
    }
    if (!this.world.walkableAt(sx, sz)) {
      const safe = nearestLand(this.world, sx, sz);
      if (safe) {
        sx = safe.x;
        sz = safe.z;
      }
    }
    u.x = sx;
    u.z = sz;
    u.y = this.world.heightAt(u.x, u.z);
    u.path = [];
    u.pathI = 0;
    u.think = 0.2;
    this.toast(TRAIN_DONE[kind]);
    const nxt = this.trainQueue(camp.id)[0];
    if (nxt) {
      nxt.think = 0;
      nxt.path = [];
      nxt.pathI = 0;
    }
  }

  deliverWood(b: Building): void {
    if (this.review) return;
    if (b.hp <= 0 || b.need <= 0 || b.wood >= b.need) return;
    b.wood += 1;
    if (b.wood < b.need) return;
    this.completeStep(b);
  }

  completeStep(b: Building): void {
    if (b.kind === "hut") {
      if (b.level === 0) this.upgradeBuilding(b, 1);
      return;
    }
    if (isCampKind(b.kind) && b.level === 0) this.upgradeBuilding(b, 1);
  }

  upgradeBuilding(b: Building, level: number): void {
    b.level = level;
    const pad = padSize(b.kind === "hut" ? level : 1);
    const h = this.world.heightAt(b.x, b.z);
    this.world.flattenPad(b.x, b.z, pad.w, pad.d, b.yaw, h);
    b.padW = pad.w;
    b.padD = pad.d;
    b.y = this.world.heightAt(b.x, b.z);
    const hp = houseHp(Math.max(1, level));
    const ratio = b.maxHp > 0 ? b.hp / b.maxHp : 1;
    b.maxHp = hp;
    b.hp = Math.max(1, Math.round(hp * ratio));
    b.wood = 0;
    b.need = woodNeedFor(b.kind, level);
    this.markHouseBlocks();
    if (b.kind === "hut") {
      if (level === 1) this.toast(b.team === BLUE ? "子民筑起一座屋宇" : "敌民筑屋");
      else this.toast(b.team === BLUE ? `茅屋升至 ${level} 级` : "敌方茅屋升级");
    } else if (isCampKind(b.kind)) {
      this.toast(b.team === BLUE ? "训练营落成" : "敌方训练营落成");
    }
  }

  needsWood(b: Building): boolean {
    return b.hp > 0 && b.need > 0 && b.wood < b.need;
  }

  hasNeedSite(team: Team): boolean {
    return this.buildings.some((b) => b.team === team && this.needsWood(b));
  }

  nearestNeedSite(team: Team, x: number, z: number): Building | null {
    let best: Building | null = null;
    let bestD = 1e9;
    for (const b of this.buildings) {
      if (b.team !== team || !this.needsWood(b)) continue;
      const d = dist2(x, z, b.x, b.z);
      if (d < bestD) {
        bestD = d;
        best = b;
      }
    }
    return best;
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
      u.path = astar(this.world, u.x, u.z, WORLD * 0.5, WORLD * 0.5);
      u.pathI = 0;
      return;
    }

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

    const wantCamp = u.foundKind;
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
    for (const u of this.units) {
      if (u.homeId > 0) continue;
      if (u.fireT > 0) u.fireT = Math.max(0, u.fireT - dt);
      const g0 = this.world.heightAt(u.x, u.z);
      if (u.flyVy !== 0 || u.y > g0 + 0.08) {
        u.flyVy -= 18 * dt;
        u.x = clamp(u.x + u.flyVx * dt, 0.3, WORLD - 0.3);
        u.z = clamp(u.z + u.flyVz * dt, 0.3, WORLD - 0.3);
        u.y += u.flyVy * dt;
        u.path = [];
        u.pathI = 0;
        const g1 = this.world.heightAt(u.x, u.z);
        if (u.y <= g1) {
          u.y = g1;
          u.flyVy = 0;
          u.flyVx = 0;
          u.flyVz = 0;
        }
        continue;
      }
      const swamp = this.world.swamp[this.world.sampleAt(u.x, u.z)]! > 0;
      let spd = 2.4;
      if (u.kind === "warrior") spd = 3.3;
      else if (u.kind === "preacher") spd = 2.55;
      else if (u.kind === "firewarrior") spd = 2.7;
      else if (u.kind === "shaman") spd = 2.1;
      else if (u.kind === "spy") spd = 2.8;
      else if (u.kind === "wildman") spd = 1.8;
      if (swamp) spd *= 0.04;
      const sl = this.world.slopeAt(u.x, u.z);
      spd *= 1 / (1 + sl * 2.8);
      if (spd < 0.22) spd = 0.22;
      if (u.kind === "preacher" && u.channel > 0) {
        u.y = this.world.heightAt(u.x, u.z);
        continue;
      }
      if (u.job === "train" && u.channel > 0) {
        u.y = this.world.heightAt(u.x, u.z);
        continue;
      }
      if (!u.path.length) {
        const dest = this.goalCell(u);
        const going =
          u.job === "move" ||
          u.job === "haul" ||
          (u.job === "train" && u.channel <= 0) ||
          (u.job === "chop" && u.channel <= 0);
        if (going && dest && this.world.land(u.x, u.z) && this.world.land(dest.x, dest.z)) {
          u.path = [{ x: dest.x, z: dest.z }];
          u.pathI = 0;
        } else {
          u.y = this.world.heightAt(u.x, u.z);
          continue;
        }
      }
      if (u.pathI >= u.path.length) {
        u.path = [];
        this.onArrive(u);
        u.y = this.world.heightAt(u.x, u.z);
        continue;
      }
      const step = u.path[u.pathI]!;
      if (!this.world.walkableAt(step.x, step.z) && !this.trainAllows(u, step.x, step.z)) {
        u.pathI++;
        continue;
      }
      const dx = step.x - u.x;
      const dz = step.z - u.z;
      const len = Math.hypot(dx, dz);
      if (len < 0.08) {
        u.pathI++;
        if (u.pathI >= u.path.length) {
          u.path = [];
          this.onArrive(u);
        }
        continue;
      }
      const m = Math.min(1, (spd * dt) / len);
      u.x += dx * m;
      u.z += dz * m;
      u.yaw = Math.atan2(dx, dz);
      u.y = this.world.heightAt(u.x, u.z);
    }
    this.resolveCollisions();
    for (const u of this.units) {
      if (u.flyVy !== 0 || u.y > this.world.heightAt(u.x, u.z) + 0.08) continue;
      u.y = this.world.heightAt(u.x, u.z);
    }
  }

  trainAllows(u: Unit, x: number, z: number): boolean {
    if (u.job !== "train") return false;
    const camp = this.buildingById(u.targetId);
    if (!camp) return false;
    if (inPad(x, z, this.buildingPad(camp), 0.25)) return true;
    const queue = this.trainQueue(camp.id);
    let slot = queue.findIndex((o) => o.id === u.id);
    if (slot < 0) slot = 0;
    const dest = this.trainSlotPos(camp, slot);
    return dist2(x, z, dest.x, dest.z) <= 0.55 * 0.55;
  }

  onArrive(u: Unit): void {
    if (u.job === "move") u.job = "idle";
    u.think = 0;
    const home = this.buildingById(u.targetId);
    if (home) {
      u.yaw = Math.atan2(home.x - u.x, home.z - u.z);
      return;
    }
    const tr = this.trees.find((t) => t.id === u.targetId);
    if (tr) u.yaw = Math.atan2(tr.x - u.x, tr.z - u.z);
  }

  goalCell(u: Unit): Cell | null {
    if (u.job === "train" && u.targetId) {
      const camp = this.buildingById(u.targetId);
      if (camp && camp.level >= 1) {
        const queue = this.trainQueue(camp.id);
        let slot = queue.findIndex((o) => o.id === u.id);
        if (slot < 0) slot = 0;
        return this.trainSlotPos(camp, slot);
      }
    }
    if (u.path.length) {
      const last = u.path[u.path.length - 1]!;
      return { x: last.x, z: last.z };
    }
    if (u.targetId) {
      const b = this.buildingById(u.targetId);
      if (b) return this.padEdge(b.x, b.z, b.padW, b.padD, b.yaw, u.x, u.z);
      const tr = this.trees.find((t) => t.id === u.targetId);
      if (tr && tr.alive) return this.treeRim(tr, u.x, u.z);
    }
    if (u.settleX >= 0) {
      const pad = padSize(1);
      return this.padEdge(u.settleX, u.settleZ, pad.w, pad.d, u.settleYaw, u.x, u.z);
    }
    return null;
  }

  repathKeepJob(u: Unit, dest: Cell): void {
    u.path = astar(this.world, u.x, u.z, dest.x, dest.z);
    if (!u.path.length) u.path = [{ x: dest.x, z: dest.z }];
    u.pathI = 0;
  }

  detourAround(u: Unit, dest: Cell): Cell | null {
    let bx = (u.x + dest.x) * 0.5;
    let bz = (u.z + dest.z) * 0.5;
    let bestD = 1e9;
    let found = false;
    for (const b of this.buildings) {
      if (b.hp <= 0) continue;
      const midX = (u.x + dest.x) * 0.5;
      const midZ = (u.z + dest.z) * 0.5;
      const pad = this.buildingPad(b);
      if (!inPad(u.x, u.z, pad, 2.6) && !inPad(midX, midZ, pad, 1.4)) continue;
      const d = dist2(u.x, u.z, b.x, b.z);
      if (d < bestD) {
        bestD = d;
        bx = b.x;
        bz = b.z;
        found = true;
      }
    }
    for (const t of this.trees) {
      if (!t.alive) continue;
      const d = dist2(u.x, u.z, t.x, t.z);
      if (d < 3.4 * 3.4 && d < bestD) {
        bestD = d;
        bx = t.x;
        bz = t.z;
        found = true;
      }
    }
    for (const o of this.units) {
      if (o.id === u.id || o.hp <= 0) continue;
      const d = dist2(u.x, u.z, o.x, o.z);
      if (d < 0.72 * 0.72 && d < bestD) {
        bestD = d;
        bx = o.x;
        bz = o.z;
        found = true;
      }
    }
    let dx = u.x - bx;
    let dz = u.z - bz;
    let len = Math.hypot(dx, dz);
    if (!found || len < 1e-4) {
      dx = dest.x - u.x;
      dz = dest.z - u.z;
      len = Math.hypot(dx, dz);
      if (len < 1e-4) return null;
    }
    dx /= len;
    dz /= len;
    const sides: [number, number][] = [
      [-dz, dx],
      [dz, -dx],
    ];
    let best: Cell | null = null;
    let bestScore = 1e9;
    for (const [px, pz] of sides) {
      for (const dist of [1.4, 2.1, 2.8]) {
        const x = u.x + px * dist;
        const z = u.z + pz * dist;
        if (!this.world.walkableAt(x, z)) continue;
        const score = dist2(x, z, dest.x, dest.z);
        if (score < bestScore) {
          bestScore = score;
          best = { x, z };
        }
      }
    }
    return best;
  }

  unstick(u: Unit): void {
    if (u.job === "chop" && u.channel > 0) return;
    if (u.job === "train" && u.channel > 0) return;
    if (u.kind === "preacher" && u.channel > 0) return;
    const dest = this.goalCell(u);
    if (!dest) return;
    const via = this.detourAround(u, dest);
    u.path = [];
    u.pathI = 0;
    let path: Cell[] = [];
    if (via && dist2(via.x, via.z, dest.x, dest.z) > 0.16) {
      const a = astar(this.world, u.x, u.z, via.x, via.z);
      const b = astar(this.world, via.x, via.z, dest.x, dest.z);
      if (a.length && b.length) path = a.concat(b);
      else if (b.length) path = b;
      else path = a;
    }
    if (!path.length) path = astar(this.world, u.x, u.z, dest.x, dest.z);
    if (!path.length) path = [{ x: dest.x, z: dest.z }];
    u.path = path;
    u.pathI = 0;
  }

  watchStuck(): void {
    const now = this.time;
    const live = new Set<number>();
    for (const u of this.units) live.add(u.id);
    for (const id of [...this.stuckWatch.keys()]) {
      if (!live.has(id)) this.stuckWatch.delete(id);
    }
    for (const u of this.units) {
      if (u.hp <= 0 || u.homeId > 0) continue;
      if (u.flyVy !== 0 || u.y > this.world.heightAt(u.x, u.z) + 0.08) continue;
      const going =
        u.path.length > 0 ||
        u.job === "move" ||
        u.job === "haul" ||
        (u.job === "chop" && u.channel <= 0) ||
        (u.job === "train" && u.channel <= 0);
      if (!going) {
        this.stuckWatch.set(u.id, { x: u.x, z: u.z, t: now });
        continue;
      }
      const prev = this.stuckWatch.get(u.id);
      if (!prev) {
        this.stuckWatch.set(u.id, { x: u.x, z: u.z, t: now });
        continue;
      }
      const moved = Math.hypot(u.x - prev.x, u.z - prev.z);
      if (moved >= 0.08) {
        this.stuckWatch.set(u.id, { x: u.x, z: u.z, t: now });
        continue;
      }
      if (now - prev.t >= 1.0) {
        this.unstick(u);
        this.stuckWatch.set(u.id, { x: u.x, z: u.z, t: now });
      }
    }
  }

  resolveCollisions(): void {
    for (const u of this.units) {
      if (u.homeId > 0) continue;
      if (u.flyVy !== 0 || u.y > this.world.heightAt(u.x, u.z) + 0.08) continue;
      const r = UNIT_RADIUS[u.kind];
      const holdTrain = u.job === "train" && u.channel > 0;
      if (!this.world.walkableAt(u.x, u.z) && !holdTrain) {
        const dest = this.goalCell(u);
        const keep = !!(dest && (u.path.length || u.job === "move" || u.targetId || u.settleX >= 0));
        const safe = nearestLand(this.world, u.x, u.z);
        if (safe) {
          u.x = safe.x;
          u.z = safe.z;
        }
        if (keep && dest) this.repathKeepJob(u, dest);
        else {
          u.path = [];
          u.pathI = 0;
        }
      }
      for (const b of this.buildings) {
        if (b.hp <= 0) continue;
        if (holdTrain) continue;
        const pad = this.buildingPad(b);
        if (inDoorSlit(u.x, u.z, pad)) continue;
        const pushed = pushCircleFromPad(u.x, u.z, r, pad);
        u.x = pushed.x;
        u.z = pushed.z;
      }
      for (const t of this.trees) {
        if (!t.alive) continue;
        const need = r + TREE_BLOCK_R;
        const dx = u.x - t.x;
        const dz = u.z - t.z;
        const d2 = dx * dx + dz * dz;
        if (d2 < 1e-10) {
          u.x += need;
          continue;
        }
        if (d2 >= need * need) continue;
        const d = Math.sqrt(d2);
        const push = (need - d) / d;
        u.x += dx * push;
        u.z += dz * push;
      }
    }
    const n = this.units.length;
    for (let i = 0; i < n; i++) {
      const a = this.units[i]!;
      if (a.homeId > 0) continue;
      const ra = UNIT_RADIUS[a.kind];
      for (let j = i + 1; j < n; j++) {
        const b = this.units[j]!;
        if (b.homeId > 0) continue;
        const rb = UNIT_RADIUS[b.kind];
        const dx = a.x - b.x;
        const dz = a.z - b.z;
        const d2 = dx * dx + dz * dz;
        const need = ra + rb;
        if (d2 >= need * need || d2 < 1e-8) continue;
        const d = Math.sqrt(d2);
        const push = ((need - d) / d) * 0.5;
        a.x += dx * push;
        a.z += dz * push;
        b.x -= dx * push;
        b.z -= dz * push;
      }
      a.x = clamp(a.x, 0.3, WORLD - 0.3);
      a.z = clamp(a.z, 0.3, WORLD - 0.3);
    }
    for (const u of this.units) {
      if (u.job !== "train" || !u.targetId) continue;
      const camp = this.buildingById(u.targetId);
      if (!camp) continue;
      const queue = this.trainQueue(camp.id);
      const slot = queue.findIndex((o) => o.id === u.id);
      if (slot < 0) continue;
      const dest = this.trainSlotPos(camp, slot);
      if (dist2(u.x, u.z, dest.x, dest.z) < 0.55 * 0.55) {
        u.x += (dest.x - u.x) * 0.85;
        u.z += (dest.z - u.z) * 0.85;
      }
    }
  }

  hurtBuilding(b: Building, dmg: number): void {
    if (!b.shell && b.level >= 1 && b.hp - dmg <= 0) {
      b.shell = true;
      b.hp = Math.max(1, b.maxHp * 0.4);
      if (b.team === BLUE && (b.kind === "hut" || isCampKind(b.kind))) this.toast("一座屋宇被拆成骨架");
      return;
    }
    b.hp -= dmg;
  }

  combat(dt: number): void {
    for (const u of this.units) {
      if (!isTribe(u.team) || u.hp <= 0 || u.homeId > 0) continue;
      if (!u.atkId) continue;

      const tu = this.unitById(u.atkId);
      if (tu) {
        const meleeR = 0.95;
        if (dist2(u.x, u.z, tu.x, tu.z) <= meleeR * meleeR) {
          tu.hp -= 2.2 * dt;
          if (tu.hp <= 0) u.atkId = 0;
        }
        continue;
      }

      const b = this.buildingById(u.atkId);
      if (!b) {
        u.atkId = 0;
        continue;
      }
      const reach = Math.max(b.padW, b.padD) * 0.5 + 0.95;
      if (dist2(u.x, u.z, b.x, b.z) > reach * reach) continue;
      this.hurtBuilding(b, 3.4 * dt);
      if (b.hp <= 0) u.atkId = 0;
    }
  }

  preach(u: Unit, dt: number): void {
    const reach2 = 1.25 * 1.25;
    let tgt: Unit | null = null;
    let bestD = reach2;
    const enemy: Team = u.team === BLUE ? RED : BLUE;
    for (const o of this.units) {
      if (o.id === u.id) continue;
      const foe = o.team === enemy || o.team === NEUTRAL;
      if (!foe || !canConvert(o.kind)) continue;
      const d = dist2(u.x, u.z, o.x, o.z);
      if (d < bestD) {
        bestD = d;
        tgt = o;
      }
    }
    if (!tgt) {
      u.channel = 0;
      u.channelId = 0;
      return;
    }
    u.path = [];
    if (u.channelId !== tgt.id) {
      u.channel = 0;
      u.channelId = tgt.id;
    }
    u.channel += dt;
    if (u.channel < 1.35) return;
    u.channel = 0;
    u.channelId = 0;
    tgt.team = u.team;
    tgt.kind = "walker";
    tgt.str = Math.max(1, tgt.str);
    tgt.hp = tgt.maxHp = unitHp("walker", tgt.str);
    tgt.order = this.teams[u.team as Team].order;
    tgt.path = [];
    tgt.pathI = 0;
    tgt.think = 0;
    tgt.channel = 0;
    tgt.channelId = 0;
    tgt.selected = false;
    tgt.disguise = null;
    tgt.carry = 0;
    tgt.job = "idle";
    tgt.targetId = 0;
    tgt.atkId = 0;
    tgt.trainKind = null;
    tgt.foundKind = null;
    this.toast(u.team === BLUE ? "一名敌人皈依" : "一名子民被感化");
  }

  nearestConvertible(u: Unit): Unit | null {
    const enemy: Team = u.team === BLUE ? RED : BLUE;
    let best: Unit | null = null;
    let bestD = 1e9;
    for (const o of this.units) {
      if (o.id === u.id) continue;
      if (!canConvert(o.kind)) continue;
      if (o.team !== enemy && o.team !== NEUTRAL) continue;
      let d = dist2(u.x, u.z, o.x, o.z);
      if (o.kind === "walker" || o.kind === "wildman") d *= 0.65;
      if (d < bestD) {
        bestD = d;
        best = o;
      }
    }
    return best;
  }

  pushUnit(u: Unit, fromX: number, fromZ: number, dist: number): void {
    let dx = u.x - fromX;
    let dz = u.z - fromZ;
    const len = Math.hypot(dx, dz) || 1;
    dx /= len;
    dz /= len;
    const steps = 10;
    let x = u.x;
    let z = u.z;
    for (let i = 1; i <= steps; i++) {
      const tx = u.x + dx * dist * (i / steps);
      const tz = u.z + dz * dist * (i / steps);
      if (!this.world.walkableAt(tx, tz)) break;
      x = tx;
      z = tz;
    }
    u.x = clamp(x, 0.3, WORLD - 0.3);
    u.z = clamp(z, 0.3, WORLD - 0.3);
    u.path = [];
    u.pathI = 0;
    u.think = 0.15;
  }

  closestEnemyUnit(u: Unit, enemy: Team, range: number): Unit | null {
    let best: Unit | null = null;
    let bestD = range * range;
    for (const o of this.units) {
      if (o.team !== enemy) continue;
      const d = dist2(u.x, u.z, o.x, o.z);
      if (d < bestD) {
        bestD = d;
        best = o;
      }
    }
    return best;
  }

  projectiles(dt: number): void {
    for (const p of this.shots) {
      p.x += p.vx * dt;
      p.z += p.vz * dt;
      p.life -= dt;
      const enemy: Team = p.team === BLUE ? RED : BLUE;
      for (const u of this.units) {
        if (u.team !== enemy) continue;
        if (dist2(p.x, p.z, u.x, u.z) < 0.28) {
          u.hp -= p.dmg;
          if (p.knock > 0) this.pushUnit(u, p.ox, p.oz, p.knock);
          p.life = 0;
          break;
        }
      }
      if (p.life > 0) {
        const b = this.buildingAt(p.x, p.z);
        if (b && b.team === enemy) {
          b.hp -= p.dmg;
          p.life = 0;
        }
      }
    }
    this.shots = this.shots.filter((p) => p.life > 0);
  }

  hazards(dt: number): void {
    if (this.review) return;
    for (const u of this.units) {
      if (!inMap(u.x, u.z) || this.world.heightAt(u.x, u.z) <= WATER) {
        u.hp -= 4 * dt;
        continue;
      }
      const i = this.world.sampleAt(u.x, u.z);
      if (this.world.lava[i]! > 0) {
        u.hp -= 10 * dt;
        if (!this.lavaHurt && u.team === BLUE) {
          this.lavaHurt = true;
          this.toast(u.kind === "shaman" ? "祭司被岩浆烫伤" : "一名子民被岩浆烫伤");
        }
      }
      if (this.world.swamp[i]! > 0) {
        u.swampT += dt;
        if (u.swampT >= 5) {
          u.hp = 0;
          this.swampKill = true;
          this.swampKillX = u.x;
          this.swampKillZ = u.z;
          if (u.team === BLUE) this.toast(u.kind === "shaman" ? "祭司死于毒气" : "一名子民死于毒气");
        }
      } else {
        u.swampT = 0;
      }
    }
  }

  holdPadsNearVolcano(): void {
    const v = this.volcano;
    if (!v) return;
    for (const b of this.buildings) {
      if (b.hp <= 0 || b.kind === "rebirth") continue;
      if (Math.hypot(b.x - v.x, b.z - v.z) < 2.8) continue;
      const h = Math.max(this.world.heightAt(b.x, b.z), 0.8);
      this.world.flattenPad(b.x, b.z, b.padW, b.padD, b.yaw, h);
      b.y = this.world.heightAt(b.x, b.z);
    }
  }

  lavaOnPad(b: Building): boolean {
    const pts: [number, number][] = [
      [b.x, b.z],
      [b.x + b.padW * 0.35, b.z],
      [b.x - b.padW * 0.35, b.z],
      [b.x, b.z + b.padD * 0.35],
      [b.x, b.z - b.padD * 0.35],
    ];
    for (const [x, z] of pts) {
      if (this.world.lava[this.world.sampleAt(x, z)]! > 0) return true;
    }
    return false;
  }

  burnBuildings(dt: number): void {
    for (const b of this.buildings) {
      if (b.hp <= 0 || b.kind === "rebirth") continue;
      if (!this.lavaOnPad(b)) continue;
      if (!b.shell) {
        b.shell = true;
        b.hp = Math.max(1, b.maxHp * 0.4);
        if (b.team === BLUE && (b.kind === "hut" || isCampKind(b.kind))) this.toast("一座屋宇烧成骨架");
      } else {
        b.hp -= 4 * dt;
      }
    }
  }





  blastAt(x: number, z: number): void {
    this.blast = { x, z, t: 0, life: 0.8 };
    this.fxShake = Math.max(this.fxShake, 0.3);
    this.blastHit = false;
    for (const u of this.units) {
      if (u.hp <= 0) continue;
      const d = Math.hypot(u.x - x, u.z - z);
      if (d > 1.7) continue;
      let dx = u.x - x;
      let dz = u.z - z;
      const len = Math.hypot(dx, dz) || 1;
      dx /= len;
      dz /= len;
      u.fireT = 0;
      u.flyVx = dx * 4.6;
      u.flyVz = dz * 4.6;
      u.flyVy = 5.8;
      u.y = this.world.heightAt(u.x, u.z) + 0.35;
      u.path = [];
      u.pathI = 0;
      u.think = 1.2;
      this.blastHit = true;
      this.blastHitX = u.x;
      this.blastHitZ = u.z;
      this.blastFlyer = { x: u.x, y: u.y, z: u.z };
      if (u.team === BLUE) this.toast(u.kind === "shaman" ? "祭司被气浪打飞" : "一名子民被气浪打飞");
    }
  }

  tickBlast(dt: number): void {
    if (!this.blast) return;
    this.blast.t += dt;
    if (this.blast.t > this.blast.life) this.blast = null;
  }

  strikeLightning(x: number, z: number): void {
    this.fxBolts.push({ x0: x, z0: z, x1: x, z1: z, life: 0.9 });
    this.fxShake = Math.max(this.fxShake, 0.5);
    this.lightningHit = false;
    this.lightningHouse = false;
    for (const u of this.units) {
      if (u.hp <= 0) continue;
      const d = Math.hypot(u.x - x, u.z - z);
      if (d > 1.7) continue;
      let dx = u.x - x;
      let dz = u.z - z;
      const len = Math.hypot(dx, dz) || 1;
      dx /= len;
      dz /= len;
      u.fireT = 3.6;
      u.flyVx = dx * (4.4 + Math.random() * 0.6);
      u.flyVz = dz * (4.4 + Math.random() * 0.6);
      u.flyVy = 5.6;
      u.y = this.world.heightAt(u.x, u.z) + 1.55;
      u.hp = Math.max(1, u.hp - 8);
      u.path = [];
      u.pathI = 0;
      u.think = 1.2;
      this.lightningHit = true;
      this.lightningHitX = u.x;
      this.lightningHitZ = u.z;
      if (u.team === BLUE) this.toast(u.kind === "shaman" ? "祭司被雷打飞" : "一名子民被雷打飞");
    }
    for (const b of this.buildings) {
      if (b.hp <= 0 || b.kind === "rebirth") continue;
      const d = Math.hypot(b.x - x, b.z - z);
      if (d > 2.2 && !inPad(x, z, this.buildingPad(b), 0.25)) continue;
      if (!b.shell) {
        b.shell = true;
        b.hp = Math.max(1, b.maxHp * 0.4);
        this.lightningHouse = true;
        if (b.team === BLUE && (b.kind === "hut" || isCampKind(b.kind))) this.toast("一座屋宇被劈成骨架");
      } else {
        b.hp = 0;
        this.lightningHouse = true;
      }
    }
  }

  beginTornado(x: number, z: number): boolean {
    if (this.tornado && this.tornado.t < this.tornado.life - 0.4) return false;
    let vx = 1.15;
    let vz = 0.25;
    let best = 99;
    for (const b of this.buildings) {
      if (b.hp <= 0 || b.kind === "rebirth") continue;
      const d = Math.hypot(b.x - x, b.z - z);
      if (d < best && d > 0.4) {
        best = d;
        vx = (b.x - x) / d;
        vz = (b.z - z) / d;
      }
    }
    const spd = 1.35;
    this.tornado = { x, z, vx: vx * spd, vz: vz * spd, t: 0, life: 16, houseT: 0 };
    this.fxShake = Math.max(this.fxShake, 0.22);
    this.tornadoLift = false;
    this.tornadoHouse = false;
    return true;
  }

  tickTornado(dt: number): void {
    const tw = this.tornado;
    if (!tw) return;
    tw.t += dt;
    if (tw.t > tw.life) {
      this.tornado = null;
      return;
    }
    if (tw.t > 3.8 && Math.floor(tw.t / 1.7) !== Math.floor((tw.t - dt) / 1.7)) {
      const ang = Math.atan2(tw.vz, tw.vx) + (Math.random() - 0.5) * 1.1;
      const spd = 1.25 + Math.random() * 0.3;
      tw.vx = Math.cos(ang) * spd;
      tw.vz = Math.sin(ang) * spd;
    }
    let nx = tw.x + tw.vx * dt;
    let nz = tw.z + tw.vz * dt;
    if (!this.world.land(nx, nz) || !inMap(nx, nz)) {
      tw.vx = -tw.vx + (Math.random() - 0.5) * 0.4;
      tw.vz = -tw.vz + (Math.random() - 0.5) * 0.4;
      nx = tw.x + tw.vx * dt;
      nz = tw.z + tw.vz * dt;
      if (!this.world.land(nx, nz)) {
        nx = tw.x;
        nz = tw.z;
      }
    }
    tw.x = nx;
    tw.z = nz;
    for (const u of this.units) {
      if (u.hp <= 0) continue;
      const d = Math.hypot(u.x - tw.x, u.z - tw.z);
      if (d > 1.7) continue;
      if (d > 0.08) {
        u.x += ((tw.x - u.x) / d) * 2.6 * dt;
        u.z += ((tw.z - u.z) / d) * 2.6 * dt;
      }
      const tang = 2.4 * dt;
      u.x += (-(tw.z - u.z) / Math.max(0.12, d)) * tang;
      u.z += ((tw.x - u.x) / Math.max(0.12, d)) * tang;
      u.x = clamp(u.x, 0.3, WORLD - 0.3);
      u.z = clamp(u.z, 0.3, WORLD - 0.3);
      const ground = this.world.heightAt(u.x, u.z);
      u.y = ground + Math.min(2.1, (1.7 - d) * 1.35 + 0.25);
      u.path = [];
      u.pathI = 0;
      u.think = 0.8;
      this.tornadoLift = true;
      this.tornadoLiftX = u.x;
      this.tornadoLiftZ = u.z;
      if (d < 0.62 && u.y > ground + 1.05) {
        u.hp = 0;
        if (u.team === BLUE) this.toast(u.kind === "shaman" ? "祭司被龙卷风卷走" : "一名子民被龙卷风卷走");
      }
    }
    let touching = false;
    for (const b of this.buildings) {
      if (b.hp <= 0 || b.kind === "rebirth") continue;
      const pad = this.buildingPad(b);
      const d = Math.hypot(b.x - tw.x, b.z - tw.z);
      if (d > 2.05 && !inPad(tw.x, tw.z, pad, 0.35)) continue;
      touching = true;
      if (!b.shell) {
        b.shell = true;
        b.hp = Math.max(1, b.maxHp * 0.4);
        tw.houseT = 0;
        this.tornadoHouse = true;
        if (b.team === BLUE && (b.kind === "hut" || isCampKind(b.kind))) this.toast("一座屋宇被卷成骨架");
      } else {
        tw.houseT += dt;
        if (tw.houseT > 0.85) {
          b.hp = 0;
          this.tornadoHouse = true;
        }
      }
    }
    if (!touching) tw.houseT = Math.max(0, tw.houseT - dt);
  }

  beginQuake(x: number, z: number): boolean {
    if (this.quake && this.quake.t < this.quake.dur + 0.35) return false;
    this.quake = {
      x,
      z,
      t: 0,
      dur: 2.0,
      angs: [3.86, 5.96, 1.76],
      lens: [4.6, 4.4, 4.8],
      opened: [0, 0, 0],
    };
    this.fxQuake = { x, z };
    this.fxShake = Math.max(this.fxShake, 0.45);
    return true;
  }

  crackPoint(q: { x: number; z: number; angs: number[] }, k: number, s: number): { x: number; z: number } {
    const ang = q.angs[k]!;
    const wob = Math.sin(s * 2.1 + k * 1.3) * 0.22;
    const c = Math.cos(ang);
    const si = Math.sin(ang);
    return { x: q.x + c * s - si * wob, z: q.z + si * s + c * wob };
  }

  nearestOpenCrack(x: number, z: number): { d: number; x: number; z: number } {
    const q = this.quake;
    let best = { d: 99, x, z };
    if (!q) return best;
    for (let k = 0; k < q.angs.length; k++) {
      const opened = q.opened[k]!;
      if (opened < 0.08) continue;
      for (let s = 0; s <= opened; s += 0.18) {
        const p = this.crackPoint(q, k, s);
        const d = Math.hypot(p.x - x, p.z - z);
        if (d < best.d) best = { d, x: p.x, z: p.z };
      }
    }
    return best;
  }

  tickQuake(dt: number): void {
    const q = this.quake;
    if (!q) return;
    q.t += dt;
    const prog = Math.min(1, q.t / q.dur);
    for (let k = 0; k < q.angs.length; k++) {
      const target = q.lens[k]! * prog;
      const prev = q.opened[k]!;
      if (target > prev) {
        for (let s = prev; s < target; s += 0.14) {
          const p = this.crackPoint(q, k, s);
          this.world.sinkTrench(p.x, p.z, 0.64, 0.4);
        }
        const tip = this.crackPoint(q, k, target);
        this.world.sinkTrench(tip.x, tip.z, 0.64, 0.4);
        q.opened[k] = target;
      }
    }
    this.slideIntoCracks(dt);
    this.collapseCutHouses();
    if (q.t > q.dur + 4) this.quake = null;
  }

  slideIntoCracks(dt: number): void {
    const q = this.quake;
    if (!q || q.t < 0.12) return;
    for (const u of this.units) {
      if (u.hp <= 0) continue;
      const n = this.nearestOpenCrack(u.x, u.z);
      if (n.d > 0.9) continue;
      if (n.d > 0.02) {
        const nx = (n.x - u.x) / n.d;
        const nz = (n.z - u.z) / n.d;
        const spd = 2.6 * (1 - n.d / 0.9);
        u.x = clamp(u.x + nx * spd * dt, 0.3, WORLD - 0.3);
        u.z = clamp(u.z + nz * spd * dt, 0.3, WORLD - 0.3);
        u.y = this.world.heightAt(u.x, u.z);
        u.path = [];
        u.pathI = 0;
        u.think = 1.2;
      }
      const rim = this.world.heightAt(u.x + 0.55, u.z);
      const here = this.world.heightAt(u.x, u.z);
      if (q.t > 1.38 && n.d < 0.28 && (here < WATER + 0.06 || rim - here > 0.22)) {
        u.hp = 0;
        this.quakeKill = true;
        this.quakeKillX = u.x;
        this.quakeKillZ = u.z;
        if (u.team === BLUE) this.toast(u.kind === "shaman" ? "祭司坠入地缝" : "一名子民坠入地缝");
      }
    }
  }

  collapseCutHouses(): void {
    const q = this.quake;
    if (!q) return;
    for (const b of this.buildings) {
      if (b.hp <= 0 || b.kind === "rebirth") continue;
      const pad = this.buildingPad(b);
      let hit = false;
      for (let k = 0; k < q.angs.length && !hit; k++) {
        const opened = q.opened[k]!;
        for (let s = 0; s <= opened; s += 0.22) {
          const p = this.crackPoint(q, k, s);
          if (inPad(p.x, p.z, pad, 0.22)) {
            hit = true;
            break;
          }
        }
      }
      if (!hit) continue;
      b.hp = 0;
      this.quakeHutDown = true;
    }
  }

  beginVolcano(x: number, z: number): boolean {
    if (this.volcano && this.volcano.t < this.volcano.dur + 1.2) return false;
    this.volcano = { x, z, t: 0, dur: 2.6 };
    this.fxShake = Math.max(this.fxShake, 0.28);
    return true;
  }

  tickVolcano(dt: number): void {
    const v = this.volcano;
    if (v) {
      v.t += dt;
      if (v.t <= v.dur) {
        this.world.sculpt(v.x, v.z, 2.5, 1.35 * dt);
        this.world.sculpt(v.x, v.z, 1.05, 0.45 * dt);
      }
      if (v.t > 1.1 && v.t <= v.dur + 2.0) {
        const reach = 5 + Math.floor((v.t - 1.1) * 6);
        this.world.growRivers(v.x, v.z, Math.min(12, reach));
        this.world.seedLava(v.x, v.z, 0.22, 3.8);
      }
      if (v.t > v.dur + 8) this.volcano = null;
      this.holdPadsNearVolcano();
    }
    this.burnBuildings(dt);
  }

  mergeWalkers(): void {
    if (this.freezeMerge) return;
    const walkers = this.units.filter((u) => u.kind === "walker" && u.homeId === 0 && u.str < 3 && u.job !== "train" && u.carry === 0);
    for (let i = 0; i < walkers.length; i++) {
      const a = walkers[i]!;
      if (a.hp <= 0) continue;
      for (let j = i + 1; j < walkers.length; j++) {
        const b = walkers[j]!;
        if (b.hp <= 0 || a.team !== b.team) continue;
        if (dist2(a.x, a.z, b.x, b.z) > 0.36) continue;
        a.str = Math.min(3, a.str + b.str);
        a.hp = a.maxHp = unitHp("walker", a.str);
        b.hp = 0;
        if (a.team === BLUE) this.toast("两名子民合为更强的行者");
        break;
      }
    }
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
    if (this.lockWin) return;
    if (this.time < 20) return;
    const blueDead = this.countPop(BLUE) === 0 && this.countHouses(BLUE) === 0;
    const redDead = this.countPop(RED) === 0 && this.countHouses(RED) === 0;
    if (blueDead && redDead) this.winner = -1;
    else if (blueDead) this.winner = RED;
    else if (redDead) this.winner = BLUE;
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
