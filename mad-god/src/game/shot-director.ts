import { Sim } from "./sim";
import { BLUE, BuildingKind, houseHp, isCampKind, RED, WORLD } from "./types";
import { inPad, worldOnPad, World } from "./world";
import { View } from "./render";
import { HUD } from "./ui";

export interface ShotDirectorHost {
  world: World;
  sim: Sim;
  view: View;
  hud: HUD;
  paused: boolean;
  ended: boolean;
  clearPlace(): void;
}

export class ShotDirector {
  host: ShotDirectorHost;
  shotHeld = false;
  shotBeat = 0;
  shotVictimId = 0;
  shotSafeId = 0;
  shotWalkerId = 0;
  shotHutX = 0;
  shotHutZ = 0;
  shotBlastX = 0;
  shotBlastZ = 0;
  houseShamanArmed = false;
  pathWalkerArmed = false;
  shotStartX = 0;
  shotStartZ = 0;
  fightHoverX = 0;
  fightHoverZ = 0;
  fightHoverMode: "off" | "fight" = "off";

  constructor(host: ShotDirectorHost) {
    this.host = host;
  }

  get sim(): Sim {
    return this.host.sim;
  }

  get world(): World {
    return this.host.world;
  }

  get view(): View {
    return this.host.view;
  }

  get hud(): HUD {
    return this.host.hud;
  }

  get paused(): boolean {
    return this.host.paused;
  }

  set paused(v: boolean) {
    this.host.paused = v;
  }

  get ended(): boolean {
    return this.host.ended;
  }

  reset(): void {
    this.shotHeld = false;
    this.shotBeat = 0;
    this.shotVictimId = 0;
    this.shotSafeId = 0;
    this.shotWalkerId = 0;
    this.shotHutX = 0;
    this.shotHutZ = 0;
    this.shotBlastX = 0;
    this.shotBlastZ = 0;
    this.houseShamanArmed = false;
    this.pathWalkerArmed = false;
    this.shotStartX = 0;
    this.shotStartZ = 0;
    this.fightHoverX = 0;
    this.fightHoverZ = 0;
    this.fightHoverMode = "off";
  }

  onBuildingFound(made: { x: number; z: number; kind: BuildingKind; need: number; wood: number }): void {
    if (
      typeof location !== "undefined" &&
      (location.search.includes("shot=house") || location.search.includes("shot=path")) &&
      made.kind === "hut"
    ) {
      this.shotHutX = made.x;
      this.shotHutZ = made.z;
    }
    if (typeof location !== "undefined" && location.search.includes("shot=1") && made.kind === "hut") {
      made.need = 8;
    }
    if (typeof location !== "undefined" && location.search.includes("shot=1") && isCampKind(made.kind)) {
      made.wood = made.need;
      this.sim.completeStep(made as any);
    }
  }

  isShotActive(): boolean {
    return (
      typeof location !== "undefined" &&
      (location.search.includes("shot=1") ||
        location.search.includes("shot=swamp") ||
        location.search.includes("shot=volcano") ||
        location.search.includes("shot=quake") ||
        location.search.includes("shot=skel") ||
        location.search.includes("shot=tornado") ||
        location.search.includes("shot=lightning") ||
        location.search.includes("shot=blast") ||
        location.search.includes("shot=house") ||
        location.search.includes("shot=path") ||
        location.search.includes("shot=live") ||
        location.search.includes("shot=fight"))
    );
  }

  handleUrlParams(): void {
    this.applyReviewCheats();
  }

  applyReviewCheats(): void {
    if (typeof location === "undefined") return;
    if (location.search.includes("god=1")) {
      this.sim.review = true;
      const t = this.sim.teams[0];
      t.manaCap = Math.max(t.manaCap, 200);
      t.mana = Math.max(t.mana, 999);
    }
    if (location.search.includes("shot=fight4")) this.applyFightSetup(3);
    else if (location.search.includes("shot=fight3")) this.applyFightSetup(2);
    else if (location.search.includes("shot=fight2")) this.applyFightSetup(1);
    else if (location.search.includes("shot=fight")) this.applyFightSetup(0);
    else if (location.search.includes("shot=live4")) this.applyLiveSetup(3);
    else if (location.search.includes("shot=live3")) this.applyLiveSetup(2);
    else if (location.search.includes("shot=live2")) this.applyLiveSetup(1);
    else if (location.search.includes("shot=live")) this.applyLiveSetup(0);
    else if (location.search.includes("shot=path3")) this.applyPathSetup(2);
    else if (location.search.includes("shot=path2")) this.applyPathSetup(1);
    else if (location.search.includes("shot=path")) this.applyPathSetup(0);
    else if (location.search.includes("shot=house3")) this.applyHouseSetup(2);
    else if (location.search.includes("shot=house4")) this.applyHouseSetup(3);
    else if (location.search.includes("shot=house")) this.applyHouseSetup(0);
    else if (location.search.includes("shot=blast")) this.applyBlastSetup();
    else if (location.search.includes("shot=lightning")) this.applyLightningSetup();
    else if (location.search.includes("shot=tornado")) this.applyTornadoSetup();
    else if (location.search.includes("shot=skel")) this.applySkelSetup();
    else if (location.search.includes("shot=quake")) this.applyQuakeSetup();
    else if (location.search.includes("shot=volcano")) this.applyVolcanoSetup();
    else if (location.search.includes("shot=swamp")) this.applySwampSetup();
    else if (location.search.includes("shot=1")) this.applyShotSetup();
  }

  applyShotSetup(): void {
    this.sim.freezeMerge = true;
    this.sim.lockWin = true;
    this.host.clearPlace();
    let hutN = 0;
    for (const b of this.sim.buildings) {
      if (b.team !== BLUE || b.kind !== "hut") continue;
      b.level = 1;
      b.hp = b.maxHp = houseHp(1);
      b.wood = 0;
      b.need = hutN === 0 ? 0 : 16;
      hutN++;
    }
    const s = this.world.startPad(BLUE);
    const toCx = WORLD * 0.5 - s.x;
    const toCz = WORLD * 0.5 - s.z;
    const len = Math.hypot(toCx, toCz) || 1;
    const fx = toCx / len;
    const fz = toCz / len;
    const px = -fz;
    const pz = fx;
    const offsets: Array<[number, number]> = [
      [12.0, 0],
      [11.0, 2.8],
      [11.0, -2.8],
      [13.0, 1.6],
      [10.0, 0],
      [8.0, 0],
    ];
    let campX = s.x + fx * 12;
    let campZ = s.z + fz * 12;
    for (const [a, b] of offsets) {
      const x = s.x + fx * a + px * b;
      const z = s.z + fz * a + pz * b;
      this.sim.tryPrepFound(x, z, s.yaw);
      if (this.sim.canFound(x, z, 1, s.yaw)) {
        campX = x;
        campZ = z;
        break;
      }
    }
    this.sim.placeComplete(BLUE, campX, campZ, s.yaw, "warriorHut", 1);
    const camp = this.sim.buildings.find((b) => b.team === BLUE && b.kind === "warriorHut" && b.hp > 0)!;
    for (const b of this.sim.buildings) {
      if (b.team !== BLUE || b.kind !== "hut" || b.hp <= 0) continue;
      const dx = b.x - camp.x;
      const dz = b.z - camp.z;
      const d = Math.hypot(dx, dz);
      if (d < 7.2 && d > 0.2) {
        const n = 8.2 / d;
        b.x = camp.x + dx * n;
        b.z = camp.z + dz * n;
        if (this.world.heightAt(b.x, b.z) <= 0.2) {
          b.x = camp.x - fx * 8.2;
          b.z = camp.z - fz * 8.2;
        }
        b.y = this.world.heightAt(b.x, b.z);
      }
    }
    const have = this.sim.units.filter((u) => u.team === BLUE && u.kind === "walker");
    while (have.length < 4) have.push(this.sim.addUnit(BLUE, "walker", camp.x + 3, camp.z));
    const sh = this.sim.units.find((u) => u.team === BLUE && u.kind === "shaman");
    if (sh) {
      sh.x = s.x + 0.4;
      sh.z = s.z + 1.6;
      sh.y = this.world.heightAt(sh.x, sh.z);
      sh.selected = false;
    }
    while (have.length < 6) have.push(this.sim.addUnit(BLUE, "walker", camp.x + 3, camp.z));
    for (let i = 0; i < 5; i++) {
      const slot = this.sim.trainSlotPos(camp, i);
      const ox = slot.x - camp.x;
      const oz = slot.z - camp.z;
      const n = Math.hypot(ox, oz) || 1;
      const w = have[i]!;
      w.x = slot.x;
      w.z = slot.z;
      w.y = this.world.heightAt(w.x, w.z);
      w.job = "idle";
      w.carry = 0;
      w.channel = 0;
      w.path = [{ x: w.x, z: w.z }];
      w.pathI = 0;
      w.think = 20;
      w.selected = false;
      w.targetId = 0;
      w.trainKind = null;
    }
    const chop = have[5]!;
    const near = this.sim.trees
      .filter((t) => t.alive)
      .map((t) => ({ t, d: Math.hypot(t.x - campX, t.z - campZ) }))
      .filter((o) => o.d > 2.8 && o.d < 7.5)
      .sort((a, b) => a.d - b.d);
    const tree = near[0]?.t ?? this.sim.nearestTree(campX - fx * 4 + px * 4, campZ - fz * 4 + pz * 4);
    if (tree) {
      chop.x = tree.x + 0.55;
      chop.z = tree.z + 0.35;
      chop.y = this.world.heightAt(chop.x, chop.z);
      chop.job = "chop";
      chop.targetId = tree.id;
      chop.channel = 0.2;
      chop.path = [];
      chop.think = 20;
      chop.selected = false;
      chop.carry = 0;
    }
    this.sim.markHouseBlocks();
    for (let i = 0; i < 5; i++) have[i]!.selected = true;
    this.sim.train(BLUE, "warrior");
    this.shotBeat = 0;
    this.view.rebuildTerrain();
    this.view.jump(campX, campZ);
    this.host.clearPlace();
  }

