import { Building } from "../building";
import { BOATHOUSE_DWELL, BuildingKind, Team } from "../../types";

/**
 * v0.32 船屋：住满开工的产船建筑（单级，无升级链）。
 * - `dwell` 复用为住户村民计数（0..BOATHOUSE_DWELL，occupy 船屋分支口径）；
 * - `prod` 复用为造船进度（住满后 0..1，BOAT_BUILD_T 秒走满一条）；
 * - `producedBoatIds` = 本屋下水且仍存活的船 id（"produced_units" 语义，上限
 *   BOATHOUSE_FLEET_CAP；每次开工前用 unitById 懒清理，沉一补一）；
 * - 选址必须岸边（canFound 船屋专条：陆地 pad＋水在 BOATHOUSE_WATER_RANGE 内）。
 */
export class Boathouse extends Building {
  readonly kind: BuildingKind = "boathouse";

  /** 本屋产出且存活的船 id（数组每实例独立，见构造函数）。 */
  producedBoatIds: number[] = [];

  override maxPopulation(): number {
    return this.level >= 1 ? BOATHOUSE_DWELL : 0;
  }
}
