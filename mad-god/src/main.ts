import { Game } from "./game/game";
import "./style.css";

const canvas = document.getElementById("view") as HTMLCanvasElement;
const hud = document.getElementById("hud")!;
const overlay = document.getElementById("overlay")!;
const btnStart = document.getElementById("btn-start")!;
const btnAgain = document.getElementById("btn-again")!;

const game = new Game(canvas);
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

if (typeof location !== "undefined" && location.search.includes("shot=")) {
  overlay.hidden = true;
  hud.hidden = false;
  game.start();
}