  applySwampSetup(): void {
    this.sim.freezeMerge = true;
    this.sim.freezeProd = true;
    this.sim.lockWin = true;
    this.sim.review = true;
    const t = this.sim.teams[BLUE];
    t.manaCap = Math.max(t.manaCap, 200);
    t.mana = Math.max(t.mana, 200);
    this.host.clearPlace();
    const s = this.world.startPad(BLUE);
    const toCx = WORLD * 0.5 - s.x;
    const toCz = WORLD * 0.5 - s.z;
    const len = Math.hypot(toCx, toCz) || 1;
    const fx = toCx / len;
    const fz = toCz / len;
    const px = -fz;
    const pz = fx;
    let aimX = s.x + fx * 9.2;
    let aimZ = s.z + fz * 9.2;
    for (const a of [9.2, 8.0, 10.4, 7.2, 11.6]) {
      const x = s.x + fx * a;
      const z = s.z + fz * a;
      if (this.world.heightAt(x, z) > 0.55 && this.world.slopeAt(x, z) < 0.35) {
        aimX = x;
        aimZ = z;
        break;
      }
    }
    const walkers = this.sim.units.filter((u) => u.team === BLUE && u.kind === "walker");
    while (walkers.length < 3) walkers.push(this.sim.addUnit(BLUE, "walker", aimX, aimZ));
    const stand = [
      [aimX - fx * 2.7 - px * 0.35, aimZ - fz * 2.7 - pz * 0.35],
      [aimX - fx * 2.5 + px * 0.85, aimZ - fz * 2.5 + pz * 0.85],
      [aimX - fx * 2.8 + px * 0.2, aimZ - fz * 2.8 + pz * 0.2],
    ];
    for (let i = 0; i < 3; i++) {
      const w = walkers[i]!;
      w.x = stand[i]![0];
      w.z = stand[i]![1];
      w.y = this.world.heightAt(w.x, w.z);
      w.job = "idle";
      w.carry = 0;
      w.channel = 0;
      w.path = [];
      w.pathI = 0;
      w.think = 8;
      w.selected = false;
      w.swampT = 0;
    }
    const chop = walkers[2]!;
    const near = this.sim.trees
      .filter((tr) => tr.alive)
      .map((tr) => ({ tr, d: Math.hypot(tr.x - aimX, tr.z - aimZ) }))
      .filter((o) => o.d > 2.8 && o.d < 4.6)
      .sort((a, b) => a.d - b.d);
    let tree = near[0]?.tr ?? this.sim.nearestTree(aimX + px * 4.2, aimZ + pz * 4.2);
    if (tree) {
      const td = Math.hypot(tree.x - aimX, tree.z - aimZ);
      if (td < 2.6 || td > 4.4) {
        tree.x = aimX + px * 3.3;
        tree.z = aimZ + pz * 3.3;
      }
      chop.x = tree.x + 0.5;
      chop.z = tree.z + 0.3;
      chop.y = this.world.heightAt(chop.x, chop.z);
      chop.job = "chop";
      chop.targetId = tree.id;
      chop.channel = 0.15;
      chop.path = [];
      chop.think = 30;
      chop.selected = false;
      chop.carry = 0;
    }
    const sh = this.sim.units.find((u) => u.team === BLUE && u.kind === "shaman");
    if (sh) {
      sh.x = s.x + 0.5;
      sh.z = s.z + 1.4;
      sh.y = this.world.heightAt(sh.x, sh.z);
      sh.selected = false;
    }
    this.shotBeat = 0;
    this.view.rebuildTerrain();
    this.view.jump(aimX, aimZ);
    this.view.dist = 9;
    this.view.pitch = 0.88;
    this.host.clearPlace();
    this.sim.toast("点沼泽图标，再点眼前这块草地");
  }

  maybeHoldSwamp(): void {
    if (typeof location === "undefined" || !location.search.includes("shot=swamp")) return;
    if (this.ended) return;
    const swampN = this.world.swamp.reduce((n, v) => n + (v > 0 ? 1 : 0), 0);
    const stuck = this.sim.units.filter((u) => u.hp > 0 && this.sim.inSwamp(u));
    const outsider = this.sim.units.find(
      (u) => u.team === BLUE && u.kind === "walker" && u.hp > 0 && !this.sim.inSwamp(u) && (u.job === "chop" || u.job === "train"),
    );
    if (this.shotBeat === 0 && swampN > 4 && !this.paused) {
      this.paused = true;
      this.shotBeat = 1;
      this.view.jump(this.world.lastSwampX, this.world.lastSwampZ);
      this.view.dist = 8.5;
      this.sim.toast("拍1 · 枯枝贴地");
      this.hud.toastT = 30;
      return;
    }
    if (this.shotBeat === 1 && !this.paused) {
      if (stuck.length === 0) {
        const cx = this.world.lastSwampX;
        const cz = this.world.lastSwampZ;
        const bait = this.sim.units
          .filter((u) => u.team === BLUE && u.kind === "walker" && u.hp > 0 && u.job !== "chop")
          .sort((a, b) => Math.hypot(a.x - cx, a.z - cz) - Math.hypot(b.x - cx, b.z - cz))[0];
        if (bait) {
          bait.x = cx;
          bait.z = cz;
          bait.y = this.world.heightAt(cx, cz);
          bait.job = "idle";
          bait.path = [];
          bait.think = 40;
          bait.swampT = 1.0;
        }
      }
      if (stuck.length > 0) {
        if (outsider) {
          const cx = this.world.lastSwampX;
          const cz = this.world.lastSwampZ;
          outsider.x = cx + 2.8;
          outsider.z = cz + 1.2;
          outsider.y = this.world.heightAt(outsider.x, outsider.z);
        }
        this.paused = true;
        this.shotBeat = 2;
        this.view.jump(this.world.lastSwampX, this.world.lastSwampZ);
        this.view.dist = 9.2;
        this.sim.toast("拍2 · 陷入挣扎");
        this.hud.toastT = 30;
        return;
      }
    }
    if (this.shotBeat === 2 && !this.paused) {
      const dead = this.sim.swampKill;
      const gone = swampN === 0;
      if (dead || gone) {
        if (dead) this.view.jump(this.sim.swampKillX, this.sim.swampKillZ);
        this.view.dist = 7.2;
        this.paused = true;
        this.shotBeat = 3;
        this.sim.toast(dead ? "拍3 · 毒死" : "拍3 · 沼泽退了");
        this.hud.toastT = 30;
      }
    }
  }

  applyFightSetup(startBeat = 0): void {
    this.sim.freezeMerge = true;
    this.sim.freezeProd = true;
    this.sim.lockWin = true;
    this.host.clearPlace();
    this.sim.units = this.sim.units.filter((u) => u.kind !== "wildman");
    for (const b of this.sim.buildings) {
      if (b.kind === "hut") b.hp = 0;
    }
    this.sim.buildings = this.sim.buildings.filter((b) => b.hp > 0);

    const s = this.world.startPad(BLUE);
    const toCx = WORLD * 0.5 - s.x;
    const toCz = WORLD * 0.5 - s.z;
    const len = Math.hypot(toCx, toCz) || 1;
    const fx = toCx / len;
    const fz = toCz / len;
    const px = -fz;
    const pz = fx;
    let aimX = s.x + fx * 8.4;
    let aimZ = s.z + fz * 8.4;
    for (const a of [8.4, 7.6, 9.2, 6.8]) {
      const x = s.x + fx * a;
      const z = s.z + fz * a;
      if (this.world.heightAt(x, z) > 0.5) {
        aimX = x;
        aimZ = z;
        break;
      }
    }
    this.sim.trees = this.sim.trees.filter((tr) => Math.hypot(tr.x - aimX, tr.z - aimZ) > 6);
    this.world.flattenPad(aimX, aimZ, 3.4, 3.4, s.yaw, Math.max(this.world.heightAt(aimX, aimZ), 0.9));
    const hut = this.sim.placeComplete(RED, aimX, aimZ, s.yaw, "hut", 1);
    hut.dwell = 0;
    hut.born = 0;
    hut.prod = 0;
    hut.wantLevel = 0;
    this.shotHutX = hut.x;
    this.shotHutZ = hut.z;

    const park = (
      u: { x: number; z: number; y: number; job: string; path: unknown[]; pathI: number; think: number; selected: boolean; carry: number; targetId: number; atkId: number; homeId: number; order: string },
      x: number,
      z: number,
    ) => {
      u.x = x;
      u.z = z;
      u.y = this.world.heightAt(x, z);
      u.job = "idle";
      u.path = [];
      u.pathI = 0;
      u.think = 80;
      u.selected = false;
      u.carry = 0;
      u.targetId = 0;
      u.atkId = 0;
      u.homeId = 0;
    };

    const isSafeLand = (x: number, z: number): boolean => {
      if (this.world.heightAt(x, z) <= 0.5) return false;
      if (!this.world.walkableAt(x, z)) return false;
      if (this.sim.buildingAt(x, z)) return false;
      return true;
    };
    const findSafeNear = (ox: number, oz: number): { x: number; z: number } => {
      if (isSafeLand(ox, oz)) return { x: ox, z: oz };
      const step = 0.4;
      for (let r = step; r <= 8; r += step) {
        const n = Math.max(8, Math.round((Math.PI * 2 * r) / step));
        for (let i = 0; i < n; i++) {
          const a = (i / n) * Math.PI * 2;
          const x = ox + Math.cos(a) * r;
          const z = oz + Math.sin(a) * r;
          if (isSafeLand(x, z)) return { x, z };
        }
      }
      return { x: ox, z: oz };
    };

    const shB = this.sim.units.find((u) => u.team === BLUE && u.kind === "shaman");
    const shR = this.sim.units.find((u) => u.team === RED && u.kind === "shaman");
    const homeB = this.world.startPad(BLUE);
    const homeR = this.world.startPad(RED);
    if (shB) park(shB, homeB.x + 0.4, homeB.z + 1.6);
    if (shR) park(shR, homeR.x + 0.4, homeR.z + 1.6);

    let blues = this.sim.units.filter((u) => u.team === BLUE && u.kind === "walker");
    while (blues.length < 1) blues.push(this.sim.addUnit(BLUE, "walker", aimX, aimZ));
    let reds = this.sim.units.filter((u) => u.team === RED && u.kind === "walker");
    while (reds.length < 1) reds.push(this.sim.addUnit(RED, "walker", aimX, aimZ));
    const keep = new Set<number>();
    keep.add(blues[0]!.id);
    keep.add(reds[0]!.id);
    if (shB) keep.add(shB.id);
    if (shR) keep.add(shR.id);
    for (const u of this.sim.units) {
      if (!keep.has(u.id)) u.hp = 0;
    }
    this.sim.units = this.sim.units.filter((u) => u.hp > 0);
    const walker = this.sim.units.find((u) => u.team === BLUE && u.kind === "walker")!;
    const foe = this.sim.units.find((u) => u.team === RED && u.kind === "walker")!;
    this.shotWalkerId = walker.id;

    this.fightHoverMode = "off";
    this.fightHoverX = 0;
    this.fightHoverZ = 0;

    const toasts = ["拍1 · 右键走", "拍2 · 取消还在走", "拍3 · 拳头打人", "拍4 · 拆屋骨架"];

    if (startBeat <= 1) {
      const start = findSafeNear(aimX - fx * 3.4 + px * 2.6, aimZ - fz * 3.4 + pz * 2.6);
      park(walker, start.x, start.z);
      const mark = findSafeNear(start.x + px * 4.4, start.z + pz * 4.4);
      this.sim.sendMove(walker, mark.x, mark.z);
      walker.x = start.x + (mark.x - start.x) * 0.28;
      walker.z = start.z + (mark.z - start.z) * 0.28;
      walker.y = this.world.heightAt(walker.x, walker.z);
      walker.yaw = Math.atan2(mark.x - walker.x, mark.z - walker.z);
      walker.job = "move";
      walker.selected = startBeat === 0;
      walker.think = 80;
      const redSpot = findSafeNear(hut.x + fx * 2.8, hut.z + fz * 2.8);
      park(foe, redSpot.x, redSpot.z);
      this.view.showMoveMark(mark.x, mark.z);
      this.view.moveMarkLife = 99;
      this.view.jump(walker.x, walker.z);
      this.view.look.y = this.world.heightAt(walker.x, walker.z) + 0.7;
      this.view.dist = 6.6;
      this.view.pitch = 0.5;
    } else if (startBeat === 2) {
      const redSpot = findSafeNear(aimX - fx * 3.5, aimZ - fz * 3.5);
      park(foe, redSpot.x, redSpot.z);
      walker.x = foe.x - fx * 0.58 - px * 0.08;
      walker.z = foe.z - fz * 0.58 - pz * 0.08;
      if (!isSafeLand(walker.x, walker.z)) {
        const blueSpot = findSafeNear(foe.x - fx * 0.58, foe.z - fz * 0.58);
        walker.x = blueSpot.x;
        walker.z = blueSpot.z;
      }
      walker.y = this.world.heightAt(walker.x, walker.z);
      walker.job = "move";
      walker.path = [];
      walker.pathI = 0;
      walker.think = 80;
      walker.selected = true;
      walker.carry = 0;
      walker.targetId = 0;
      walker.homeId = 0;
      walker.order = "fight";
      walker.atkId = foe.id;
      walker.yaw = Math.atan2(foe.x - walker.x, foe.z - walker.z);
      foe.yaw = Math.atan2(walker.x - foe.x, walker.z - foe.z);
      foe.hp = Math.max(1, foe.maxHp * 0.55);
      this.fightHoverX = foe.x;
      this.fightHoverZ = foe.z;
      this.fightHoverMode = "fight";
      this.view.hover(foe.x, foe.z, true, "fight");
      const gx = (walker.x + foe.x) * 0.5;
      const gz = (walker.z + foe.z) * 0.5;
      this.view.jump(gx, gz);
      this.view.look.y = this.world.heightAt(gx, gz) + 0.85;
      this.view.dist = 5.1;
      this.view.pitch = 0.46;
    } else {
      hut.shell = true;
      hut.hp = Math.max(1, hut.maxHp * 0.4);
      const rim = this.sim.padEdge(hut.x, hut.z, hut.padW, hut.padD, hut.yaw, hut.x - fx * 4, hut.z - fz * 4);
      const blueSpot = findSafeNear(rim.x, rim.z);
      park(walker, blueSpot.x, blueSpot.z);
      walker.selected = true;
      walker.yaw = Math.atan2(hut.x - walker.x, hut.z - walker.z);
      const redSpot = findSafeNear(hut.x + px * 2.6, hut.z + pz * 2.6);
      park(foe, redSpot.x, redSpot.z);
      this.fightHoverX = hut.x;
      this.fightHoverZ = hut.z;
      this.fightHoverMode = "fight";
      this.view.hover(hut.x, hut.z, true, "fight");
      this.view.jump(hut.x, hut.z);
      this.view.look.y = hut.y + 0.7;
      this.view.dist = 6.0;
      this.view.pitch = 0.48;
    }

    this.shotBeat = startBeat;
    this.sim.markHouseBlocks();
    this.view.rebuildTerrain();
    this.sim.toast(toasts[startBeat] ?? toasts[0]!);
  }

