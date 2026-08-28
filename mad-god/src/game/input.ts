import { View } from "./render";
import { Tool, TrainKind } from "./types";

const BOX_PX = 8;
const SCULPT_HOLD_MS = 140;

export interface InputState {
  keys: Set<string>;
  tool: Tool;
  mx: number;
  my: number;
  dragging: boolean;
  rDragging: boolean;
  rotating: boolean;
  lastX: number;
  lastY: number;
  painted: boolean;
  holdX: number;
  holdZ: number;
  holding: boolean;
  downX: number;
  downY: number;
  downTime: number;
  hitUnit: boolean;
  pending: boolean;
  boxSelecting: boolean;
  sculpting: boolean;
  placing?: boolean;
}

type Handlers = {
  onPrimary: (cx: number, cz: number, shift: boolean) => void;
  onSecondary: (cx: number, cz: number, sx?: number, sy?: number) => void;
  onSelect: (cx: number, cz: number) => void;
  onPick: (sx: number, sy: number, cell: { x: number; z: number } | null) => boolean;
  onBoxSelect: (x0: number, y0: number, x1: number, y1: number) => void;
  onClearSelect: () => void;
  onPause: () => void;
  onTool: (t: Tool) => void;
  onOrder: (o: "settle" | "gather" | "fight" | "shaman") => void;
  onTrain: (k: TrainKind) => void;
  onYaw: (dir: number) => void;
  isPlacing?: () => boolean;
};

function placingNow(state: InputState, handlers: Handlers): boolean {
  if (handlers.isPlacing) return handlers.isPlacing();
  return !!state.placing;
}

function selBoxEl(): HTMLDivElement {
  let el = document.getElementById("sel-box") as HTMLDivElement | null;
  if (!el) {
    el = document.createElement("div");
    el.id = "sel-box";
    el.hidden = true;
    (document.getElementById("app") ?? document.body).appendChild(el);
  }
  return el;
}

function showSelBox(x0: number, y0: number, x1: number, y1: number): void {
  const el = selBoxEl();
  const left = Math.min(x0, x1);
  const top = Math.min(y0, y1);
  el.style.left = `${left}px`;
  el.style.top = `${top}px`;
  el.style.width = `${Math.abs(x1 - x0)}px`;
  el.style.height = `${Math.abs(y1 - y0)}px`;
  el.hidden = false;
}

function hideSelBox(): void {
  const el = document.getElementById("sel-box");
  if (el) el.hidden = true;
}

function isSculptTool(tool: Tool): boolean {
  return tool === "raise" || tool === "lower";
}

