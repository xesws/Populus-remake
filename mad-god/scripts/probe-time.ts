// v0.25 探针：构图耗时（阶段 1 的预算门槛，域扭曲会给 fillHeights 加一次噪声采样）
import { World } from "../src/game/world";
for (const seed of [1, 11, 99]) {
  const t = performance.now();
  new World(seed);
  console.log(`seed ${seed} 构图 ${(performance.now() - t).toFixed(0)}ms`);
}
const t0 = performance.now();
let n = 0;
for (let s = 1; s <= 10; s++) { new World(s); n++; }
console.log(`${n} 张图平均 ${((performance.now() - t0) / n).toFixed(0)}ms`);