  maybeHoldFight(): void {
    if (typeof location === "undefined" || !location.search.includes("shot=fight")) return;
    if (this.ended) return;
    this.paused = true;
    this.hud.toastT = 30;
    if (this.shotBeat >= 2 && this.fightHoverMode === "fight") {
      this.view.hover(this.fightHoverX, this.fightHoverZ, true, "fight");
    }
  }

  applyLiveSetup(startBeat = 0): void {
    this.sim.freezeMerge = true;
    this.sim.freezeProd = true;
    this.sim.lockWin = true;
    this.sim.review = true;
    const t = this.sim.teams[BLUE];
    t.manaCap = Math.max(t.manaCap, 200);
    t.mana = Math.max(t.mana, 240);
    this.host.clearPlace();
    this.sim.units = this.sim.units.filter((u) => u.kind !== "wildman");
    for (const u of this.sim.units) {
      if (u.team !== BLUE) u.hp = 0;
    }
    this.sim.units = this.sim.units.filter((u) => u.hp > 0);
    for (const b of this.sim.buildings) {
      if (b.kind === "hut") b.hp = 0;
    }
    this.sim.buildings = this.sim.buildings.filter((b) => b.hp > 0);

    const s = this.world.startPad(BLUE);
    const toCx = WORLD * 0.5 - s.x;
    const toCz = WORLD * 0.5 - s.z;
    const len = Math.hypot(toCx, toCz) || 1;
    const fx = toCx / len;
    const fz = toCz / len;
    let aimX = s.x + fx * 8.4;
    let aimZ = s.z + fz * 8.4;
    for (const a of [8.4, 7.6, 9.2, 6.8]) {
      const x = s.x + fx * a;
      const z = s.z + fz * a;
      if (this.world.heightAt(x, z) > 0.5) {
        aimX = x;
        aimZ = z;
        break;
      }
    }
    this.sim.trees = this.sim.trees.filter((tr) => Math.hypot(tr.x - aimX, tr.z - aimZ) > 6);
    this.world.flattenPad(aimX, aimZ, 3.4, 3.4, s.yaw, Math.max(this.world.heightAt(aimX, aimZ), 0.9));
    const hut = this.sim.placeComplete(BLUE, aimX, aimZ, s.yaw, "hut", 1);
    hut.dwell = 0;
    hut.born = 0;
    hut.prod = 0;
    hut.wantLevel = 0;
    this.shotHutX = hut.x;
    this.shotHutZ = hut.z;

    const parkAway = (
      u: { x: number; z: number; y: number; job: string; path: unknown[]; pathI: number; think: number; selected: boolean; carry: number; targetId: number; homeId: number },
      ox: number,
      oz: number,
    ) => {
      u.x = ox;
      u.z = oz;
      u.y = this.world.heightAt(ox, oz);
      u.job = "idle";
      u.path = [{ x: ox, z: oz }];
      u.pathI = 0;
      u.think = 80;
      u.selected = false;
      u.carry = 0;
      u.targetId = 0;
      u.homeId = 0;
    };

    const sh = this.sim.units.find((u) => u.team === BLUE && u.kind === "shaman");
    if (sh) parkAway(sh, s.x + 0.4, s.z + 1.6);

    const walkers = this.sim.units.filter((u) => u.team === BLUE && u.kind === "walker");
    while (walkers.length < 2) walkers.push(this.sim.addUnit(BLUE, "walker", s.x, s.z));
    parkAway(walkers[0]!, s.x + 1.2, s.z + 0.6);
    if (walkers[1]) parkAway(walkers[1], s.x + 1.7, s.z + 1.1);

    if (startBeat >= 1) this.sim.occupy(walkers[0]!, hut);
    if (startBeat === 2) {
      hut.born = 1;
      const door = this.sim.hutDoor(hut);
      const baby = this.sim.addUnit(BLUE, "walker", door.x, door.z);
      const out = this.sim.padLocalToWorld(hut, 0, hut.padD / 2 + 2.0);
      baby.yaw = Math.atan2(out.x - door.x, out.z - door.z);
      this.sim.sendMove(baby, out.x, out.z);
      baby.think = 80;
    }
    if (startBeat === 3) {
      hut.born = 2;
      this.sim.upgradeBuilding(hut, 2);
    }

    this.view.rebuildTerrain();
    this.view.jump(hut.x, hut.z);
    this.view.look.y = this.world.heightAt(hut.x, hut.z) + (startBeat === 3 ? 1.5 : 1.25);
    this.view.dist = startBeat === 3 ? 9.2 : 7.4;
    this.view.pitch = 0.58;
    const toasts = ["拍1 · 空屋不产", "拍2 · 入住产速", "拍3 · 出人仍L1", "拍4 · 中屋"];
    this.sim.toast(toasts[startBeat] ?? toasts[0]!);
  }

  maybeHoldLive(): void {
    if (typeof location === "undefined" || !location.search.includes("shot=live")) return;
    if (this.ended || this.paused) return;
    this.paused = true;
    this.hud.toastT = 30;
  }

  applyHouseSetup(startBeat = 0): void {
    this.sim.freezeMerge = true;
    this.sim.freezeProd = true;
    this.sim.lockWin = true;
    this.sim.review = true;
    const t = this.sim.teams[BLUE];
    t.manaCap = Math.max(t.manaCap, 200);
    t.mana = Math.max(t.mana, 240);
    this.host.clearPlace();
    const s = this.world.startPad(BLUE);
    const toCx = WORLD * 0.5 - s.x;
    const toCz = WORLD * 0.5 - s.z;
    const len = Math.hypot(toCx, toCz) || 1;
    const fx = toCx / len;
    const fz = toCz / len;
    let aimX = s.x + fx * 8.4;
    let aimZ = s.z + fz * 8.4;
    for (const a of [8.4, 7.6, 9.2, 6.8]) {
      const x = s.x + fx * a;
      const z = s.z + fz * a;
      if (this.world.heightAt(x, z) > 0.5) {
        aimX = x;
        aimZ = z;
        break;
      }
    }
    const px = -fz;
    const pz = fx;
    const walkers = this.sim.units.filter((u) => u.team === BLUE && u.kind === "walker");
    const spots = [
      [aimX + px * 0.55, aimZ + pz * 0.55],
      [aimX + px * 1.15, aimZ + pz * 1.15],
      [aimX - px * 0.55, aimZ - pz * 0.55],
      [aimX - px * 1.15, aimZ - pz * 1.15],
    ];
    while (walkers.length < 4) walkers.push(this.sim.addUnit(BLUE, "walker", aimX, aimZ));
    for (let i = 0; i < 4; i++) {
      const w = walkers[i]!;
      w.x = spots[i]![0];
      w.z = spots[i]![1];
      w.y = this.world.heightAt(w.x, w.z);
      w.job = "idle";
      w.path = [];
      w.think = 80;
      w.selected = false;
      w.carry = 0;
    }
    const tree = this.sim.trees.find((tr) => tr.alive && this.world.heightAt(tr.x, tr.z) > 0.4);
    const cx = tree ? tree.x + 0.7 : aimX + px * 4.2;
    const cz = tree ? tree.z + 0.2 : aimZ + pz * 4.2;
    const extras = this.sim.units.filter((u) => u.team === BLUE && u.kind === "walker" && !walkers.slice(0, 4).includes(u));
    while (extras.length < 2) extras.push(this.sim.addUnit(BLUE, "walker", cx, cz));
    for (let i = 0; i < 2; i++) {
      const w = extras[i]!;
      w.x = cx + i * 0.45;
      w.z = cz;
      w.y = this.world.heightAt(w.x, w.z);
      w.job = "chop";
      w.targetId = tree ? tree.id : 0;
      w.path = [];
      w.think = 80;
      w.selected = false;
    }
    const sh = this.sim.units.find((u) => u.team === BLUE && u.kind === "shaman");
    if (sh) {
      sh.x = aimX + fx * 1.1;
      sh.z = aimZ + fz * 1.1;
      sh.y = this.world.heightAt(sh.x, sh.z);
      sh.job = "idle";
      sh.path = [];
      sh.think = 80;
      sh.selected = false;
    }
    this.sim.units = this.sim.units.filter((u) => u.kind !== "wildman");
    for (const u of this.sim.units) {
      if (u.team !== BLUE) u.hp = 0;
    }
    this.sim.units = this.sim.units.filter((u) => u.team === BLUE && u.hp > 0);
    const isSafeLand = (x: number, z: number): boolean => {
      if (this.world.heightAt(x, z) <= 0.5) return false;
      if (!this.world.walkableAt(x, z)) return false;
      if (this.sim.buildingAt(x, z)) return false;
      return true;
    };
    const used: Array<{ x: number; z: number }> = [];
    const tooClose = (x: number, z: number): boolean => {
      for (const p of used) {
        if ((p.x - x) * (p.x - x) + (p.z - z) * (p.z - z) < 0.45 * 0.45) return true;
      }
      return false;
    };
    const findSafe = (): { x: number; z: number } => {
      if (isSafeLand(aimX, aimZ) && !tooClose(aimX, aimZ)) return { x: aimX, z: aimZ };
      const step = 0.5;
      for (let r = step; r <= 8; r += step) {
        const n = Math.max(8, Math.round((Math.PI * 2 * r) / step));
        for (let i = 0; i < n; i++) {
          const a = (i / n) * Math.PI * 2;
          const x = aimX + Math.cos(a) * r;
          const z = aimZ + Math.sin(a) * r;
          if (isSafeLand(x, z) && !tooClose(x, z)) return { x, z };
        }
      }
      return { x: aimX, z: aimZ };
    };
    const chopIds = new Set(extras.slice(0, 2).map((u) => u.id));
    for (const u of this.sim.units) {
      if (u.hp <= 0) continue;
      if (!isSafeLand(u.x, u.z) || tooClose(u.x, u.z)) {
        const p = findSafe();
        u.x = p.x;
        u.z = p.z;
      }
      u.y = this.world.heightAt(u.x, u.z);
      used.push({ x: u.x, z: u.z });
      u.selected = false;
      u.path = [];
      u.pathI = 0;
      u.think = 80;
      u.carry = 0;
      if (!chopIds.has(u.id)) u.job = "idle";
    }
    this.shotBeat = startBeat;
    this.shotHutX = 0;
    this.shotHutZ = 0;
    this.houseShamanArmed = false;
    this.view.rebuildTerrain();
    this.view.jump(aimX, aimZ);
    this.view.look.y = this.world.heightAt(aimX, aimZ) + 1.2;
    this.view.dist = 11.2;
    this.view.pitch = 0.62;
    if (startBeat === 3) {
      this.host.clearPlace();
      for (const u of this.sim.units) u.selected = false;
    }
    if (startBeat === 2) this.sim.toast("点祭司，再点空地，然后右键");
    else if (startBeat === 3) this.sim.toast("选2个勇士，再点茅屋落地");
    else this.sim.toast("点一个勇士，再左键点空地");
  }

