import { canUnlock } from "./spells";
import { Sim } from "./sim";
import { BLUE, BuildingKind, RED, SIZE, Tool, TrainKind, WATER } from "./types";
import { World } from "./world";

export class HUD {
  manaFill = document.getElementById("mana-fill") as HTMLElement;
  manaText = document.getElementById("mana-text") as HTMLElement;
  popB = document.getElementById("pop-blue") as HTMLElement;
  popR = document.getElementById("pop-red") as HTMLElement;
  housesB = document.getElementById("houses-blue") as HTMLElement;
  housesR = document.getElementById("houses-red") as HTMLElement;
  warB = document.getElementById("war-blue") as HTMLElement;
  toastEl = document.getElementById("toast") as HTMLElement;
  pauseTag = document.getElementById("pause-tag") as HTMLElement;
  pauseBtn = document.getElementById("btn-pause") as HTMLElement | null;
  mini = document.getElementById("minimap") as HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  lastToastGen = 0;
  toastT = 0;

  constructor() {
    this.ctx = this.mini.getContext("2d")!;
  }

  bind(
    onTool: (t: Tool) => void,
    onOrder: (o: "settle" | "gather" | "fight" | "shaman" | "guard") => void,
    onTrain: (k: TrainKind) => void,
    onMini: (x: number, z: number) => void,
    onBuild: (k: BuildingKind) => void,
    onPause: () => void,
  ): void {
    document.querySelectorAll<HTMLButtonElement>("[data-tool]").forEach((btn) => {
      btn.addEventListener("click", () => onTool(btn.dataset.tool as Tool));
    });
    document.querySelectorAll<HTMLButtonElement>("[data-order]").forEach((btn) => {
      btn.addEventListener("click", () =>
        onOrder(btn.dataset.order as "settle" | "gather" | "fight" | "shaman" | "guard"),
      );
    });
    document.querySelectorAll<HTMLButtonElement>("[data-build]").forEach((btn) => {
      btn.addEventListener("click", () => onBuild(btn.dataset.build as BuildingKind));
    });
    const bindTrain = (id: string, k: TrainKind) => {
      const el = document.getElementById(id);
      if (el) el.addEventListener("click", () => onTrain(k));
    };
    bindTrain("btn-warrior", "warrior");
    bindTrain("btn-preacher", "preacher");
    bindTrain("btn-firewarrior", "firewarrior");
    bindTrain("btn-spy", "spy");
    this.pauseBtn?.addEventListener("click", () => onPause());
    this.mini.addEventListener("click", (e) => {
      const r = this.mini.getBoundingClientRect();
      const x = ((e.clientX - r.left) / r.width) * SIZE;
      const z = ((e.clientY - r.top) / r.height) * SIZE;
      onMini(x, z);
    });
  }

  setTool(tool: Tool): void {
    document.querySelectorAll<HTMLButtonElement>("[data-tool]").forEach((b) => {
      b.classList.toggle("on", b.dataset.tool === tool);
    });
  }

  setBuild(kind: BuildingKind | null): void {
    document.querySelectorAll<HTMLButtonElement>("[data-build]").forEach((b) => {
      b.classList.toggle("on", !!kind && b.dataset.build === kind);
    });
  }

  setOrder(order: string): void {
    document.querySelectorAll<HTMLButtonElement>("[data-order]").forEach((b) => {
      b.classList.toggle("on", b.dataset.order === order);
    });
  }

