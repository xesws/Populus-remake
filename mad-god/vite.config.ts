import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, type Connect, type Plugin } from "vite";

// v0.14 游戏日志落盘：游戏内 Logger 批量 POST /log，这里追加写入 logs/game.log。
// dev 与 preview 都生效，同源无跨域；logs/*.log 已被 .gitignore 忽略。
const logFile = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "logs/game.log");

function gameLogPlugin(): Plugin {
  const wire = (mw: Connect.Namespace): void => {
    mw.use("/log", (req, res) => {
      if (req.method !== "POST") {
        res.statusCode = 405;
        res.end();
        return;
      }
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        try {
          const body = chunks.join("").toString("utf8").trim();
          if (!body) {
            res.statusCode = 204;
            res.end();
            return;
          }
          const list = JSON.parse(body) as unknown[];
          const recv = Date.now();
          const lines = list
            .map((e) => JSON.stringify({ recv, ...(e as object) }))
            .join("\n");
          fs.mkdirSync(path.dirname(logFile), { recursive: true });
          fs.appendFileSync(logFile, `${lines}\n`);
          res.statusCode = 204;
        } catch {
          res.statusCode = 400;
        }
        res.end();
      });
    });
  };
  return {
    name: "mad-god-game-log",
    configureServer(server) {
      wire(server.middlewares);
    },
    configurePreviewServer(server) {
      wire(server.middlewares);
    },
  };
}

export default defineConfig({
  base: "./",
  plugins: [gameLogPlugin()],
  server: {
    host: true,
    port: 5173,
  },
});
