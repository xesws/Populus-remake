// v0.25 探针：各特征在 30 张真图上的落地率与放弃原因分布（集成验收用，不入 check 链）。
import { World } from "../src/game/world";
const tally = new Map<string, { maps: number; zero: number; sum: number; reasons: Map<string, number> }>();
for (let seed = 1; seed <= 30; seed++) {
  const w = new World(seed);
  for (const f of w.genFeatures) {
    const t = tally.get(f.id) ?? { maps: 0, zero: 0, sum: 0, reasons: new Map() };
    t.maps++;
    t.sum += f.placed;
    if (f.placed === 0) t.zero++;
    for (const part of (f.note ?? "").split("；")) {
      const key = part.replace(/[0-9.]+/g, "N").trim();
      if (key) t.reasons.set(key, (t.reasons.get(key) ?? 0) + 1);
    }
    tally.set(f.id, t);
  }
}
for (const [id, t] of tally) {
  const top = [...t.reasons.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4);
  console.log(
    `${id.padEnd(14)} 出现于 ${t.maps} 图，平均 ${t.sum / t.maps} 个，零落地 ${t.zero} 图 (${((100 * t.zero) / t.maps).toFixed(0)}%)`,
  );
  for (const [r, c] of top) console.log(`      ${String(c).padStart(3)}×  ${r}`);
}
