// v0.25 探针：稳定态构图耗时（先预热，避免把 JIT 冷启动算进预算）。
import { World } from "../src/game/world";
new World(12345); // 预热：JIT 首轮成本高得多，不预热会把冷启动误读成回归
const rows: number[] = [];
for (const seed of [1, 7, 11, 19, 23, 42, 88, 99]) {
  const t = performance.now();
  const w = new World(seed);
  const ms = performance.now() - t;
  const fsum = w.genFeatures.reduce((a, b) => a + (b.ms ?? 0), 0);
  rows.push(ms);
  console.log(`seed ${String(seed).padStart(3)} ${w.templateId.padEnd(12)} 构图 ${ms.toFixed(0).padStart(4)}ms  其中特征 ${fsum.toFixed(0)}ms`);
}
console.log(`平均 ${(rows.reduce((a, b) => a + b, 0) / rows.length).toFixed(0)}ms`);