export function bindInput(canvas: HTMLCanvasElement, view: View, state: InputState, handlers: Handlers): void {
  canvas.addEventListener("contextmenu", (e) => e.preventDefault());

  window.addEventListener("keydown", (e) => {
    if (e.code === "ArrowLeft" || e.code === "ArrowRight" || e.code === "ArrowUp" || e.code === "ArrowDown") {
      e.preventDefault();
      state.keys.add(e.code);
    }
  });
  window.addEventListener("keyup", (e) => state.keys.delete(e.code));

  canvas.addEventListener("pointerdown", (e) => {
    state.lastX = e.clientX;
    state.lastY = e.clientY;
    if (e.button === 1) {
      state.rotating = true;
      canvas.setPointerCapture(e.pointerId);
      return;
    }
    if (e.button === 2) {
      state.rDragging = false;
      state.holding = false;
      state.sculpting = false;
      const cell = ndcCell(e, canvas, view);
      handlers.onSecondary(cell?.x ?? Number.NaN, cell?.z ?? Number.NaN, e.clientX, e.clientY);
      return;
    }
    if (e.button === 0) {
      state.dragging = true;
      state.painted = false;
      state.downX = e.clientX;
      state.downY = e.clientY;
      state.downTime = performance.now();
      state.boxSelecting = false;
      state.sculpting = false;
      state.holding = false;
      canvas.setPointerCapture(e.pointerId);
      const cell = ndcCell(e, canvas, view);
      if (cell) {
        state.holdX = cell.x;
        state.holdZ = cell.z;
      }
      if (placingNow(state, handlers)) {
        state.hitUnit = false;
        state.pending = false;
        return;
      }
      if (handlers.onPick(e.clientX, e.clientY, cell)) {
        state.hitUnit = true;
        state.pending = false;
      } else {
        state.hitUnit = false;
        state.pending = true;
      }
    }
  });

  canvas.addEventListener("pointermove", (e) => {
    state.mx = e.clientX;
    state.my = e.clientY;
    const dx = e.clientX - state.lastX;
    const dy = e.clientY - state.lastY;
    state.lastX = e.clientX;
    state.lastY = e.clientY;
    if (state.rotating || e.buttons & 4) {
      view.yaw -= dx * 0.008;
      view.pitch = Math.max(0.28, Math.min(1.2, view.pitch + dy * 0.006));
    }
    if (state.dragging && !state.hitUnit && !placingNow(state, handlers)) {
      const moved = Math.hypot(e.clientX - state.downX, e.clientY - state.downY);
      if (state.boxSelecting || moved > BOX_PX) {
        state.boxSelecting = true;
        state.pending = false;
        state.holding = false;
        state.sculpting = false;
        showSelBox(state.downX, state.downY, e.clientX, e.clientY);
        return;
      }
      if (state.sculpting && isSculptTool(state.tool)) {
        const cell = ndcCell(e, canvas, view);
        if (cell) {
          state.holdX = cell.x;
          state.holdZ = cell.z;
          state.holding = true;
        }
      }
    }
  });

  canvas.addEventListener("pointerup", (e) => {
    if (e.button === 1) state.rotating = false;
    if (e.button === 2) {
      state.rDragging = false;
      state.holding = false;
      state.sculpting = false;
    }
    if (e.button === 0 && state.dragging) {
      const moved = Math.hypot(e.clientX - state.downX, e.clientY - state.downY);
      const placing = placingNow(state, handlers);
      const wasBox = !placing && (state.boxSelecting || moved > BOX_PX);
      const wasSculpt = state.sculpting;
      const wasHit = state.hitUnit;
      state.dragging = false;
      state.holding = false;
      state.sculpting = false;
      state.pending = false;
      state.boxSelecting = false;
      state.hitUnit = false;
      hideSelBox();
      if (placing) {
        const cell = ndcCell(e, canvas, view);
        if (cell) handlers.onPrimary(cell.x, cell.z, e.shiftKey);
        return;
      }
      if (wasBox) {
        handlers.onBoxSelect(state.downX, state.downY, e.clientX, e.clientY);
        return;
      }
      if (wasHit || wasSculpt) return;
      const cell = ndcCell(e, canvas, view);
      if (!cell) return;
      if (isSculptTool(state.tool)) return;
      handlers.onPrimary(cell.x, cell.z, e.shiftKey);
    }
  });

  document.addEventListener(
    "wheel",
    (e) => {
      if (placingNow(state, handlers)) {
        e.preventDefault();
        e.stopImmediatePropagation();
        handlers.onYaw(e.deltaY > 0 ? 1 : -1);
        return;
      }
      const onCanvas = e.target === canvas || (e.target instanceof Node && canvas.contains(e.target));
      if (!onCanvas) return;
      e.preventDefault();
      view.dist = Math.max(8, Math.min(42, view.dist + e.deltaY * 0.02));
    },
    { passive: false, capture: true },
  );
}

export function maybeStartSculpt(state: InputState): void {
  if (!state.dragging || state.hitUnit || state.boxSelecting || state.sculpting || !state.pending) return;
  if (state.placing || !isSculptTool(state.tool)) return;
  const moved = Math.hypot(state.mx - state.downX, state.my - state.downY);
  if (moved > BOX_PX) return;
  if (performance.now() - state.downTime < SCULPT_HOLD_MS) return;
  state.sculpting = true;
  state.pending = false;
  state.holding = true;
  state.painted = true;
}

export function ndcCell(
  e: { clientX: number; clientY: number },
  canvas: HTMLCanvasElement,
  view: View,
): { x: number; z: number } | null {
  const r = canvas.getBoundingClientRect();
  const x = ((e.clientX - r.left) / r.width) * 2 - 1;
  const y = -(((e.clientY - r.top) / r.height) * 2 - 1);
  return view.pickCell(x, y);
}

export function tickCamera(view: View, keys: Set<string>, dt: number): void {
  let dx = 0;
  let dz = 0;
  if (keys.has("ArrowLeft")) dx -= 1;
  if (keys.has("ArrowRight")) dx += 1;
  if (keys.has("ArrowUp")) dz -= 1;
  if (keys.has("ArrowDown")) dz += 1;
  if (dx || dz) view.pan(dx, dz, dt);
}
