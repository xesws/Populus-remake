import { Sim } from "./sim";
import type { SimClient } from "./client/sim-client";
import { inMap, Team, Tool } from "./types";
import {
  Spell,
  SpellResult,
  LightningSpell,
  QuakeSpell,
  SwampSpell,
  VolcanoSpell,
  TornadoSpell,
  BlastSpell,
  ArmageddonSpell,
  SculptSpell,
  FireballSpell,
  ConvertSpell,
} from "./spells/index";

export type { SpellResult } from "./spells/index";
export {
  Spell,
  LightningSpell,
  QuakeSpell,
  SwampSpell,
  VolcanoSpell,
  TornadoSpell,
  BlastSpell,
  ArmageddonSpell,
  SculptSpell,
  FireballSpell,
  ConvertSpell,
} from "./spells/index";

export const SPELLS: Partial<Record<Tool, Spell>> = {
  raise: new SculptSpell("raise"),
  lower: new SculptSpell("lower"),
  lightning: new LightningSpell(),
  quake: new QuakeSpell(),
  swamp: new SwampSpell(),
  volcano: new VolcanoSpell(),
  tornado: new TornadoSpell(),
  blast: new BlastSpell(),
  armageddon: new ArmageddonSpell(),
  fireball: new FireballSpell(),
  convert: new ConvertSpell(),
};

export function canUnlock(tool: Tool, cap: number): boolean {
  const spell = SPELLS[tool];
  if (spell) return spell.canUnlock(cap);
  return false;
}

// v0.29b 参数放宽为 SimClient：主线程（game.ts）只持有接口；内部仍要把 sim 递给
// Spell.cast(sim: Sim)——法术实现属 sim 侧（v0.29c 随 Sim 进 Worker），本地模式下
// SimClient 即真 Sim，此断言恒真。
export function cast(sim: SimClient, team: Team, tool: Tool, x: number, z: number, dt = 0.2): SpellResult {
  const empty: SpellResult = { ok: false, bolts: [], shake: 0, msg: "" };
  const t = sim.teams[team];
  if (tool === "select") return empty;
  if (sim.armageddon) return { ...empty, msg: "末日已开，神迹封闭" };
  const spell = SPELLS[tool];
  if (!spell) return empty;
  if (!spell.canUnlock(t.manaCap)) return { ...empty, msg: "法力上限未及，神迹尚未解锁" };

  return spell.cast(sim as Sim, team, x, z, dt);
}

export function flattenToward(
  sim: SimClient,
  team: Team,
  x: number,
  z: number,
  targetH: number,
): boolean {
  if (!inMap(x, z)) return false;
  const h = sim.world.heightAt(x, z);
  if (Math.abs(h - targetH) < 0.08) return false;
  const tool: Tool = h < targetH ? "raise" : "lower";
  return cast(sim, team, tool, x, z, 0.25).ok;
}
