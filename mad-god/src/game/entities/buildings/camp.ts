import { Building } from "../building";
import { BuildingKind, Team, TrainKind } from "../../types";

export abstract class TrainingCamp extends Building {
  abstract readonly trainKind: TrainKind;

  override isCamp(): boolean {
    return true;
  }
}

export class WarriorHut extends TrainingCamp {
  readonly kind: BuildingKind = "warriorHut";
  readonly trainKind: TrainKind = "warrior";
}

export class Temple extends TrainingCamp {
  readonly kind: BuildingKind = "temple";
  readonly trainKind: TrainKind = "preacher";
}

export class FireHut extends TrainingCamp {
  readonly kind: BuildingKind = "fireHut";
  readonly trainKind: TrainKind = "firewarrior";
}

export class SpyHut extends TrainingCamp {
  readonly kind: BuildingKind = "spyHut";
  readonly trainKind: TrainKind = "spy";
}

export class Tower extends Building {
  readonly kind: BuildingKind = "tower";
}

export class Rebirth extends Building {
  readonly kind: BuildingKind = "rebirth";
}
