// v0.25 探针（临时工具，不在 check 链中）：坡度分布与其影响到的落点判据。
// 为什么单独量这个：sim.ts:222/242 用 slopeAt>0.55 拒绝野人/树的落点，
// path-system.ts:69 用 slopeAt 做速度惩罚。起伏拉大后这两处都会悄悄退化——
// 前者让开局野人/森林变稀，后者让跨山行军时间爆炸。
// 运行：npx tsx scripts/probe-slope.ts
import { World } from "../src/game/world";
import { SAMPLES, STEP, WATER } from "../src/game/types";

const THS = [0.35, 0.55, 0.8, 1.2, 1.6, 2.0];

for (const seed of [1, 7, 11, 19, 23, 42, 88, 99]) {
  const w = new World(seed);
  let land = 0;
  const hist = THS.map(() => 0);
  let sum = 0;
  let worst = 0;
  for (let iz = 1; iz < SAMPLES - 1; iz++) {
    for (let ix = 1; ix < SAMPLES - 1; ix++) {
      if (w.h[iz * SAMPLES + ix]! <= WATER) continue;
      const sl = w.slopeAt(ix * STEP, iz * STEP);
      land++;
      sum += sl;
      worst = Math.max(worst, sl);
      for (let k = 0; k < THS.length; k++) if (sl > THS[k]!) hist[k]++;
    }
  }
  const pct = hist.map((c) => ((100 * c) / land).toFixed(1).padStart(5));
  console.log(
    `seed ${String(seed).padStart(3)} ${w.templateId.padEnd(12)} meanSlope=${(sum / land).toFixed(2)} worst=${worst.toFixed(2)}  >${THS.join(" / >")}%: ${pct.join(" ")}`,
  );
}
