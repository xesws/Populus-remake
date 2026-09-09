// v0.36 开局基地几何唯一来源：SpawnPlanner 用它验整座基地都在目标岛上，Sim 用它真正落建筑。
// 过去两边各算一遍会发生“出生神像在岛上、两座初始茅屋伸进海里”的口径漂移。

import { padSize } from "../types";

export interface SpawnPoint {
  x: number;
  z: number;
  /** atan2(dx,dz)：局部 +Z 朝向对手。 */
  yaw: number;
  h: number;
}

export interface StartBuildingPad {
  role: "rebirth" | "hut-left" | "hut-right";
  x: number;
  z: number;
  yaw: number;
  w: number;
  d: number;
}

/** 两个点相向而立时使用的朝向（项目约定 atan2(dx,dz)，不是常见的 atan2(dz,dx)）。 */
export function yawToward(x: number, z: number, targetX: number, targetZ: number): number {
  return Math.atan2(targetX - x, targetZ - z);
}

/**
 * 神像居中，两座 L1 茅屋在朝向前方 4 格、左右各 4 格；与旧 Sim.placeStart 几何一致。
 * 唯一变化是“前方”来自 SpawnPoint.yaw，而不是再次偷偷朝 WORLD 中心计算。
 */
export function initialBaseLayout(start: Pick<SpawnPoint, "x" | "z" | "yaw">): StartBuildingPad[] {
  const fx = Math.sin(start.yaw);
  const fz = Math.cos(start.yaw);
  const px = -fz;
  const pz = fx;
  const hut = padSize(1);
  return [
    { role: "rebirth", x: start.x, z: start.z, yaw: start.yaw, w: 3.2, d: 3.2 },
    {
      role: "hut-left",
      x: start.x + fx * 4 + px * 4,
      z: start.z + fz * 4 + pz * 4,
      yaw: start.yaw + 0.12,
      w: hut.w,
      d: hut.d,
    },
    {
      role: "hut-right",
      x: start.x + fx * 4 - px * 4,
      z: start.z + fz * 4 - pz * 4,
      yaw: start.yaw - 0.12,
      w: hut.w,
      d: hut.d,
    },
  ];
}
