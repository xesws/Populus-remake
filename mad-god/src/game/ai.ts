import { canUnlock, cast, flattenToward } from "./spells";
import { Sim } from "./sim";
import { BLUE, Cell, dist2, inMap, RED, Team, TOOL_COST, TrainKind, WORLD } from "./types";
import { World } from "./world";

export class GodAI {
  acc = 0;
  team: Team = RED;
  lastMsg = "";
  spellCd = 90;
  trainCd = 0;

  update(sim: Sim, dt: number): void {
    this.acc += dt;
    this.spellCd = Math.max(0, this.spellCd - dt);
    this.trainCd = Math.max(0, this.trainCd - dt);
    if (this.acc < 1) return;
    this.acc = 0;
    if (sim.winner !== null) return;
    this.plan(sim);
  }

  plan(sim: Sim): void {
    const me = this.team;
    const foe = me === RED ? BLUE : RED;
    const myPop = sim.countPop(me);
    const myWalk = sim.countKind(me, "walker");
    const myWar = sim.countKind(me, "warrior");
    const myPreach = sim.countKind(me, "preacher");
    const myFire = sim.countKind(me, "firewarrior");
    const mySpy = sim.countKind(me, "spy");
    const foeWalk = sim.countKind(foe, "walker");
    const myHouses = sim.buildings.filter((b) => b.team === me);
    const foeHouses = sim.buildings.filter((b) => b.team === foe);
    const foeUnits = sim.units.filter((u) => u.team === foe);

    if (sim.time >= 50 && this.trainCd <= 0 && myWalk >= 4 && myHouses.length >= 1) {
      let kind: TrainKind = "warrior";
      if (myWar < 2) kind = "warrior";
      else if (myPreach < 1 && foeWalk >= 1) kind = "preacher";
      else if (myFire < 1) kind = "firewarrior";
      else if (mySpy < 1) kind = "spy";
      else if (myPreach < 2 && foeWalk >= 2) kind = "preacher";
      else if (myFire < myWar) kind = "firewarrior";
      else kind = "warrior";
      const trainee = sim.units.find((u) => u.team === me && u.kind === "walker" && u.carry === 0 && u.job !== "train");
      if (trainee) trainee.selected = true;
      if (sim.train(me, kind)) this.trainCd = 8.0;
      else this.trainCd = 12.0;
      if (trainee) trainee.selected = false;
    }

    const warNow = myWar + myPreach + myFire;
    const mine = sim.units.filter((u) => u.team === me);
    for (const u of mine) u.selected = true;
    if (warNow >= 2 || (warNow >= 1 && foeHouses.length > 0 && myPop >= 7)) {
      if (sim.teams[me].order !== "fight") sim.setOrder(me, "fight");
      const focus = this.cluster(foeHouses, foeUnits);
      if (focus) sim.setMagnet(me, focus.x, focus.z);
    } else if (!sim.teams[me].hasShaman) {
      sim.setOrder(me, "shaman");
    } else {
      sim.setOrder(me, "settle");
    }
    for (const u of mine) u.selected = false;

    if (!sim.armageddon) {
      this.castOffense(sim, foeHouses, foeUnits);
    }

    if (sim.teams[me].mana >= 40) this.improveSettlements(sim, myHouses);
    if (sim.time >= 40 && sim.teams[me].mana >= 50) this.expandFrontier(sim, myHouses, foeHouses);
    if (sim.teams[me].mana > sim.teams[me].manaCap * 0.55) {
      this.spendIdle(sim, myHouses);
    }
  }

  improveSettlements(sim: Sim, houses: { x: number; z: number }[]): void {
    if (!houses.length) {
      const w = sim.units.find((u) => u.team === this.team && u.kind === "walker");
      if (w) this.flattenPatch(sim, w.x, w.z, 1.4);
      return;
    }
    let best: { x: number; z: number; miss: Cell[] } | null = null;
    for (const h of houses) {
      const th = sim.world.heightAt(h.x, h.z);
      const miss = sim.world.countMismatch(h.x, h.z, 2.2, th);
      if (miss.length && (!best || miss.length > best.miss.length)) {
        best = { x: h.x, z: h.z, miss };
      }
    }
    if (!best) return;
    let n = 0;
    for (const c of best.miss) {
      if (n >= 4) break;
      const th = sim.world.heightAt(best.x, best.z);
      if (flattenToward(sim, this.team, c.x, c.z, th)) n++;
    }
  }