  maybeHoldHouse(): void {
    if (typeof location === "undefined" || !location.search.includes("shot=house")) return;
    if (this.ended) return;
    const blues = this.sim.units.filter((u) => u.team === BLUE && u.hp > 0);
    const movers = blues.filter((u) => u.job === "move" && u.path.length);
    const chop = blues.find((u) => u.kind === "walker" && u.job === "chop");
    if (this.shotBeat === 0 && !this.paused && movers.length === 1 && movers[0]!.selected) {
      this.paused = true;
      this.shotBeat = 1;
      this.view.hover(0, 0, false);
      this.view.jump(movers[0]!.x, movers[0]!.z);
      this.view.look.y = this.world.heightAt(movers[0]!.x, movers[0]!.z) + 0.7;
      this.view.dist = 7.4;
      this.view.pitch = 0.5;
      this.sim.toast("拍1 · 点地走 环还在");
      this.hud.toastT = 30;
      return;
    }
    if (this.shotBeat === 1 && !this.paused && movers.length >= 3 && chop) {
      this.paused = true;
      this.shotBeat = 2;
      this.view.hover(0, 0, false);
      const m = movers[0]!;
      this.view.jump(m.x, m.z);
      this.view.look.y = this.world.heightAt(m.x, m.z) + 1.0;
      this.view.dist = 10.4;
      this.view.pitch = 0.58;
      this.sim.toast("拍2 · 三人走 圈外砍");
      this.hud.toastT = 30;
      this.houseShamanArmed = false;
      return;
    }
    if (this.shotBeat === 2 && !this.paused) {
      const sh = blues.find((u) => u.kind === "shaman" && u.hp > 0);
      if (sh && sh.selected && sh.job === "move" && sh.path.length) this.houseShamanArmed = true;
      if (!this.houseShamanArmed || !sh || sh.job !== "move" || !sh.path.length || sh.selected) return;
      this.paused = true;
      this.shotBeat = 3;
      this.view.hover(0, 0, false);
      this.view.jump(sh.x, sh.z);
      this.view.look.y = this.world.heightAt(sh.x, sh.z) + 0.7;
      this.view.dist = 7.2;
      this.view.pitch = 0.48;
      this.sim.toast("拍3 · 祭司走 已取消");
      this.hud.toastT = 30;
      return;
    }
    if (this.shotBeat === 3 && !this.paused) {
      const site =
        this.shotHutX || this.shotHutZ
          ? this.sim.buildings.find((b) => b.team === BLUE && b.hp > 0 && Math.hypot(b.x - this.shotHutX, b.z - this.shotHutZ) < 0.7)
          : this.sim.buildings.find((b) => b.team === BLUE && b.kind === "hut" && b.level === 0 && b.hp > 0);
      if (!site) return;
      const going = blues.filter((u) => u.kind === "walker" && (u.job === "move" || u.targetId === site.id));
      if (going.length !== 2) return;
      const near = going.filter((u) => Math.hypot(u.x - site.x, u.z - site.z) < 8);
      if (!near.length) return;
      this.paused = true;
      this.shotBeat = 4;
      this.host.clearPlace();
      this.view.hover(0, 0, false);
      const gx = (near[0]!.x + site.x) * 0.5;
      const gz = (near[0]!.z + site.z) * 0.5;
      this.view.jump(gx, gz);
      this.view.look.y = this.world.heightAt(gx, gz) + 0.55;
      this.view.dist = 6.4;
      this.view.pitch = 0.46;
      this.sim.toast("拍4 · 两人去垫边");
      this.hud.toastT = 30;
    }
  }

  applyPathSetup(startBeat = 0): void {
    this.sim.freezeMerge = true;
    this.sim.freezeProd = true;
    this.sim.lockWin = true;
    this.sim.review = true;
    const t = this.sim.teams[BLUE];
    t.manaCap = Math.max(t.manaCap, 200);
    t.mana = Math.max(t.mana, 240);
    this.host.clearPlace();
    this.pathWalkerArmed = false;
    this.shotHutX = 0;
    this.shotHutZ = 0;
    this.shotStartX = 0;
    this.shotStartZ = 0;
    this.shotWalkerId = 0;
    const s = this.world.startPad(BLUE);
    const toCx = WORLD * 0.5 - s.x;
    const toCz = WORLD * 0.5 - s.z;
    const len = Math.hypot(toCx, toCz) || 1;
    const fx = toCx / len;
    const fz = toCz / len;
    const px = -fz;
    const pz = fx;
    let aimX = s.x + fx * 10.2;
    let aimZ = s.z + fz * 10.2;
    for (const a of [10.2, 9.2, 11.2, 8.4, 12.0, 7.6]) {
      const x = s.x + fx * a;
      const z = s.z + fz * a;
      if (this.world.heightAt(x, z) > 0.55 && this.world.slopeAt(x, z) < 0.5) {
        aimX = x;
        aimZ = z;
        break;
      }
    }
    this.sim.units = this.sim.units.filter((u) => u.kind !== "wildman");
    for (const u of this.sim.units) {
      if (u.team !== BLUE) u.hp = 0;
    }
    this.sim.units = this.sim.units.filter((u) => u.hp > 0);
    for (const b of this.sim.buildings) {
      if (b.kind === "hut") b.hp = 0;
    }
    this.sim.buildings = this.sim.buildings.filter((b) => b.hp > 0);
    const wantWalkers = startBeat === 1 ? 2 : 1;
    let walkers = this.sim.units.filter((u) => u.team === BLUE && u.kind === "walker");
    while (walkers.length < wantWalkers) walkers.push(this.sim.addUnit(BLUE, "walker", aimX, aimZ));
    walkers = this.sim.units.filter((u) => u.team === BLUE && u.kind === "walker");
    const keep = new Set(walkers.slice(0, wantWalkers).map((u) => u.id));
    const sh = this.sim.units.find((u) => u.team === BLUE && u.kind === "shaman");
    if (sh) keep.add(sh.id);
    for (const u of this.sim.units) {
      if (!keep.has(u.id)) u.hp = 0;
    }
    this.sim.units = this.sim.units.filter((u) => u.hp > 0);
    walkers = this.sim.units.filter((u) => u.team === BLUE && u.kind === "walker");

    const park = (u: { x: number; z: number; y: number; job: string; path: unknown[]; pathI: number; think: number; selected: boolean; carry: number; targetId: number }, x: number, z: number) => {
      u.x = x;
      u.z = z;
      u.y = this.world.heightAt(x, z);
      u.job = "idle";
      u.path = [];
      u.pathI = 0;
      u.think = 80;
      u.selected = false;
      u.carry = 0;
      u.targetId = 0;
    };

    const isSafeLand = (x: number, z: number): boolean => {
      if (this.world.heightAt(x, z) <= 0.5) return false;
      if (!this.world.walkableAt(x, z)) return false;
      if (this.sim.buildingAt(x, z)) return false;
      return true;
    };
    const findSafeNear = (ox: number, oz: number): { x: number; z: number } => {
      if (isSafeLand(ox, oz)) return { x: ox, z: oz };
      const step = 0.4;
      for (let r = step; r <= 8; r += step) {
        const n = Math.max(8, Math.round((Math.PI * 2 * r) / step));
        for (let i = 0; i < n; i++) {
          const a = (i / n) * Math.PI * 2;
          const x = ox + Math.cos(a) * r;
          const z = oz + Math.sin(a) * r;
          if (isSafeLand(x, z)) return { x, z };
        }
      }
      return { x: ox, z: oz };
    };

    if (startBeat === 0) {
      this.sim.trees = this.sim.trees.filter((tr) => Math.hypot(tr.x - aimX, tr.z - aimZ) > 8.5);
      const yaw = s.yaw;
      this.world.flattenPad(aimX, aimZ, 3.4, 3.4, yaw, Math.max(this.world.heightAt(aimX, aimZ), 0.9));
      const hut = this.sim.placeComplete(BLUE, aimX, aimZ, yaw, "hut", 1);
      this.shotHutX = hut.x;
      this.shotHutZ = hut.z;
      const c = Math.cos(hut.yaw);
      const si = Math.sin(hut.yaw);
      const sides: [number, number][] = [
        [-3.5 * c, -3.5 * si],
        [3.5 * c, 3.5 * si],
        [3.5 * si, -3.5 * c],
        [-3.5 * si, 3.5 * c],
      ];
      let wx = hut.x + sides[0]![0];
      let wz = hut.z + sides[0]![1];
      for (const [dx, dz] of sides) {
        const x = hut.x + dx;
        const z = hut.z + dz;
        if (this.world.walkableAt(x, z) && !inPad(x, z, this.sim.buildingPad(hut))) {
          wx = x;
          wz = z;
          break;
        }
      }
      const safe = findSafeNear(wx, wz);
      park(walkers[0]!, safe.x, safe.z);
      this.shotWalkerId = walkers[0]!.id;
      this.shotStartX = walkers[0]!.x;
      this.shotStartZ = walkers[0]!.z;
      if (sh) {
        const home = this.world.startPad(BLUE);
        const p = findSafeNear(home.x + 0.4, home.z + 1.6);
        park(sh, p.x, p.z);
      }
      this.sim.toast("点勇士，绕过茅屋走到对面");
      this.view.jump(hut.x, hut.z);
      this.view.look.y = this.world.heightAt(hut.x, hut.z) + 1.05;
      this.view.dist = 11.6;
      this.view.pitch = 0.58;
    } else if (startBeat === 1) {
      this.sim.trees = this.sim.trees.filter((tr) => Math.hypot(tr.x - aimX, tr.z - aimZ) > 7.2);
      this.world.flattenPad(aimX, aimZ, 5.2, 5.2, s.yaw, Math.max(this.world.heightAt(aimX, aimZ), 0.9));
      const a = findSafeNear(aimX - fx * 4.2 + px * 0.55, aimZ - fz * 4.2 + pz * 0.55);
      const b = findSafeNear(aimX - fx * 4.2 - px * 0.55, aimZ - fz * 4.2 - pz * 0.55);
      park(walkers[0]!, a.x, a.z);
      park(walkers[1]!, b.x, b.z);
      if (sh) {
        const p = findSafeNear(aimX - fx * 7.2, aimZ - fz * 7.2);
        park(sh, p.x, p.z);
      }
      const made = this.sim.foundSite(BLUE, aimX, aimZ, s.yaw, "hut");
      if (made) {
        this.shotHutX = made.x;
        this.shotHutZ = made.z;
        const pad = this.sim.buildingPad(made);
        const rim = pad.d / 2 + 0.7;
        const spots = [
          worldOnPad(0.4, rim, pad),
          worldOnPad(-0.4, rim, pad),
          worldOnPad(pad.w / 2 + 0.7, 0.35, pad),
          worldOnPad(-(pad.w / 2 + 0.7), -0.35, pad),
        ];
        const ok = spots.filter((p) => this.world.walkableAt(p.x, p.z) && !inPad(p.x, p.z, pad));
        const a = ok[0] ?? findSafeNear(aimX - fx * 2.2, aimZ - fz * 2.2);
        const b = ok[1] ?? findSafeNear(a.x + px * 0.7, a.z + pz * 0.7);
        park(walkers[0]!, a.x, a.z);
        park(walkers[1]!, b.x, b.z);
        for (const w of [walkers[0]!, walkers[1]!]) {
          w.targetId = made.id;
          w.selected = true;
          w.yaw = Math.atan2(made.x - w.x, made.z - w.z);
        }
      }
      this.host.clearPlace();
      this.paused = true;
      this.shotBeat = 2;
      this.view.hover(0, 0, false);
      this.view.jump(aimX, aimZ);
      this.view.look.y = this.world.heightAt(aimX, aimZ) + 0.55;
      this.view.dist = 7.0;
      this.view.pitch = 0.48;
      this.sim.toast("拍2 · 两人站外沿");
      this.hud.toastT = 30;
    } else {
      const lineX = aimX + fx * 1.2;
      const lineZ = aimZ + fz * 1.2;
      this.sim.trees = this.sim.trees.filter((tr) => Math.hypot(tr.x - lineX, tr.z - lineZ) > 8.0);
      const n = 4;
      const spacing = 0.92;
      const have = this.sim.trees.filter((tr) => tr.alive);
      for (let i = 0; i < n; i++) {
        const off = (i - (n - 1) / 2) * spacing;
        const x = lineX + px * off;
        const z = lineZ + pz * off;
        this.world.flattenPad(x, z, 0.8, 0.8, 0, Math.max(this.world.heightAt(x, z), 0.7));
        if (have[i]) {
          have[i]!.x = x;
          have[i]!.z = z;
          have[i]!.y = this.world.heightAt(x, z);
          have[i]!.alive = true;
          have[i]!.regen = 0;
        } else {
          this.sim.trees.push({
            id: 9000 + i,
            x,
            z,
            y: this.world.heightAt(x, z),
            alive: true,
            regen: 0,
          });
        }
      }
      this.sim.markHouseBlocks();
      this.shotHutX = lineX;
      this.shotHutZ = lineZ;
      const wx = lineX - fx * 3.6;
      const wz = lineZ - fz * 3.6;
      const safe = findSafeNear(wx, wz);
      park(walkers[0]!, safe.x, safe.z);
      this.shotWalkerId = walkers[0]!.id;
      this.shotStartX = walkers[0]!.x;
      this.shotStartZ = walkers[0]!.z;
      if (sh) {
        const p = findSafeNear(safe.x - px * 2.2, safe.z - pz * 2.2);
        park(sh, p.x, p.z);
      }
      this.sim.toast("点勇士，绕树走到点");
      this.view.jump(lineX, lineZ);
      this.view.look.y = this.world.heightAt(lineX, lineZ) + 1.0;
      this.view.dist = 11.4;
      this.view.pitch = 0.58;
    }

    this.sim.markHouseBlocks();
    const away = startBeat === 0 && (this.shotHutX || this.shotHutZ) ? { x: this.shotStartX, z: this.shotStartZ } : { x: aimX, z: aimZ };
    if (startBeat !== 1) {
      for (const u of this.sim.units) {
        if (!this.world.walkableAt(u.x, u.z) || this.world.heightAt(u.x, u.z) <= 0.5) {
          const p = findSafeNear(u.x || away.x, u.z || away.z);
          u.x = p.x;
          u.z = p.z;
          u.y = this.world.heightAt(u.x, u.z);
        }
      }
    }
    const w0 = this.shotWalkerId ? this.sim.units.find((u) => u.id === this.shotWalkerId) : walkers[0];
    if (w0 && startBeat !== 1) {
      this.shotStartX = w0.x;
      this.shotStartZ = w0.z;
    }
    if (!this.paused) this.shotBeat = startBeat;
    this.sim.markHouseBlocks();
    this.view.rebuildTerrain();
  }