  sync(sim: Sim, tool: Tool, paused: boolean, dt: number): void {
    const t = sim.teams[BLUE];
    const pct = t.manaCap ? (t.mana / t.manaCap) * 100 : 0;
    this.manaFill.style.width = `${pct}%`;
    this.manaText.textContent = `${t.mana | 0} / ${t.manaCap | 0}`;
    // v0.15：人口上限已移除（感化加人不受限，上限只会拦死出生），只显示子民数。
    this.popB.textContent = String(sim.countPop(BLUE));
    this.popR.textContent = String(sim.countPop(RED));
    this.housesB.textContent = String(sim.countHouses(BLUE));
    this.housesR.textContent = String(sim.countHouses(RED));
    const soldiers =
      sim.countKind(BLUE, "warrior") +
      sim.countKind(BLUE, "preacher") +
      sim.countKind(BLUE, "firewarrior");
    this.warB.textContent = String(soldiers);
    const woodEl = document.getElementById("wood-blue");
    if (woodEl) woodEl.textContent = String(sim.countWood(BLUE));
    const wEl = document.getElementById("split-war");
    const pEl = document.getElementById("split-preach");
    const fEl = document.getElementById("split-fire");
    const sEl = document.getElementById("split-spy");
    if (wEl) wEl.textContent = String(sim.countKind(BLUE, "warrior"));
    if (pEl) pEl.textContent = String(sim.countKind(BLUE, "preacher"));
    if (fEl) fEl.textContent = String(sim.countKind(BLUE, "firewarrior"));
    if (sEl) sEl.textContent = String(sim.countKind(BLUE, "spy"));
    this.pauseTag.hidden = !paused;
    if (typeof location !== "undefined" && location.search.includes("shot=blast")) {
      this.pauseTag.hidden = true;
    }
    if (this.pauseBtn) this.pauseBtn.textContent = paused ? "继续" : "暂停";

    document.querySelectorAll<HTMLButtonElement>("[data-tool]").forEach((b) => {
      const k = b.dataset.tool as Tool;
      b.disabled = sim.armageddon || !canUnlock(k, t.manaCap);
    });

    const cmd = document.getElementById("sel-commands");
    if (cmd) cmd.hidden = false;
    void tool;

    const banner = document.getElementById("arma-banner");
    if (banner) banner.hidden = !sim.armageddon;

    const last = sim.logs[sim.logs.length - 1] ?? "";
    if (last && sim.toastGen !== this.lastToastGen) {
      this.lastToastGen = sim.toastGen;
      this.toastEl.textContent = last;
      this.toastEl.classList.add("show");
      this.toastT = 5.0;
    }
    if (this.toastT > 0 && !paused) {
      this.toastT -= dt;
      if (this.toastT <= 0) this.toastEl.classList.remove("show");
    }
    this.drawMini(sim.world, sim);
  }

  drawMini(world: World, sim: Sim): void {
    const c = this.ctx;
    const w = this.mini.width;
    const cell = w / SIZE;
    c.clearRect(0, 0, w, w);
    for (let z = 0; z < SIZE; z++) {
      for (let x = 0; x < SIZE; x++) {
        const h = world.heightAt(x + 0.5, z + 0.5);
        const i = world.sampleAt(x + 0.5, z + 0.5);
        if (world.lava[i]! > 0) c.fillStyle = "#e85d04";
        else if (world.swamp[i]! > 0) c.fillStyle = "#3d5c3a";
        else if (h <= WATER) c.fillStyle = "#1a3a5a";
        else {
          const g = 70 + h * 18;
          c.fillStyle = `rgb(${60 + h * 8},${g},${40 + h * 4})`;
        }
        c.fillRect(x * cell, z * cell, cell + 0.5, cell + 0.5);
      }
    }
    for (const t of sim.trees) {
      if (!t.alive) continue;
      c.fillStyle = "#1a3d1a";
      c.fillRect(t.x * cell, t.z * cell, 2, 2);
    }
    for (const b of sim.buildings) {
      c.fillStyle = b.team === BLUE ? "#7ec8f0" : "#f07060";
      c.fillRect(b.x * cell - 1, b.z * cell - 1, 3, 3);
    }
    for (const u of sim.units) {
      if (u.homeId > 0) continue;
      c.fillStyle = u.team === BLUE ? "#d8f4ff" : u.team === RED ? "#ffd0c8" : "#c4a070";
      c.fillRect(u.x * cell, u.z * cell, 2, 2);
    }
  }
}

export function showEnd(win: boolean, draw: boolean): void {
  const el = document.getElementById("end")!;
  const title = document.getElementById("end-title")!;
  const msg = document.getElementById("end-msg")!;
  el.hidden = false;
  if (draw) {
    title.textContent = "同归于尽";
    msg.textContent = "两方子民同时灭绝。小岛重归沉寂。";
  } else if (win) {
    title.textContent = "你击败了敌对神明";
    msg.textContent = "红方的屋宇与子民尽数覆灭。这座岛，此刻只回响你的谕令。";
  } else {
    title.textContent = "你的子民已全部灭亡";
    msg.textContent = "敌神踏平了你的聚落。再抬一次手，改写结局。";
  }
}
