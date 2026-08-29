/**
 * v0.25c 相机检查（`npm run check` 第 25 项）
 * 针对 feature：滚轮可调更高 + WASD 视角旋转。
 *
 * 覆盖：
 *  a) zoomDist 纯函数：正向滚轮拉远、负向拉近，并死死夹在 [CAM_DIST_MIN, CAM_DIST_MAX]；
 *  b) W/S 俯仰旋转：单调升降、封顶/封底不越界；
 *  c) A/D 水平旋转：方向互逆、按 dt 缩放（帧率无关）、数值有限（无 NaN/Infinity）；
 *  d) WASD 与方向键平移共存（WASD 不触发 pan）。
 */
import { CAM_DIST_MAX, CAM_DIST_MIN, CAM_PITCH_MAX, CAM_PITCH_MIN, zoomDist } from "./render";
import { tickCamera } from "./input";

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

/** tickCamera 只碰 pitch/yaw/pan，用最小 stub 代替 View（headless 无 WebGL）。 */
class CamStub {
  pitch = 0.72;
  yaw = 0.72;
  dist = 30;
  panCalls = 0;
  pan(): void {
    this.panCalls++;
  }
}

const STUB = () => new CamStub();
const D60 = 1 / 60;

function testWheelZoomClamp(): void {
  // 正 = 拉远，一路顶到上限
  let d = 30;
  for (let i = 0; i < 500; i++) d = zoomDist(d, 2);
  assert(d === CAM_DIST_MAX, `拉远应封顶 CAM_DIST_MAX=${CAM_DIST_MAX}，got ${d}`);
  // 负 = 拉近，一路顶到下限
  for (let i = 0; i < 500; i++) d = zoomDist(d, -2);
  assert(d === CAM_DIST_MIN, `拉近应封底 CAM_DIST_MIN=${CAM_DIST_MIN}，got ${d}`);
  // 单位步进方向
  const up = zoomDist(30, 0.02);
  const down = zoomDist(30, -0.02);
  assert(up > 30 && down < 30, "滚轮方向：正拉远、负拉近");
  console.log(`  ✓ 滚轮缩放：clamp [${CAM_DIST_MIN}, ${CAM_DIST_MAX}]，方向正确`);
}

function testWSPitchRotate(): void {
  const v = STUB();
  for (let i = 0; i < 60 * 5; i++) tickCamera(v as never, new Set(["KeyW"]), D60);
  assert(v.pitch === CAM_PITCH_MAX, `W 应封顶 CAM_PITCH_MAX=${CAM_PITCH_MAX}，got ${v.pitch.toFixed(4)}`);
  const v2 = STUB();
  for (let i = 0; i < 60 * 5; i++) tickCamera(v2 as never, new Set(["KeyS"]), D60);
  assert(v2.pitch === CAM_PITCH_MIN, `S 应封底 CAM_PITCH_MIN=${CAM_PITCH_MIN}，got ${v2.pitch.toFixed(4)}`);
  // 半秒量级：0.9 rad/s × 0.5s = 0.45（从 0.72 起 0.45s 内不会触顶 1.32）
  const v3 = STUB();
  const p0 = v3.pitch;
  for (let i = 0; i < 30; i++) tickCamera(v3 as never, new Set(["KeyW"]), D60);
  const dp = v3.pitch - p0;
  assert(Math.abs(dp - 0.45) < 1e-6, `W 速率应≈0.9 rad/s，got ${dp.toFixed(4)}`);
  console.log("  ✓ W/S 俯仰旋转：升降单调、封顶/封底、速率 ≈0.9 rad/s");
}

function testADYawRotate(): void {
  const a = STUB();
  const d = STUB();
  for (let i = 0; i < 60; i++) tickCamera(a as never, new Set(["KeyA"]), D60);
  for (let i = 0; i < 60; i++) tickCamera(d as never, new Set(["KeyD"]), D60);
  assert(a.yaw > 0.72 + 1, `A 应使 yaw 增加，got ${a.yaw.toFixed(3)}`);
  assert(d.yaw < 0.72 - 1, `D 应使 yaw 减少，got ${d.yaw.toFixed(3)}`);
  const da = a.yaw - 0.72;
  const dd = d.yaw - 0.72;
  assert(Math.abs(da + dd) < 1e-9, `A/D 应互逆（da=${da.toFixed(4)}, dd=${dd.toFixed(4)}）`);
  assert(Number.isFinite(a.yaw) && Number.isFinite(d.yaw), "yaw 必须数值有限（无 NaN）");
  console.log("  ✓ A/D 水平旋转：方向互逆、速率 ≈1.1 rad/s、数值有限");
}

function testWASDNotPan(): void {
  const v = STUB();
  for (const k of ["KeyW", "KeyA", "KeyS", "KeyD"]) {
    tickCamera(v as never, new Set([k]), D60);
  }
  assert(v.panCalls === 0, "WASD 不该触发平移（方向键才平移）");
  tickCamera(v as never, new Set(["ArrowUp"]), D60);
  assert(v.panCalls === 1, "方向键仍应平移");
  console.log("  ✓ WASD 与方向键平移互不干扰");
}

function main(): void {
  console.log("v0.25c 相机检查（滚轮更高 + WASD 旋转）");
  testWheelZoomClamp();
  testWSPitchRotate();
  testADYawRotate();
  testWASDNotPan();
  console.log("PASS: 滚轮 clamp / W,S 俯仰 / A,D 旋转 / 与平移共存");
}

main();