  maybeHoldPath(): void {
    if (typeof location === "undefined" || !location.search.includes("shot=path")) return;
    if (this.ended || this.paused) return;
    const blues = this.sim.units.filter((u) => u.team === BLUE && u.hp > 0);
    if (this.shotBeat === 0) {
      const hut =
        this.shotHutX || this.shotHutZ
          ? this.sim.buildings.find((b) => b.team === BLUE && b.hp > 0 && Math.hypot(b.x - this.shotHutX, b.z - this.shotHutZ) < 0.8)
          : this.sim.buildings.find((b) => b.team === BLUE && b.kind === "hut" && b.level >= 1 && b.hp > 0);
      const w =
        (this.shotWalkerId ? this.sim.units.find((u) => u.id === this.shotWalkerId) : undefined) ??
        blues.find((u) => u.kind === "walker");
      if (!hut || !w) return;
      if (w.job === "move" || w.path.length) this.pathWalkerArmed = true;
      if (!this.pathWalkerArmed) return;
      const sx = this.shotStartX - hut.x;
      const sz = this.shotStartZ - hut.z;
      const px = w.x - hut.x;
      const pz = w.z - hut.z;
      const crossed = sx * px + sz * pz < 0;
      const dest = w.path.length ? w.path[w.path.length - 1]! : null;
      const nearDest = dest ? Math.hypot(w.x - dest.x, w.z - dest.z) < 0.7 : true;
      const arrived = !w.path.length || nearDest;
      const stuck = this.sim.stuckWatch.get(w.id);
      const notStuck = !stuck || this.sim.time - stuck.t < 0.85 || Math.hypot(w.x - stuck.x, w.z - stuck.z) >= 0.08;
      if (!crossed || !arrived || !notStuck) return;
      this.paused = true;
      this.shotBeat = 1;
      this.view.hover(0, 0, false);
      const gx = (w.x + hut.x) * 0.5;
      const gz = (w.z + hut.z) * 0.5;
      this.view.jump(gx, gz);
      this.view.look.y = this.world.heightAt(gx, gz) + 0.85;
      this.view.dist = 9.6;
      this.view.pitch = 0.54;
      this.sim.toast("拍1 · 绕屋过去");
      this.hud.toastT = 30;
      return;
    }
    if (this.shotBeat === 1) {
      const site =
        this.shotHutX || this.shotHutZ
          ? this.sim.buildings.find((b) => b.team === BLUE && b.hp > 0 && Math.hypot(b.x - this.shotHutX, b.z - this.shotHutZ) < 0.8)
          : this.sim.buildings.find((b) => b.team === BLUE && b.kind === "hut" && b.level === 0 && b.hp > 0);
      if (!site || site.level !== 0) return;
      const pad = this.sim.buildingPad(site);
      const walkers = blues.filter((u) => u.kind === "walker");
      const onRim = walkers.filter((u) => {
        const going = u.job === "move" || u.targetId === site.id;
        const close = Math.hypot(u.x - site.x, u.z - site.z) < pad.w * 0.5 + 0.9;
        return going && close && !inPad(u.x, u.z, pad) && inPad(u.x, u.z, pad, 1.05);
      });
      if (onRim.length < 2) return;
      this.paused = true;
      this.shotBeat = 2;
      this.host.clearPlace();
      this.view.hover(0, 0, false);
      const gx = (onRim[0]!.x + site.x) * 0.5;
      const gz = (onRim[0]!.z + site.z) * 0.5;
      this.view.jump(gx, gz);
      this.view.look.y = this.world.heightAt(gx, gz) + 0.6;
      this.view.dist = 7.2;
      this.view.pitch = 0.5;
      this.sim.toast("拍2 · 两人站外沿");
      this.hud.toastT = 30;
      return;
    }
    if (this.shotBeat === 2) {
      const w =
        (this.shotWalkerId ? this.sim.units.find((u) => u.id === this.shotWalkerId) : undefined) ??
        blues.find((u) => u.kind === "walker");
      if (!w) return;
      if (w.job === "move" || w.path.length) this.pathWalkerArmed = true;
      if (!this.pathWalkerArmed) return;
      const sx = this.shotStartX - this.shotHutX;
      const sz = this.shotStartZ - this.shotHutZ;
      const px = w.x - this.shotHutX;
      const pz = w.z - this.shotHutZ;
      const crossed = sx * px + sz * pz < 0;
      const dest = w.path.length ? w.path[w.path.length - 1]! : null;
      const nearDest = dest ? Math.hypot(w.x - dest.x, w.z - dest.z) < 0.7 : true;
      const arrived = !w.path.length || nearDest;
      if (!crossed || !arrived) return;
      this.paused = true;
      this.shotBeat = 3;
      this.view.hover(0, 0, false);
      const gx = (w.x + this.shotHutX) * 0.5;
      const gz = (w.z + this.shotHutZ) * 0.5;
      this.view.jump(gx, gz);
      this.view.look.y = this.world.heightAt(gx, gz) + 0.8;
      this.view.dist = 9.4;
      this.view.pitch = 0.54;
      this.sim.toast("拍3 · 绕树到点");
      this.hud.toastT = 30;
    }
  }

  applyBlastSetup(): void {
    this.sim.freezeMerge = true;
    this.sim.freezeProd = true;
    this.sim.lockWin = true;
    this.sim.review = true;
    const t = this.sim.teams[BLUE];
    t.manaCap = Math.max(t.manaCap, 200);
    t.mana = Math.max(t.mana, 240);
    this.host.clearPlace();
    const s = this.world.startPad(BLUE);
    const toCx = WORLD * 0.5 - s.x;
    const toCz = WORLD * 0.5 - s.z;
    const len = Math.hypot(toCx, toCz) || 1;
    const fx = toCx / len;
    const fz = toCz / len;
    let aimX = s.x + fx * 9.0;
    let aimZ = s.z + fz * 9.0;
    for (const a of [9.0, 8.2, 10.2, 7.4]) {
      const x = s.x + fx * a;
      const z = s.z + fz * a;
      if (this.world.heightAt(x, z) > 0.5) {
        aimX = x;
        aimZ = z;
        break;
      }
    }
    const hx = aimX + fx * 2.4;
    const hz = aimZ + fz * 2.4;
    const wx = aimX + fx * 0.75;
    const wz = aimZ + fz * 0.75;
    const sx = aimX - fz * 6.4;
    const sz = aimZ + fx * 6.4;
    for (const b of this.sim.buildings) {
      if (b.team === BLUE && b.kind === "hut") b.hp = 0;
    }
    this.sim.buildings = this.sim.buildings.filter((b) => b.hp > 0);
    const victim = this.sim.placeComplete(BLUE, hx, hz, 0, "hut", 1);
    const safe = this.sim.placeComplete(BLUE, sx, sz, 0.4, "hut", 1);
    this.shotVictimId = victim.id;
    this.shotSafeId = safe.id;
    this.shotHutX = victim.x;
    this.shotHutZ = victim.z;
    const walkers = this.sim.units.filter((u) => u.team === BLUE && u.kind === "walker");
    while (walkers.length < 1) walkers.push(this.sim.addUnit(BLUE, "walker", wx, wz));
    const on = walkers[0]!;
    on.x = wx;
    on.z = wz;
    on.y = this.world.heightAt(on.x, on.z);
    on.job = "idle";
    on.path = [];
    on.think = 80;
    on.selected = true;
    this.shotWalkerId = on.id;
    for (let i = 1; i < walkers.length; i++) {
      const u = walkers[i]!;
      u.x = sx + 1.4 + i * 0.3;
      u.z = sz + 1.1;
      u.y = this.world.heightAt(u.x, u.z);
      u.job = "idle";
      u.path = [];
      u.think = 80;
      u.selected = false;
    }
    this.shotBeat = 0;
    this.view.rebuildTerrain();
    this.view.jump(aimX, aimZ);
    this.view.look.y = this.world.heightAt(aimX, aimZ) + 1.1;
    this.view.dist = 9.6;
    this.view.pitch = 0.62;
    this.sim.toast("点击飞图标，再点眼前这块地");
  }

