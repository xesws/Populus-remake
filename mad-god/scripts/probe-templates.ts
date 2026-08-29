// v0.25 探针（临时工具，不在 check 链中）：按模板维度统计高度分布。
// 目的：调曲线时看清"哪个模板过头 / 哪个模板还是平原"，而不是被 8 个抽样 seed 误导。
// 运行：npx tsx scripts/probe-templates.ts
import { World } from "../src/game/world";
import { SAMPLES, WATER } from "../src/game/types";

interface Acc {
  n: number;
  max: number;
  mean: number;
  std: number;
  snow: number;
  rock: number;
  grass: number;
}

const rows = new Map<string, Acc>();
const band = (h: number, lo: number, hi: number) => h >= lo && h < hi;

for (let seed = 1; seed <= 40; seed++) {
  const w = new World(seed);
  const land: number[] = [];
  for (let i = 0; i < SAMPLES * SAMPLES; i++) if (w.h[i]! > WATER) land.push(w.h[i]!);
  if (land.length < 200) continue; // 陆地太少的抽样不计入均值（否则百分比噪声大）
  const mean = land.reduce((a, b) => a + b, 0) / land.length;
  const std = Math.sqrt(land.reduce((a, b) => a + (b - mean) ** 2, 0) / land.length);
  const pct = (f: (h: number) => boolean) => (100 * land.filter(f).length) / land.length;
  const r = rows.get(w.templateId) ?? { n: 0, max: 0, mean: 0, std: 0, snow: 0, rock: 0, grass: 0 };
  r.n++;
  r.max += Math.max(...land);
  r.mean += mean;
  r.std += std;
  r.snow += pct((h) => h >= 4.2);
  r.rock += pct((h) => band(h, 2.6, 4.2));
  r.grass += pct((h) => band(h, WATER, 1.4));
  rows.set(w.templateId, r);
}

const col = (s: string | number, n: number) => String(typeof s === "number" ? s.toFixed(2) : s).padStart(n);
console.log("tpl            n    max   mean    std   snow%   rock%  grass%");
for (const [id, r] of rows) {
  console.log(
    id.padEnd(13),
    String(r.n).padStart(4),
    col(r.max / r.n, 6),
    col(r.mean / r.n, 6),
    col(r.std / r.n, 6),
    col(r.snow / r.n, 6),
    col(r.rock / r.n, 7),
    col(r.grass / r.n, 7),
  );
}
