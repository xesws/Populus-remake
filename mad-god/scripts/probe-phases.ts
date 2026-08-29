// v0.25 探针：把 WorldGen.generate 逐段拆开计时（走运行时反射拿私有静态方法，不改源码）。
import { WorldGen } from "../src/game/world-gen";
import { pickTemplate, makeNoiseKit, mixSeed } from "../src/game/world-gen";
import { MAX_H, RNG, SAMPLES, STEP, WATER } from "../src/game/types";

const G = WorldGen as unknown as Record<string, (...a: unknown[]) => unknown>;
const samples = SAMPLES;
const step = STEP;
const world = (samples - 1) * step;

for (const seed of [11, 42, 99]) {
  const t: Record<string, number> = {};
  const lap = async (name: string, fn: () => void) => {
    const a = performance.now();
    fn();
    t[name] = (t[name] ?? 0) + (performance.now() - a);
  };
  const rng = new RNG(mixSeed(seed));
  for (let i = 0; i < 8; i++) rng.next();
  const tpl = pickTemplate(rng) as { mountainWeight(): number; reliefScale(): number };
  const noise = makeNoiseKit(mixSeed(seed ^ 0x5bf03635));
  const heights = new Float32Array(samples * samples);
  const mask = new Uint8Array(samples * samples);
  let labels: Int32Array | null = null;
  let maxLabel = -1;
  let starts: unknown = null;
  await lap("fillHeights", () => {
    G.fillHeights(heights, samples, step, world, tpl, noise);
  });
  await lap("labelLand", () => {
    const r = G.labelLand(heights, samples) as { labels: Int32Array; maxLabel: number };
    labels = r.labels;
    maxLabel = r.maxLabel;
  });
  await lap("findStarts", () => {
    starts = G.findStarts(heights, labels, maxLabel, samples, step, world, tpl);
  });
  await lap("composeFeatures", () => {
    G.composeFeatures(
      {
        samples, step, world, seaH: 0.04, water: WATER, maxH: MAX_H,
        h: heights, mask, labels, maxLabel, starts, rng, noise,
      },
      tpl,
    );
  });
  await lap("smoothPlains", () => {
    G.smoothPlains(heights, samples, step, noise, mask);
  });
  console.log(`seed ${seed} ${tpl.constructor.name}`, Object.entries(t).map(([k, v]) => `${k}=${v.toFixed(0)}ms`).join(" "));
}