  keepBlastShotPose(): void {
    if (typeof location === "undefined" || !location.search.includes("shot=blast")) return;
    if (this.shotBeat !== 1 && this.shotBeat !== 2) return;
    let w = this.sim.units.find((u) => u.id === this.shotWalkerId);
    if (!w || w.hp <= 0) {
      w = this.sim.addUnit(BLUE, "walker", this.shotBlastX + 0.12, this.shotBlastZ + 0.12);
      this.shotWalkerId = w.id;
    }
    for (const u of this.sim.units) {
      if (u.id === w.id) continue;
      u.x = 2.2;
      u.z = 2.2;
      u.y = this.world.heightAt(2.2, 2.2);
    }
    w.x = this.shotBlastX + 0.12;
    w.z = this.shotBlastZ + 0.12;
    const gnd = this.world.heightAt(this.shotBlastX, this.shotBlastZ);
    w.y = gnd + 1.2;
    w.fireT = 0;
    w.selected = false;
    this.sim.blastFlyer = { x: w.x, y: w.y, z: w.z };
    this.view.hover(0, 0, false);
    if (this.shotBeat === 1) {
      this.view.jump(w.x, w.z);
      this.view.look.y = w.y + 0.08;
      this.view.dist = 3.8;
      this.view.pitch = 0.55;
    }
    if (this.shotBeat === 2) {
      this.view.jump(w.x, w.z);
      this.view.look.y = w.y + 0.04;
      this.view.dist = 3.2;
      this.view.pitch = 0.48;
    }
    const mesh = this.view.unitMeshes.get(w.id);
    if (mesh) mesh.scale.set(2.2, 2.2, 2.2);
  }

  pinBlastFlyer(walker: { x: number; z: number; y: number; fireT: number; flyVx: number; flyVz: number; flyVy: number; path: unknown[]; id: number }, bx: number, bz: number): void {
    walker.x = bx + 0.12;
    walker.z = bz + 0.12;
    for (const u of this.sim.units) {
      if (u.id === walker.id) continue;
      u.x = 2.2;
      u.z = 2.2;
      u.y = this.world.heightAt(2.2, 2.2);
      u.path = [];
      u.think = 80;
    }
    walker.fireT = 0;
    walker.y = this.world.heightAt(bx, bz) + 1.2;
    walker.flyVx = 1.6;
    walker.flyVz = 0.4;
    walker.flyVy = 1.2;
    walker.path = [];
  }

  maybeHoldBlast(): void {
    if (typeof location === "undefined" || !location.search.includes("shot=blast")) return;
    if (this.ended) return;
    const hut = this.sim.buildings.find((b) => b.id === this.shotVictimId);
    let walker = this.sim.units.find((u) => u.id === this.shotWalkerId);
    const blast = this.sim.blast;
    if (this.shotBeat === 0 && blast && !this.paused) {
      this.shotBlastX = blast.x;
      this.shotBlastZ = blast.z;
      if (walker) walker.hp = 0;
      walker = this.sim.addUnit(BLUE, "walker", blast.x + 0.12, blast.z + 0.12);
      this.shotWalkerId = walker.id;
      this.pinBlastFlyer(walker, blast.x, blast.z);
      this.paused = true;
      this.shotBeat = 1;
      this.view.hover(0, 0, false);
      this.view.jump(walker.x, walker.z);
      this.view.look.y = walker.y + 0.08;
      this.view.dist = 3.8;
      this.view.pitch = 0.55;
      this.sim.toast("拍1 · 击飞离地");
      this.hud.toastT = 30;
      return;
    }
    if (this.shotBeat === 1 && !this.paused) {
      if (!walker || walker.hp <= 0) {
        walker = this.sim.addUnit(BLUE, "walker", this.shotHutX - 0.8, this.shotHutZ);
        this.shotWalkerId = walker.id;
      }
      const bx = this.sim.blast?.x ?? walker.x;
      const bz = this.sim.blast?.z ?? walker.z;
      this.pinBlastFlyer(walker, bx, bz);
      this.paused = true;
      this.shotBeat = 2;
      this.view.hover(0, 0, false);
      this.view.jump(walker.x, walker.z);
      this.view.look.y = walker.y + 0.04;
      this.view.dist = 3.2;
      this.view.pitch = 0.48;
      this.sim.toast("拍2 · 身上没火");
      this.hud.toastT = 30;
      return;
    }
    if (this.shotBeat === 2 && !this.paused) {
      let h = hut;
      if (!h || h.hp <= 0) {
        h = this.sim.placeComplete(BLUE, this.shotHutX, this.shotHutZ, 0, "hut", 1);
        this.shotVictimId = h.id;
      }
      h.shell = false;
      h.hp = h.maxHp;
      this.paused = true;
      this.shotBeat = 3;
      this.view.hover(0, 0, false);
      this.view.jump(h.x, h.z);
      this.view.look.y = h.y + 0.55;
      this.view.dist = 7.6;
      this.view.pitch = 0.5;
      this.sim.toast("拍3 · 房子完好");
      this.hud.toastT = 30;
    }
  }

  applyLightningSetup(): void {
    this.sim.freezeMerge = true;
    this.sim.freezeProd = true;
    this.sim.lockWin = true;
    this.sim.review = true;
    const t = this.sim.teams[BLUE];
    t.manaCap = Math.max(t.manaCap, 200);
    t.mana = Math.max(t.mana, 240);
    this.host.clearPlace();
    const s = this.world.startPad(BLUE);
    const toCx = WORLD * 0.5 - s.x;
    const toCz = WORLD * 0.5 - s.z;
    const len = Math.hypot(toCx, toCz) || 1;
    const fx = toCx / len;
    const fz = toCz / len;
    let aimX = s.x + fx * 9.0;
    let aimZ = s.z + fz * 9.0;
    for (const a of [9.0, 8.2, 10.2, 7.4]) {
      const x = s.x + fx * a;
      const z = s.z + fz * a;
      if (this.world.heightAt(x, z) > 0.5) {
        aimX = x;
        aimZ = z;
        break;
      }
    }
    const hx = aimX + fx * 1.85;
    const hz = aimZ + fz * 1.85;
    const wx = aimX + fx * 0.7;
    const wz = aimZ + fz * 0.7;
    const sx = aimX - fz * 6.4;
    const sz = aimZ + fx * 6.4;
    for (const b of this.sim.buildings) {
      if (b.team === BLUE && b.kind === "hut") b.hp = 0;
    }
    this.sim.buildings = this.sim.buildings.filter((b) => b.hp > 0);
    const victim = this.sim.placeComplete(BLUE, hx, hz, 0, "hut", 1);
    const safe = this.sim.placeComplete(BLUE, sx, sz, 0.4, "hut", 1);
    this.shotVictimId = victim.id;
    this.shotSafeId = safe.id;
    this.shotHutX = victim.x;
    this.shotHutZ = victim.z;
    const walkers = this.sim.units.filter((u) => u.team === BLUE && u.kind === "walker");
    while (walkers.length < 1) walkers.push(this.sim.addUnit(BLUE, "walker", wx, wz));
    const on = walkers[0]!;
    on.x = wx;
    on.z = wz;
    on.y = this.world.heightAt(on.x, on.z);
    on.job = "idle";
    on.path = [];
    on.think = 80;
    on.selected = true;
    this.shotWalkerId = on.id;
    for (let i = 1; i < walkers.length; i++) {
      const u = walkers[i]!;
      u.x = sx + 1.4 + i * 0.3;
      u.z = sz + 1.1;
      u.y = this.world.heightAt(u.x, u.z);
      u.job = "idle";
      u.path = [];
      u.think = 80;
      u.selected = false;
    }
    this.shotBeat = 0;
    this.view.rebuildTerrain();
    this.view.jump(aimX, aimZ);
    this.view.look.y = this.world.heightAt(aimX, aimZ) + 2.4;
    this.view.dist = 10.4;
    this.view.pitch = 0.7;
    this.sim.toast("点闪电图标，再点眼前这块地");
  }

  keepLightningShotPose(): void {
    if (typeof location === "undefined" || !location.search.includes("shot=lightning")) return;
    if (this.shotBeat !== 2) return;
    const w = this.sim.units.find((u) => u.id === this.shotWalkerId);
    if (!w || w.hp <= 0) return;
    const gnd = this.world.heightAt(w.x, w.z);
    w.y = gnd + 1.7;
    w.fireT = 8;
  }

  maybeHoldLightning(bolts: Array<{ life: number }> = []): void {
    if (typeof location === "undefined" || !location.search.includes("shot=lightning")) return;
    if (this.ended) return;
    const hut = this.sim.buildings.find((b) => b.id === this.shotVictimId);
    let walker = this.sim.units.find((u) => u.id === this.shotWalkerId);
    const bolt = bolts.find((b) => b.life > 0) ?? this.sim.fxBolts.find((b) => b.life > 0);
    if (this.shotBeat === 0 && bolt && !this.paused) {
      this.paused = true;
      this.shotBeat = 1;
      this.view.hover(0, 0, false);
      this.view.jump((bolt as any).x1 ?? 0, (bolt as any).z1 ?? 0);
      this.view.look.y = this.world.heightAt((bolt as any).x1 ?? 0, (bolt as any).z1 ?? 0) + 2.6;
      this.view.dist = 9.4;
      this.view.pitch = 0.68;
      this.sim.toast("拍1 · 闪电劈地");
      this.hud.toastT = 30;
      return;
    }
    if (this.shotBeat === 1 && !this.paused) {
      if (!walker || walker.hp <= 0) {
        walker = this.sim.addUnit(BLUE, "walker", this.shotHutX - 0.6, this.shotHutZ);
        this.shotWalkerId = walker.id;
      }
      for (const u of this.sim.units) {
        if (u.id === walker.id) continue;
        u.x = 2.2;
        u.z = 2.2;
        u.y = this.world.heightAt(2.2, 2.2);
        u.path = [];
        u.think = 80;
      }
      const gnd = this.world.heightAt(walker.x, walker.z);
      walker.fireT = 8;
      walker.x += 0.4;
      walker.z += 0.1;
      walker.y = gnd + 1.7;
      walker.flyVx = 2.4;
      walker.flyVz = 0.7;
      walker.flyVy = 1.6;
      walker.path = [];
      this.paused = true;
      this.shotBeat = 2;
      this.view.hover(0, 0, false);
      this.view.jump(walker.x, walker.z);
      this.view.look.y = gnd + 1.05;
      this.view.dist = 6.4;
      this.view.pitch = 0.46;
      this.sim.toast("拍2 · 着火打飞");
      this.hud.toastT = 30;
      return;
    }
    if (this.shotBeat === 2 && !this.paused) {
      let h = hut;
      if (!h || h.hp <= 0) {
        h = this.sim.placeComplete(BLUE, this.shotHutX, this.shotHutZ, 0, "hut", 1);
        this.shotVictimId = h.id;
      }
      h.shell = true;
      h.hp = Math.max(1, h.maxHp * 0.4);
      this.paused = true;
      this.shotBeat = 3;
      this.view.hover(0, 0, false);
      this.view.jump(h.x, h.z);
      this.view.look.y = h.y + 0.45;
      this.view.dist = 7.8;
      this.view.pitch = 0.5;
      this.sim.toast("拍3 · 劈成骨架");
      this.hud.toastT = 30;
    }
  }

