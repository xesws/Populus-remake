// v0.25 阶段 2 探针（临时工具，不在 check 链中）：山脉到底有没有落地、活下来多少。
//
// 为什么单独量：probe-templates 的高度分布几乎没变（雪盖 11.9%→13.2%），
// 这有两种完全不同的解释——「特征根本没放上去」和「放上去了但被平滑抹平了」。
// 前者要查 composeFeatures 的接线，后者要查 mask 是否真的传到了 smoothField。
// 所以这里把「特征请求的高程」和「管线交付的高程」分开测：
//   placed  = MountainRange 落地统计（改写格数）
//   maskPEAK= 最终 fmask 里登记为山体的格数（证明掩膜活着走出了 WorldGen）
//   summit  = 最终高度场里 ≥4.2 的局部峰头数（证明山真的存在）
// 运行：npx tsx scripts/probe-mountains.ts
import { World } from "../src/game/world";
import { MASK_PEAK } from "../src/game/world-gen/terrain-features";
import { SAMPLES, WATER } from "../src/game/types";

function summits(h: Float32Array, fromH: number): number {
  let n = 0;
  for (let iz = 1; iz < SAMPLES - 1; iz++) {
    for (let ix = 1; ix < SAMPLES - 1; ix++) {
      const i = iz * SAMPLES + ix;
      const v = h[i]!;
      if (v < fromH) continue;
      let isMax = true;
      for (let dz = -1; dz <= 1 && isMax; dz++) {
        for (let dx = -1; dx <= 1 && isMax; dx++) {
          if (dx === 0 && dz === 0) continue;
          if (h[(iz + dz) * SAMPLES + ix + dx]! > v) isMax = false;
        }
      }
      if (isMax) n++;
    }
  }
  return n;
}

/**
 * 连通峰顶区个数（h≥fromH 的 4 邻接连通域，且面积 ≥minCells 个采样）。
 * 这是"这座图真有几座山"的口径：单个采样点的噪声尖不算，要成一坨才算。
 */
function summitRegions(h: Float32Array, fromH: number, minCells: number): number {
  const seen = new Uint8Array(h.length);
  const q: number[] = [];
  let n = 0;
  for (let s = 0; s < h.length; s++) {
    if (seen[s] || h[s]! < fromH) continue;
    q.length = 0;
    q.push(s);
    seen[s] = 1;
    let area = 0;
    for (let head = 0; head < q.length; head++) {
      const cur = q[head]!;
      area++;
      const cz = (cur / SAMPLES) | 0;
      const cx = cur - cz * SAMPLES;
      for (const [dx, dz] of [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ] as const) {
        const jx = cx + dx;
        const jz = cz + dz;
        if (jx < 0 || jz < 0 || jx >= SAMPLES || jz >= SAMPLES) continue;
        const j = jz * SAMPLES + jx;
        if (seen[j] || h[j]! < fromH) continue;
        seen[j] = 1;
        q.push(j);
      }
    }
    if (area >= minCells) n++;
  }
  return n;
}

console.log("seed tpl           placed cells  maskPEAK  snowSummits  peakH  avgPeakH  rockFrac  bigSummits");
for (const seed of [1, 3, 5, 7, 11, 17, 19, 23, 42, 63, 88, 99]) {
  const w = new World(seed);
  let mp = 0;
  let mpRock = 0;
  let peakSum = 0;
  let peakN = 0;
  let peakMax = 0;
  for (let i = 0; i < w.fmask.length; i++) {
    if ((w.fmask[i]! & MASK_PEAK) === 0) continue;
    mp++;
    if (w.h[i]! > WATER) {
      peakSum += w.h[i]!;
      peakN++;
      if (w.h[i]! >= 2.6) mpRock++;
      if (w.h[i]! > peakMax) peakMax = w.h[i]!;
    }
  }
  const cells = w.genFeatures.reduce((a, b) => a + b.cells, 0);
  const placed = w.genFeatures.reduce((a, b) => a + b.placed, 0);
  console.log(
    String(seed).padStart(4),
    w.templateId.padEnd(14),
    String(placed).padStart(6),
    String(cells).padStart(7),
    String(mp).padStart(9),
    String(summits(w.h, 4.2)).padStart(12),
    peakMax.toFixed(2).padStart(6),
    (peakN ? peakSum / peakN : 0).toFixed(2).padStart(8),
    ((100 * mpRock) / Math.max(1, mp)).toFixed(0).padStart(7) + "%",
    String(summitRegions(w.h, 4.2, 16)).padStart(11),
    w.genFeatures.map((f) => `${f.id}:${f.placed}${f.note ? "(" + f.note + ")" : ""}`).join(" "),
  );
}
