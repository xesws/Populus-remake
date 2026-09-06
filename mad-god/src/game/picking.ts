/**
 * v0.30 大龙剪影拾取（纯函数，headless 可测）。
 *
 * 问题：大龙悬在半空，3D 视角下光标指在龙身上时，投影落点可能在龙体"身后"的地面
 * ——旧的锚点屏距判定（单位脚底 +0.28 投影取 28px 内最近）会误选地面单位。
 *
 * 方案：把龙体沿脊线采样成一组屏幕空间圆形（头/颈/躯干/尾），光标落在任一圆内即命中；
 * 命中判定由调用方保证**绝对优先**于地面单位（先跑剪影，命中即返回，跳过全部地面判定）。
 * 投影在 game.ts 完成（依赖相机），本模块只做几何判定，便于回归测试。
 */

export interface DragonPickCircle {
  /** 屏幕坐标（px，canvas 全局坐标）。 */
  x: number;
  y: number;
  /** 屏幕半径（px，已含容差）。 */
  r: number;
}

export interface DragonPickItem {
  id: number;
  /** 龙体中心屏幕坐标（多龙重叠时取离光标最近者）。 */
  cx: number;
  cy: number;
  circles: DragonPickCircle[];
}

/** 光标命中剪影则返回该龙（取中心最近者），否则 null。 */
export function pickDragonAt(items: DragonPickItem[], sx: number, sy: number): DragonPickItem | null {
  let best: DragonPickItem | null = null;
  let bestD = Infinity;
  for (const it of items) {
    for (const c of it.circles) {
      const dx = sx - c.x;
      const dy = sy - c.y;
      const d2 = dx * dx + dy * dy;
      if (d2 > c.r * c.r) continue;
      const cd = (sx - it.cx) ** 2 + (sy - it.cy) ** 2;
      if (cd < bestD) {
        bestD = cd;
        best = it;
      }
      break;
    }
  }
  return best;
}

/**
 * 龙体脊线采样参数（世界坐标）：沿朝向从尾到头取 5 点，抬到龙身高度 y + 0.55。
 * 与渲染的龙体建模（体长 ~2.2、身位在 y+0.35~0.8）对齐；命中半径 0.85 覆盖翅膀展宽。
 */
export const DRAGON_SPINE_OFFSETS = [-1.0, -0.5, 0, 0.5, 1.0] as const;
export const DRAGON_PICK_RADIUS = 0.85;
export const DRAGON_PICK_TOLERANCE = 1.15;

/** 某条脊线采样点的世界坐标（朝向 yaw、基准点 x/z、高度 y）。 */
export function dragonSpinePoint(
  x: number,
  y: number,
  z: number,
  yaw: number,
  offset: number,
): { x: number; y: number; z: number } {
  const fx = Math.sin(yaw);
  const fz = Math.cos(yaw);
  return { x: x + fx * offset, y: y + 0.55, z: z + fz * offset };
}