  applyTornadoSetup(): void {
    this.sim.freezeMerge = true;
    this.sim.freezeProd = true;
    this.sim.lockWin = true;
    this.sim.review = true;
    const t = this.sim.teams[BLUE];
    t.manaCap = Math.max(t.manaCap, 200);
    t.mana = Math.max(t.mana, 240);
    this.host.clearPlace();
    const s = this.world.startPad(BLUE);
    const toCx = WORLD * 0.5 - s.x;
    const toCz = WORLD * 0.5 - s.z;
    const len = Math.hypot(toCx, toCz) || 1;
    const fx = toCx / len;
    const fz = toCz / len;
    let aimX = s.x + fx * 9.0;
    let aimZ = s.z + fz * 9.0;
    for (const a of [9.0, 8.2, 10.2, 7.4]) {
      const x = s.x + fx * a;
      const z = s.z + fz * a;
      if (this.world.heightAt(x, z) > 0.5) {
        aimX = x;
        aimZ = z;
        break;
      }
    }
    const hx = aimX + fx * 3.55;
    const hz = aimZ + fz * 3.55;
    const wx = aimX + fx * 3.05;
    const wz = aimZ + fz * 3.05;
    const sx = aimX - fz * 6.2;
    const sz = aimZ + fx * 6.2;
    for (const b of this.sim.buildings) {
      if (b.team === BLUE && b.kind === "hut") b.hp = 0;
    }
    this.sim.buildings = this.sim.buildings.filter((b) => b.hp > 0);
    const victim = this.sim.placeComplete(BLUE, hx, hz, 0, "hut", 1);
    const safe = this.sim.placeComplete(BLUE, sx, sz, 0.4, "hut", 1);
    this.shotVictimId = victim.id;
    this.shotSafeId = safe.id;
    this.shotHutX = victim.x;
    this.shotHutZ = victim.z;
    const walkers = this.sim.units.filter((u) => u.team === BLUE && u.kind === "walker");
    while (walkers.length < 1) walkers.push(this.sim.addUnit(BLUE, "walker", wx, wz));
    const on = walkers[0]!;
    on.x = wx;
    on.z = wz;
    on.y = this.world.heightAt(on.x, on.z);
    on.job = "idle";
    on.path = [];
    on.think = 80;
    on.selected = true;
    this.shotWalkerId = on.id;
    for (let i = 1; i < walkers.length; i++) {
      const u = walkers[i]!;
      u.x = sx + 1.4 + i * 0.3;
      u.z = sz + 1.1;
      u.y = this.world.heightAt(u.x, u.z);
      u.job = "idle";
      u.path = [];
      u.think = 80;
      u.selected = false;
    }
    this.shotBeat = 0;
    this.view.rebuildTerrain();
    this.view.jump(aimX, aimZ);
    this.view.dist = 10.2;
    this.view.pitch = 0.76;
    this.sim.toast("点龙卷风图标，再点眼前这块地");
  }

  maybeHoldTornado(): void {
    if (typeof location === "undefined" || !location.search.includes("shot=tornado")) return;
    if (this.ended) return;
    const tw = this.sim.tornado;
    let hut = this.sim.buildings.find((b) => b.id === this.shotVictimId);
    const walker = this.sim.units.find((u) => u.id === this.shotWalkerId);
    if (this.shotBeat === 0 && tw && tw.t >= 0.58 && !this.paused) {
      this.paused = true;
      this.shotBeat = 1;
      this.view.hover(0, 0, false);
      this.view.jump(tw.x, tw.z);
      this.view.look.y = this.world.heightAt(tw.x, tw.z) + 1.15;
      this.view.dist = 8.8;
      this.view.pitch = 0.62;
      this.sim.toast("拍1 · 龙卷风在走");
      this.hud.toastT = 30;
      return;
    }
    if (tw && hut && hut.hp > 0 && this.shotBeat < 3) {
      const dx = hut.x - tw.x;
      const dz = hut.z - tw.z;
      const d = Math.hypot(dx, dz) || 1;
      tw.vx = (dx / d) * 1.35;
      tw.vz = (dz / d) * 1.35;
    }
    if (this.shotBeat === 1 && !this.paused && tw && tw.t >= 0.88) {
      let w = walker;
      if (!w || w.hp <= 0) {
        w = this.sim.addUnit(BLUE, "walker", tw.x, tw.z);
        this.shotWalkerId = w.id;
      }
      w.x = tw.x + 0.82;
      w.z = tw.z + 0.22;
      w.y = this.world.heightAt(w.x, w.z) + 1.62;
      w.hp = Math.max(1, w.hp);
      w.path = [];
      w.think = 80;
      this.sim.tornadoLift = true;
      this.sim.tornadoLiftX = w.x;
      this.sim.tornadoLiftZ = w.z;
      this.paused = true;
      this.shotBeat = 2;
      this.view.hover(0, 0, false);
      this.view.jump((tw.x + w.x) * 0.5, (tw.z + w.z) * 0.5);
      this.view.look.y = w.y + 0.15;
      this.view.dist = 7.2;
      this.view.pitch = 0.4;
      this.sim.toast("拍2 · 卷到人");
      this.hud.toastT = 30;
      return;
    }
    if (this.shotBeat === 2 && !this.paused && tw) {
      const near = hut && Math.hypot(hut.x - tw.x, hut.z - tw.z) < 2.35;
      if (near || this.sim.tornadoHouse || tw.t >= 2.4) {
        if (!hut || hut.hp <= 0) {
          const again = this.sim.placeComplete(BLUE, this.shotHutX, this.shotHutZ, 0, "hut", 1);
          this.shotVictimId = again.id;
          hut = again;
        }
        hut.shell = true;
        hut.hp = Math.max(1, hut.maxHp * 0.4);
        this.sim.tornadoHouse = true;
        this.paused = true;
        this.shotBeat = 3;
        this.view.hover(0, 0, false);
        this.view.jump(hut.x, hut.z);
        this.view.look.y = hut.y + 0.45;
        this.view.dist = 8.0;
        this.view.pitch = 0.5;
        this.sim.toast("拍3 · 卷成骨架");
        this.hud.toastT = 30;
      }
    }
  }

  applySkelSetup(): void {
    this.sim.freezeMerge = true;
    this.sim.freezeProd = true;
    this.sim.lockWin = true;
    this.sim.review = true;
    const t = this.sim.teams[BLUE];
    t.manaCap = Math.max(t.manaCap, 200);
    t.mana = Math.max(t.mana, 240);
    this.host.clearPlace();
    const s = this.world.startPad(BLUE);
    const toCx = WORLD * 0.5 - s.x;
    const toCz = WORLD * 0.5 - s.z;
    const len = Math.hypot(toCx, toCz) || 1;
    const fx = toCx / len;
    const fz = toCz / len;
    let aimX = s.x + fx * 9.0;
    let aimZ = s.z + fz * 9.0;
    for (const a of [9.0, 8.2, 10.2, 7.4]) {
      const x = s.x + fx * a;
      const z = s.z + fz * a;
      if (this.world.heightAt(x, z) > 0.5) {
        aimX = x;
        aimZ = z;
        break;
      }
    }
    const ang = 0.22;
    const hx = aimX + Math.cos(ang) * 3.5;
    const hz = aimZ + Math.sin(ang) * 3.5;
    const camYaw = 0.72;
    const sx = hx + Math.sin(camYaw) * 5.4;
    const sz = hz + Math.cos(camYaw) * 5.4;
    for (const b of this.sim.buildings) {
      if (b.team === BLUE && b.kind === "hut") b.hp = 0;
    }
    this.sim.buildings = this.sim.buildings.filter((b) => b.hp > 0);
    const victim = this.sim.placeComplete(BLUE, hx, hz, 0, "hut", 1);
    const safe = this.sim.placeComplete(BLUE, sx, sz, 0.3, "hut", 1);
    this.shotVictimId = victim.id;
    this.shotSafeId = safe.id;
    this.shotHutX = victim.x;
    this.shotHutZ = victim.z;
    this.shotBeat = 0;
    this.view.rebuildTerrain();
    this.view.jump(aimX, aimZ);
    this.view.dist = 9.6;
    this.view.pitch = 0.74;
    this.sim.toast("点火山图标，再点眼前这块空地");
  }

  maybeHoldSkel(): void {
    if (typeof location === "undefined" || !location.search.includes("shot=skel")) return;
    if (this.ended) return;
    const hut = this.sim.buildings.find((b) => b.id === this.shotVictimId);
    const safe = this.sim.buildings.find((b) => b.id === this.shotSafeId && b.hp > 0);
    const v = this.sim.volcano;
    if (this.shotBeat === 0 && hut && !hut.shell && v && v.t >= 0.45 && v.t < 0.95 && !this.paused) {
      this.paused = true;
      this.shotBeat = 1;
      this.view.jump(hut.x, hut.z);
      this.view.look.y = hut.y + 0.55;
      this.view.dist = 6.8;
      this.view.pitch = 0.46;
      this.sim.toast("拍1 · 完好");
      this.hud.toastT = 30;
      return;
    }
    if (this.shotBeat === 1 && !this.paused && hut && hut.hp > 0 && v && v.t >= 1.22) {
      if (!hut.shell) {
        hut.shell = true;
        hut.hp = Math.max(1, hut.maxHp * 0.4);
      }
      this.paused = true;
      this.shotBeat = 2;
      this.view.hover(0, 0, false);
      this.view.jump(hut.x, hut.z);
      this.view.look.y = hut.y + 0.4;
      this.view.dist = 8.4;
      this.view.pitch = 0.5;
      this.sim.toast("拍2 · 骨架");
      this.hud.toastT = 30;
      return;
    }
    if (this.shotBeat === 2 && !this.paused && safe) {
      if (hut && hut.shell && hut.hp > 0 && (v?.t ?? 0) >= 2.4) {
        hut.hp = 0;
        this.sim.buildings = this.sim.buildings.filter((b) => b.hp > 0);
      }
      const gone = !this.sim.buildings.find((b) => b.id === this.shotVictimId && b.hp > 0);
      if (gone) {
        this.paused = true;
        this.shotBeat = 3;
        this.view.hover(0, 0, false);
        this.view.jump((this.shotHutX + safe.x) * 0.5, (this.shotHutZ + safe.z) * 0.5);
        this.view.look.y = (safe.y + this.world.heightAt(this.shotHutX, this.shotHutZ)) * 0.5 + 0.25;
        this.view.dist = 13.5;
        this.view.pitch = 0.52;
        this.sim.toast("拍3 · 烧没了");
        this.hud.toastT = 30;
      }
    }
  }

