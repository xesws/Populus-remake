import { Game } from "./game/game";
import { WorkerSimClient } from "./game/client/worker-sim-client";
import "./style.css";

const canvas = document.getElementById("view") as HTMLCanvasElement;
const hud = document.getElementById("hud")!;
const overlay = document.getElementById("overlay")!;
const btnStart = document.getElementById("btn-start")!;
const btnAgain = document.getElementById("btn-again")!;

// v0.29c-2 ?worker=1 灰度开关：Sim 搬进 Web Worker，主线程持 WorkerSimClient 镜像客户端。
// 默认（不带参数）走本地模式——构造与开局路径和 v0.29b 完全一致。
const workerMode = new URLSearchParams(location.search).get("worker") === "1";

function wireUi(game: Game): void {
  (window as unknown as { game: Game }).game = game;

  btnStart.addEventListener("click", () => {
    overlay.hidden = true;
    hud.hidden = false;
    game.start();
  });

  btnAgain.addEventListener("click", () => {
    game.restart();
    overlay.hidden = true;
    hud.hidden = false;
    if (!game.running) game.start();
  });

  if (location.search.includes("shot=")) {
    overlay.hidden = true;
    hud.hidden = false;
    game.start();
  }
}

if (!workerMode) {
  const game = new Game(canvas);
  wireUi(game);
} else {
  // worker 异步引导：先造 Game（镜像 world 占位，画面为空地形），worker 回发 world 全量后
  // 由 onWorkerWorldReady 重建地形并写开局日志；点击 BEGIN 时 start() 会命令 worker 开跑。
  const client = new WorkerSimClient();
  const game = new Game(canvas, client);
  wireUi(game);
  void client.worldReady().then(() => game.onWorkerWorldReady("开局"));
}
