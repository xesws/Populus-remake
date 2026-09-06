import { Building } from "../building";
import { BuildingKind } from "../../types";

/**
 * v0.30 大龙训练营：外观类似工厂的大型建筑。
 * - `dwell` 复用为进驻牛战士计数（0..DRAGON_GARRISON_MAX）；
 * - `prod` 复用为生产进度（进驻满员后 0..1，DRAGON_PROD_T 秒走满）；
 * - 不是 TrainingCamp（没有单兵 TrainKind，出的是大龙）。
 */
export class DragonFactory extends Building {
  readonly kind: BuildingKind = "dragonFactory";
}