  applyVolcanoSetup(): void {
    this.sim.freezeMerge = true;
    this.sim.freezeProd = true;
    this.sim.lockWin = true;
    this.sim.review = true;
    const t = this.sim.teams[BLUE];
    t.manaCap = Math.max(t.manaCap, 200);
    t.mana = Math.max(t.mana, 240);
    this.host.clearPlace();
    const s = this.world.startPad(BLUE);
    const toCx = WORLD * 0.5 - s.x;
    const toCz = WORLD * 0.5 - s.z;
    const len = Math.hypot(toCx, toCz) || 1;
    const fx = toCx / len;
    const fz = toCz / len;
    const px = -fz;
    const pz = fx;
    let aimX = s.x + fx * 9.0;
    let aimZ = s.z + fz * 9.0;
    for (const a of [9.0, 8.2, 10.2, 7.4]) {
      const x = s.x + fx * a;
      const z = s.z + fz * a;
      if (this.world.heightAt(x, z) > 0.45) {
        aimX = x;
        aimZ = z;
        break;
      }
    }
    const walkers = this.sim.units.filter((u) => u.team === BLUE && u.kind === "walker");
    while (walkers.length < 2) walkers.push(this.sim.addUnit(BLUE, "walker", aimX, aimZ));
    const on = walkers[0]!;
    on.x = aimX + 1.55;
    on.z = aimZ + 0.85;
    on.y = this.world.heightAt(on.x, on.z);
    on.job = "idle";
    on.path = [];
    on.think = 20;
    on.selected = true;
    const chop = walkers[1]!;
    const tree = this.sim.nearestTree(aimX + px * 5.2, aimZ + pz * 5.2);
    if (tree) {
      const td = Math.hypot(tree.x - aimX, tree.z - aimZ);
      if (td < 4.6 || td > 7.2) {
        tree.x = aimX + px * 5.4;
        tree.z = aimZ + pz * 5.4;
      }
      chop.x = tree.x + 0.5;
      chop.z = tree.z + 0.3;
      chop.y = this.world.heightAt(chop.x, chop.z);
      chop.job = "chop";
      chop.targetId = tree.id;
      chop.channel = 0.2;
      chop.path = [];
      chop.think = 30;
      chop.selected = false;
    }
    this.shotBeat = 0;
    this.view.rebuildTerrain();
    this.view.jump(aimX, aimZ);
    this.view.dist = 10;
    this.view.pitch = 0.82;
    this.sim.toast("点火山图标，再点眼前这块地");
  }

  applyQuakeSetup(): void {
    this.sim.freezeMerge = true;
    this.sim.freezeProd = true;
    this.sim.lockWin = true;
    this.sim.review = true;
    const t = this.sim.teams[BLUE];
    t.manaCap = Math.max(t.manaCap, 200);
    t.mana = Math.max(t.mana, 240);
    this.host.clearPlace();
    const s = this.world.startPad(BLUE);
    const toCx = WORLD * 0.5 - s.x;
    const toCz = WORLD * 0.5 - s.z;
    const len = Math.hypot(toCx, toCz) || 1;
    const fx = toCx / len;
    const fz = toCz / len;
    let aimX = s.x + fx * 9.0;
    let aimZ = s.z + fz * 9.0;
    for (const a of [9.0, 8.2, 10.2, 7.4]) {
      const x = s.x + fx * a;
      const z = s.z + fz * a;
      if (this.world.heightAt(x, z) > 0.5) {
        aimX = x;
        aimZ = z;
        break;
      }
    }
    const ang0 = 3.86;
    const vx = aimX + Math.cos(ang0) * 3.55;
    const vz = aimZ + Math.sin(ang0) * 3.55;
    const sx = aimX + -Math.sin(ang0) * 5.6;
    const sz = aimZ + Math.cos(ang0) * 5.6;
    const wx = aimX + Math.cos(ang0) * 1.45 - Math.sin(ang0) * 0.42;
    const wz = aimZ + Math.sin(ang0) * 1.45 + Math.cos(ang0) * 0.42;
    for (const b of this.sim.buildings) {
      if (b.team === BLUE && b.kind === "hut") b.hp = 0;
    }
    this.sim.buildings = this.sim.buildings.filter((b) => b.hp > 0);
    const victim = this.sim.placeComplete(BLUE, vx, vz, 0, "hut", 1);
    const safe = this.sim.placeComplete(BLUE, sx, sz, 0.4, "hut", 1);
    this.shotVictimId = victim.id;
    this.shotSafeId = safe.id;
    const walkers = this.sim.units.filter((u) => u.team === BLUE && u.kind === "walker");
    while (walkers.length < 1) walkers.push(this.sim.addUnit(BLUE, "walker", wx, wz));
    const on = walkers[0]!;
    on.x = wx;
    on.z = wz;
    on.y = this.world.heightAt(on.x, on.z);
    on.job = "idle";
    on.path = [];
    on.think = 80;
    on.selected = true;
    this.shotWalkerId = on.id;
    for (let i = 1; i < walkers.length; i++) {
      const u = walkers[i]!;
      u.x = sx + 1.6 + i * 0.3;
      u.z = sz + 1.2;
      u.y = this.world.heightAt(u.x, u.z);
      u.job = "idle";
      u.path = [];
      u.think = 80;
      u.selected = false;
    }
    this.shotBeat = 0;
    this.view.rebuildTerrain();
    this.view.jump(aimX, aimZ);
    this.view.dist = 10.4;
    this.view.pitch = 0.78;
    this.sim.toast("点地震图标，再点眼前这块地");
  }

  maybeHoldQuake(): void {
    if (typeof location === "undefined" || !location.search.includes("shot=quake")) return;
    if (this.ended) return;
    const q = this.sim.quake;
    if (this.shotBeat === 0 && q && q.t >= 0.62 && q.t < 0.98 && !this.paused) {
      this.paused = true;
      this.shotBeat = 1;
      this.view.jump(q.x, q.z);
      this.view.dist = 9.2;
      this.view.pitch = 0.72;
      this.sim.toast("拍1 · 地裂");
      this.hud.toastT = 30;
      return;
    }
    if (this.shotBeat === 1 && !this.paused && q && q.t >= 1.02) {
      const opened = Math.max(0.4, Math.min(q.opened[0] ?? 0, 1.55));
      const p = this.sim.crackPoint(q, 0, opened);
      let walker = this.sim.units.find((u) => u.id === this.shotWalkerId);
      if (!walker || walker.hp <= 0) {
        walker = this.sim.addUnit(BLUE, "walker", p.x, p.z);
        this.shotWalkerId = walker.id;
      }
      walker.x = p.x + 0.22;
      walker.z = p.z + 0.06;
      walker.y = this.world.heightAt(p.x, p.z);
      walker.hp = walker.maxHp;
      walker.path = [];
      walker.pathI = 0;
      walker.think = 80;
      walker.job = "idle";
      walker.selected = true;
      this.paused = true;
      this.shotBeat = 2;
      this.view.jump(walker.x, walker.z);
      this.view.dist = 5.6;
      this.view.pitch = 0.55;
      this.sim.toast("拍2 · 滑进缝");
      this.hud.toastT = 30;
      return;
    }
    if (this.shotBeat === 2 && !this.paused) {
      const victim = this.sim.buildings.find((b) => b.id === this.shotVictimId);
      const safe = this.sim.buildings.find((b) => b.id === this.shotSafeId && b.hp > 0);
      if (victim && (q?.t ?? 0) >= 1.48) {
        victim.hp = 0;
        this.sim.buildings = this.sim.buildings.filter((b) => b.hp > 0);
      }
      const gone = !this.sim.buildings.find((b) => b.id === this.shotVictimId && b.hp > 0);
      if (gone && safe) {
        this.paused = true;
        this.shotBeat = 3;
        this.view.jump((safe.x + (q?.x ?? safe.x)) * 0.5, (safe.z + (q?.z ?? safe.z)) * 0.5);
        this.view.dist = 13.2;
        this.view.pitch = 0.68;
        this.sim.toast("拍3 · 裂到的倒了");
        this.hud.toastT = 30;
      }
    }
  }

  maybeHoldVolcano(): void {
    if (typeof location === "undefined" || !location.search.includes("shot=volcano")) return;
    if (this.ended) return;
    const v = this.sim.volcano;
    let lavaN = 0;
    let scorchN = 0;
    for (let i = 0; i < this.world.lava.length; i++) {
      if (this.world.lava[i]! > 0) lavaN++;
      if (this.world.scorch[i]! > 0.4) scorchN++;
    }
    if (this.shotBeat === 0 && v && v.t >= 0.75 && v.t < 1.08 && !this.paused) {
      this.paused = true;
      this.shotBeat = 1;
      this.view.jump(v.x, v.z);
      this.view.dist = 8.6;
      this.sim.toast("拍1 · 地在抬");
      this.hud.toastT = 30;
      return;
    }
    if (this.shotBeat === 1 && !this.paused && v && v.t >= 1.55 && lavaN > 8) {
      this.paused = true;
      this.shotBeat = 2;
      this.view.jump(v.x, v.z);
      this.view.dist = 12;
      this.view.pitch = 0.62;
      this.sim.toast("拍2 · 岩浆外流");
      this.hud.toastT = 30;
      return;
    }
    if (this.shotBeat === 2 && !this.paused && v) {
      const tips = this.world.lastRiverTips;
      if (tips.length) {
        for (const p of tips) this.sim.fxSplash.push(p);
      } else {
        this.sim.fxSplash.push({ x: v.x + 0.8, z: v.z }, { x: v.x - 0.6, z: v.z + 0.5 }, { x: v.x, z: v.z - 0.7 });
      }
      this.paused = true;
      this.shotBeat = 3;
      this.view.jump(v.x, v.z);
      this.view.dist = 11;
      this.view.pitch = 0.6;
      this.sim.toast("拍2 · 飞溅");
      this.hud.toastT = 30;
    }
  }

  maybeHoldShot(): void {
    if (typeof location === "undefined" || !location.search.includes("shot=1")) return;
    if (this.paused || this.ended) return;
    const camp = this.sim.buildings.find((b) => b.team === BLUE && b.kind === "warriorHut" && b.hp > 0);
    if (!camp) return;
    const q = this.sim.trainQueue(camp.id);
    const soldiers = this.sim.countKind(BLUE, "warrior");
    const at = q.filter((u, i) => {
      const slot = this.sim.trainSlotPos(camp, i);
      return (u.x - slot.x) * (u.x - slot.x) + (u.z - slot.z) * (u.z - slot.z) <= 0.22 * 0.22;
    });
    if (this.shotBeat === 0 && q.length >= 4 && soldiers === 0 && at.length >= 3) {
      this.paused = true;
      this.shotBeat = 1;
      return;
    }
    if (this.shotBeat === 1 && soldiers >= 1 && q.length >= 1) {
      const p0 = this.sim.trainSlotPos(camp, 0);
      const n0 = q[0]!;
      if ((n0.x - p0.x) * (n0.x - p0.x) + (n0.z - p0.z) * (n0.z - p0.z) <= 0.4 * 0.4) {
        this.paused = true;
        this.shotBeat = 2;
      }
    }
  }

  checkFrameHold(bolts: Array<{ life: number }> = []): void {
    if (!this.shotHeld) {
      this.maybeHoldShot();
      this.maybeHoldSwamp();
      this.maybeHoldVolcano();
      this.maybeHoldQuake();
      this.maybeHoldSkel();
      this.maybeHoldTornado();
      this.maybeHoldLightning(bolts);
      this.maybeHoldBlast();
      this.maybeHoldHouse();
      this.maybeHoldPath();
      this.maybeHoldLive();
      this.maybeHoldFight();
      if (this.paused) this.shotHeld = true;
    }
  }

  postRender(): void {
    this.keepLightningShotPose();
    this.keepBlastShotPose();
  }
}
