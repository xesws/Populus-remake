/**
 * v0.25d 村民头巾检查（`npm run check` 第 26 项）
 * 针对 feature：村民戴头巾，红蓝阵营一眼可辨。
 *
 * `View.makeUnit` 只用 `this.box` / `this.teamPrimary`（不碰 WebGLRenderer），
 * 所以 `Object.create(View.prototype)` 绕过构造函数即可在 headless 下调用并检查产物。
 *
 * 覆盖：
 *  a) 蓝方村民头顶区域存在 teamMat 头巾（颜色 #1f4e8a）；
 *  b) 红方村民同理（#8a1c14），且与蓝方互不相同；
 *  c) 脑后垂尾存在、与头巾同色；
 *  d) 回归：村民仍含原 skin 头（y≈0.34）；
 *  e) 只动村民：野人（wildman）造型不含 teamMat 头巾。
 */
import * as THREE from "three";
import { View } from "./render";
import { BLUE, RED, Team } from "./types";

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

const BLUE_HEAD = 0x1f4e8a;
const RED_HEAD = 0x8a1c14;

interface BoxInfo {
  w: number;
  h: number;
  d: number;
  x: number;
  y: number;
  z: number;
  color: number | null;
}

function buildUnit(team: Team, kind: string): BoxInfo[] {
  // 绕过构造函数（会创建 WebGLRenderer，headless 无 WebGL）：只取原型上的 makeUnit。
  const fake = Object.create(View.prototype) as unknown as View;
  const boxes: BoxInfo[] = [];
  const origBox = View.prototype.box;
  fake.box = ((g: THREE.Group, w: number, h: number, d: number, mat: THREE.Material, x: number, y: number, z: number) => {
    const color = mat && "color" in mat && (mat as THREE.MeshLambertMaterial).color ? (mat as THREE.MeshLambertMaterial).color.getHex() : null;
    boxes.push({ w, h, d, x, y, z, color });
    return origBox.call(fake, g, w, h, d, mat, x, y, z);
  }) as View["box"];
  fake.makeUnit(team, kind, null);
  return boxes;
}

/** 头顶区域（y∈[0.41,0.46]）里颜色为 expect 的盒子。 */
function topHeadBox(boxes: BoxInfo[], expect: number): BoxInfo | null {
  return boxes.find((b) => b.y >= 0.41 && b.y <= 0.46 && b.color === expect) ?? null;
}

/** 后侧垂尾（y∈[0.29,0.45]，z≤-0.08）里颜色为 expect 的盒子。 */
function rearTailBox(boxes: BoxInfo[], expect: number): BoxInfo | null {
  return boxes.find((b) => b.y >= 0.29 && b.y <= 0.45 && b.z <= -0.08 && b.color === expect) ?? null;
}

function testBlueHeadband(): void {
  const boxes = buildUnit(BLUE, "walker");
  const cap = topHeadBox(boxes, BLUE_HEAD);
  assert(cap !== null, `蓝方村民应有头顶 teamMat 头巾（#${BLUE_HEAD.toString(16)}）`);
  const tail = rearTailBox(boxes, BLUE_HEAD);
  assert(tail !== null, "蓝方村民应有脑后 teamMat 垂尾");
  assert(
    boxes.some((b) => b.y >= 0.30 && b.y <= 0.38 && b.color === 0xf0d2a8),
    "回归：村民仍应有原 skin 头（y≈0.34）",
  );
  console.log("  ✓ 蓝方村民：头巾顶 + 脑后垂尾，色 #1f4e8a，皮肤头保留");
}

function testRedHeadband(): void {
  const boxes = buildUnit(RED, "walker");
  const cap = topHeadBox(boxes, RED_HEAD);
  assert(cap !== null, `红方村民应有头顶 teamMat 头巾（#${RED_HEAD.toString(16)}）`);
  const tail = rearTailBox(boxes, RED_HEAD);
  assert(tail !== null, "红方村民应有脑后 teamMat 垂尾");
  const blue = topHeadBox(boxes, BLUE_HEAD);
  assert(blue === null, "红方村民头巾不应是蓝方颜色");
  console.log("  ✓ 红方村民：头巾顶 + 脑后垂尾，色 #8a1c14，与蓝方互异");
}

function testWildmanUntouched(): void {
  const boxes = buildUnit(0, "wildman");
  assert(topHeadBox(boxes, BLUE_HEAD) === null, "野人不该有蓝方头巾");
  assert(rearTailBox(boxes, RED_HEAD) === null, "野人不该有红方头巾");
  console.log("  ✓ 野人造型未受影响（无 teamMat 头巾）");
}

function main(): void {
  console.log("v0.25d 村民头巾检查");
  testBlueHeadband();
  testRedHeadband();
  testWildmanUntouched();
  console.log("PASS: 蓝/红头巾可辨、互异，皮肤头保留，野人不受影响");
}

main();
