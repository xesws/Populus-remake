// v0.25 探针：出生点的实际高程与周边最高值（判断"基地是否盖在山顶"）。
import { World } from "../src/game/world";
import { SAMPLES, STEP } from "../src/game/types";
import { BLUE, RED } from "../src/game/types";
for (const seed of [1, 7, 11, 19, 23, 42, 88, 99]) {
  const w = new World(seed);
  const out: string[] = [];
  for (const t of [BLUE, RED]) {
    const s = w.startPad(t);
    const c = w.heightAt(s.x, s.z);
    let mx = 0;
    let mx3 = 0;
    for (let i = 0; i < SAMPLES * SAMPLES; i++) {
      const ix = i % SAMPLES;
      const iz = (i / SAMPLES) | 0;
      const d = Math.hypot(ix * STEP - s.x, iz * STEP - s.z);
      if (d <= 6 && w.h[i]! > mx) mx = w.h[i]!;
      if (d <= 3.2 && w.h[i]! > mx3) mx3 = w.h[i]!;
    }
    out.push(`${t === BLUE ? "B" : "R"} center=${c.toFixed(2)} max3.2=${mx3.toFixed(2)} max6=${mx.toFixed(2)}`);
  }
  console.log(`seed ${String(seed).padStart(3)} ${w.templateId.padEnd(12)} ${out.join("   ")}`);
}
