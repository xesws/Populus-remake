// v0.25 探针：构图逐段耗时（特征逐个 + world.ts 管线），用于守 800ms 预算。
import { World } from "../src/game/world";
for (const seed of [11, 42, 99, 7, 1]) {
  const w = new World(seed);
  const f = w.genFeatures.map((x) => `${x.id} ${x.ms}ms`).join("  ");
  let ch = 0;
  for (let i = 0; i < w.fmask.length; i++) if ((w.fmask[i]! & 2) !== 0) ch++;
  console.log(`seed ${String(seed).padStart(3)} ${w.templateId.padEnd(12)} 总构图 ${(w as any).__ms ?? "?"} | ${f} | 残留CHANNEL ${ch}`);
}
