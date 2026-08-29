// v0.25 探针：隔离"域扭曲"本身的高度场成本（把 warp 换成零位移桩，其余完全相同）。
import { WorldGen } from "../src/game/world-gen";
import { pickTemplate, makeNoiseKit, mixSeed, type NoiseKit } from "../src/game/world-gen";
import { MAX_H, RNG, SAMPLES, STEP, WATER } from "../src/game/types";

const G = WorldGen as unknown as Record<string, (...a: unknown[]) => unknown>;
const samples = SAMPLES, step = STEP, world = (samples - 1) * step;

function makeNoise(kind: "real" | "zero" | "cheap"): NoiseKit {
  const base = makeNoiseKit(mixSeed(4242 ^ 0x5bf03635));
  if (kind === "real") return base;
  return {
    noise2D: (x: number, z: number) => base.noise2D(x, z),
    fbm: (x: number, z: number, o?: number, f?: number, g?: number) => base.fbm(x, z, o, f, g),
    ridge: (x: number, z: number, o?: number, f?: number) => base.ridge(x, z, o, f),
    secondary: () => base.secondary(),
    // zero：不做位移；cheap：位移算一次给两个分量复用（少一条噪声流）
    warp: (x: number, z: number, axis: 0 | 1, f?: number) => (kind === "zero" ? 0 : base.warp(x, z, 0, f)),
  };
}

for (const kind of ["real", "cheap", "zero"] as const) {
  const rng = new RNG(mixSeed(11));
  for (let i = 0; i < 8; i++) rng.next();
  const tpl = pickTemplate(rng);
  const noise = makeNoise(kind);
  const h = new Float32Array(samples * samples);
  const t = performance.now();
  G.fillHeights(h, samples, step, world, tpl, noise);
  const a = performance.now() - t;
  const t2 = performance.now();
  G.fillHeights(h, samples, step, world, tpl, noise);
  const b = performance.now() - t2;
  let sum = 0;
  let chk = 0;
  for (let i = 0; i < h.length; i++) {
    sum += h[i]!;
    chk = (chk * 31 + Math.round(h[i]! * 1000)) >>> 0;
  }
  console.log(
    `warp=${kind.padEnd(5)} 首遍 ${a.toFixed(0)}ms 次遍 ${b.toFixed(0)}ms 峰值 ${Math.max(...h).toFixed(2)} 均值 ${(sum / h.length).toFixed(4)} 校验和 ${chk}`,
  );
}
