/**
 * v0.40 独立废墟与地基分级回归锁（`npm run check` 新增项，headless 渲染断言）：
 *   借 walker-headband-check 的范式（Object.create(View.prototype) 绕过 WebGL 构造），
 *   对 makeHouse/makeRuin 的产物做几何断言——浏览器只管好不好看，anya 对不对由这里锁：
 *   a) 九种废墟两两不同（旧“所有建筑破损一个样”不许回来）；
 *   b) 废墟不比原建筑大（x/z 各轴 ≤ 原型＋0.4 碎石余量，修好切回不穿帮）；
 *   c) 每种废墟都留一处队色残片（远处可辨阵营）；
 *   d) L0 地基分级：哨塔＜茅屋＜训练营＜龙厂（此前统一 2.5 硬编码）。
 */
import * as THREE from "three";
import { View } from "./render";
import { BLUE, BuildingKind, Team } from "./types";

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

const BLUE_HEAD = 0x1f4e8a;
const RUINS: BuildingKind[] = [
  "hut",
  "warriorHut",
  "temple",
  "fireHut",
  "spyHut",
  "tower",
  "rebirth",
  "dragonFactory",
  "boathouse",
];

/** 复用真 box（含落位），只为收集几何——材质读色不断言材质类型。 */
function buildHouse(team: Team, level: number, kind: string, shell: boolean): THREE.Group {
  const fake = Object.create(View.prototype) as unknown as View;
  return fake.makeHouse(team, level, kind, 0, shell);
}

function extent(g: THREE.Group): { x: number; z: number } {
  g.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(g);
  const size = new THREE.Vector3();
  box.getSize(size);
  return { x: size.x, z: size.z };
}

function hasTeamColor(g: THREE.Group, expect: number): boolean {
  let found = false;
  g.traverse((o) => {
    const m = o as THREE.Mesh;
    const mat = m.material as THREE.MeshLambertMaterial | undefined;
    if (mat && "color" in mat && mat.color && (mat.color as THREE.Color).getHex?.() === expect) found = true;
  });
  return found;
}

function testRuinsDistinct(): void {
  const sigs = new Map<string, string>();
  for (const kind of RUINS) {
    const g = buildHouse(BLUE, 1, kind, true);
    let n = 0;
    g.traverse((o) => {
      if ((o as THREE.Mesh).isMesh) n++;
    });
    const e = extent(g);
    const sig = `${n}|${e.x.toFixed(2)}|${e.z.toFixed(2)}`;
    assert(!sigs.has(sig), `废墟两两不同：${kind} 与 ${sigs.get(sig)} 撞车（${sig}）`);
    sigs.set(sig, kind);
  }
  console.log("  ✓ 九种废墟两两不同");
}

function testRuinFootprint(): void {
  for (const kind of RUINS) {
    const intact = extent(buildHouse(BLUE, 1, kind, false));
    const ruin = extent(buildHouse(BLUE, 1, kind, true));
    assert(
      ruin.x <= intact.x + 0.4 && ruin.z <= intact.z + 0.4,
      `${kind} 废墟不应比原建筑大（原 ${intact.x.toFixed(2)}×${intact.z.toFixed(2)}，墟 ${ruin.x.toFixed(2)}×${ruin.z.toFixed(2)}）`,
    );
    assert(hasTeamColor(buildHouse(BLUE, 1, kind, true), BLUE_HEAD), `${kind} 废墟应留队色残片`);
  }
  console.log("  ✓ 废墟不比原建筑大、队色残片齐全");
}

function testRuinSwap(): void {
  for (const kind of RUINS) {
    let intact = 0;
    let ruin = 0;
    buildHouse(BLUE, 1, kind, false).traverse((o) => {
      if ((o as THREE.Mesh).isMesh) intact++;
    });
    buildHouse(BLUE, 1, kind, true).traverse((o) => {
      if ((o as THREE.Mesh).isMesh) ruin++;
    });
    assert(intact > 0 && ruin > 0 && intact !== ruin, `${kind} 破损/完整应是两套模型`);
  }
  console.log("  ✓ 破损/完整各一套");
}

function dirtSpan(kind: string): number {
  // L0 地基层：最宽的那块扁土垫（y≈0.035、h≈0.07）。
  const g = buildHouse(BLUE, 0, kind, false);
  let span = 0;
  g.traverse((o) => {
    const m = o as THREE.Mesh;
    const geo = m.geometry as THREE.BoxGeometry | undefined;
    if (!m.isMesh || !geo || geo.type !== "BoxGeometry") return;
    const p = geo.parameters as { width: number; height: number; depth: number };
    if (Math.abs(m.position.y - 0.035) < 0.01 && Math.abs(p.height - 0.07) < 0.01) {
      span = Math.max(span, p.width, p.depth);
    }
  });
  return span;
}

function testFoundationTiers(): void {
  const tower = dirtSpan("tower");
  const hut = dirtSpan("hut");
  const camp = dirtSpan("warriorHut");
  const factory = dirtSpan("dragonFactory");
  const boat = dirtSpan("boathouse");
  assert(tower > 0 && hut > 0 && camp > 0 && factory > 0, "四档地基都应有土垫");
  assert(tower < hut && hut < camp && camp < factory, `地基分级：塔 ${tower}＜屋 ${hut}＜营 ${camp}＜厂 ${factory}`);
  assert(Math.abs(boat - camp) < 0.01, "船屋与训练营同档大地基");
  console.log(`  ✓ 地基分级：塔 ${tower}＜屋 ${hut}＜营 ${camp}＜厂 ${factory}，船屋同营档`);
}

testRuinsDistinct();
testRuinFootprint();
testRuinSwap();
testFoundationTiers();
console.log("ruin-check ok (v0.40 九种独立废墟/ footprint/队色/地基分级)");
