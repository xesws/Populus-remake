import { Owner, Team, UnitKind, BuildingKind, unitHp, houseHp, woodNeedFor } from "../types";
import { BaseEntity } from "./entity";
import { Unit } from "./unit";
import { Walker } from "./units/walker";
import { Warrior } from "./units/warrior";
import { Preacher } from "./units/preacher";
import { Firewarrior } from "./units/firewarrior";
import { Spy } from "./units/spy";
import { Shaman } from "./units/shaman";
import { Wildman } from "./units/wildman";

import { Building } from "./building";
import { Hut } from "./buildings/hut";
import { TrainingCamp, WarriorHut, Temple, FireHut, SpyHut, Tower, Rebirth } from "./buildings/camp";
import { Tree } from "./tree";

export function createUnit(id: number, team: Owner, kind: UnitKind, x: number, z: number, y: number, str = 1): Unit {
  const hp = unitHp(kind, str);
  switch (kind) {
    case "walker":
      return new Walker(id, team, x, z, y, hp, hp, str);
    case "warrior":
      return new Warrior(id, team, x, z, y, hp, hp, str);
    case "preacher":
      return new Preacher(id, team, x, z, y, hp, hp, str);
    case "firewarrior":
      return new Firewarrior(id, team, x, z, y, hp, hp, str);
    case "spy":
      return new Spy(id, team, x, z, y, hp, hp, str);
    case "shaman":
      return new Shaman(id, team, x, z, y, hp, hp, str);
    case "wildman":
      return new Wildman(id, team, x, z, y, hp, hp, str);
  }
}

export function createBuilding(
  id: number,
  team: Team,
  kind: BuildingKind,
  x: number,
  z: number,
  y: number,
  level: number,
  yaw: number,
  padW: number,
  padD: number,
  hp?: number,
  maxHp?: number,
  need?: number,
): Building {
  const defaultHp = kind === "rebirth" ? 40 : level === 0 ? 12 : houseHp(Math.max(1, level));
  const finalHp = hp !== undefined ? hp : defaultHp;
  const finalMaxHp = maxHp !== undefined ? maxHp : defaultHp;
  const finalNeed = need !== undefined ? need : woodNeedFor(kind, level);

  let b: Building;
  switch (kind) {
    case "hut":
      b = new Hut(id, team, x, z, y, finalHp, finalMaxHp, level, yaw, padW, padD, finalNeed);
      break;
    case "warriorHut":
      b = new WarriorHut(id, team, x, z, y, finalHp, finalMaxHp, level, yaw, padW, padD, finalNeed);
      break;
    case "temple":
      b = new Temple(id, team, x, z, y, finalHp, finalMaxHp, level, yaw, padW, padD, finalNeed);
      break;
    case "fireHut":
      b = new FireHut(id, team, x, z, y, finalHp, finalMaxHp, level, yaw, padW, padD, finalNeed);
      break;
    case "spyHut":
      b = new SpyHut(id, team, x, z, y, finalHp, finalMaxHp, level, yaw, padW, padD, finalNeed);
      break;
    case "tower":
      b = new Tower(id, team, x, z, y, finalHp, finalMaxHp, level, yaw, padW, padD, finalNeed);
      break;
    case "rebirth":
      b = new Rebirth(id, team, x, z, y, finalHp, finalMaxHp, level, yaw, padW, padD, finalNeed);
      break;
  }
  return b;
}

export function createTree(id: number, x: number, z: number, y: number, alive = true, regen = 0): Tree {
  return new Tree(id, x, z, y, alive, regen);
}