  flattenPatch(sim: Sim, cx: number, cz: number, r: number): void {
    let th = sim.world.heightAt(cx, cz);
    if (th <= 0.2) th = 1.6;
    let n = 0;
    for (let z = cz - r; z <= cz + r; z += 0.6) {
      for (let x = cx - r; x <= cx + r; x += 0.6) {
        if (n >= 5) return;
        if (flattenToward(sim, this.team, x, z, th)) n++;
      }
    }
  }

  expandFrontier(
    sim: Sim,
    mine: { x: number; z: number }[],
    foe: { x: number; z: number }[],
  ): void {
    const dest = foe[0] ?? { x: 11, z: 38 };
    const from = mine[0] ?? { x: 39, z: 12 };
    let edits = 0;
    for (let i = 1; i <= 10 && edits < 3; i++) {
      const t = i / 12;
      const x = from.x + (dest.x - from.x) * t;
      const z = from.z + (dest.z - from.z) * t;
      if (!inMap(x, z)) continue;
      if (sim.world.heightAt(x, z) <= 1) {
        if (flattenToward(sim, this.team, x, z, 1.8)) edits++;
      }
    }
    if (sim.teams[this.team].mana > 30 && mine.length < 8) {
      const site = this.pickNewPlot(sim.world, from, dest);
      if (site) this.flattenPatch(sim, site.x, site.z, 1.4);
    }
  }

  pickNewPlot(world: World, from: Cell, dest: Cell): Cell | null {
    let best: Cell | null = null;
    let bestScore = -1e9;
    for (let i = 0; i < 20; i++) {
      const x = Math.max(2, Math.min(WORLD - 3, from.x + Math.random() * 17 - 6));
      const z = Math.max(2, Math.min(WORLD - 3, from.z + Math.random() * 17 - 6));
      if (world.heightAt(x, z) <= 0.2) continue;
      const toward = -dist2(x, z, dest.x, dest.z) * 0.02;
      const lv = world.houseLevelAt(x, z, 0);
      const score = toward + lv * 3 + world.heightAt(x, z);
      if (score > bestScore) {
        bestScore = score;
        best = { x, z };
      }
    }
    return best;
  }

  cluster(
    houses: { x: number; z: number }[],
    units: { x: number; z: number }[],
  ): Cell | null {
    const pts = [
      ...houses.map((h) => ({ x: h.x, z: h.z })),
      ...units.map((u) => ({ x: u.x, z: u.z })),
    ];
    if (!pts.length) return null;
    let best = pts[0]!;
    let bestN = -1;
    for (const p of pts) {
      let n = 0;
      for (const q of pts) if (dist2(p.x, p.z, q.x, q.z) < 20) n++;
      if (n > bestN) {
        bestN = n;
        best = p;
      }
    }
    return best;
  }

  castOffense(
    sim: Sim,
    foeHouses: { x: number; z: number }[],
    foeUnits: { x: number; z: number }[],
  ): void {
    if (this.spellCd > 0 || sim.armageddon) return;
    const me = this.team;
    const cap = sim.teams[me].manaCap;
    const mana = sim.teams[me].mana;
    const cluster = this.cluster(foeHouses, foeUnits);
    if (!cluster) return;
    const density = foeHouses.filter((h) => dist2(h.x, h.z, cluster.x, cluster.z) < 16).length;
    if (canUnlock("armageddon", cap) && mana >= TOOL_COST.armageddon) {
      if (cast(sim, me, "armageddon", cluster.x, cluster.z).ok) {
        this.spellCd = 99;
        return;
      }
    }
    if (canUnlock("volcano", cap) && mana >= TOOL_COST.volcano && density >= 2) {
      if (cast(sim, me, "volcano", cluster.x, cluster.z).ok) this.spellCd = 12;
    }
  }

  spendIdle(sim: Sim, mine: { x: number; z: number }[]): void {
    const h = mine[0];
    if (h) this.flattenPatch(sim, h.x, h.z, 2.2);
  }
}
