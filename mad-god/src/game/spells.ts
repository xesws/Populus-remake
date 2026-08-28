import { Sim } from "./sim";
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
};

export function canUnlock(tool: Tool, cap: number): boolean {
  const spell = SPELLS[tool];
  if (spell) return spell.canUnlock(cap);
  return false;
}

export function cast(sim: Sim, team: Team, tool: Tool, x: number, z: number, dt = 0.2): SpellResult {
  const empty: SpellResult = { ok: false, bolts: [], shake: 0, msg: "" };
  const t = sim.teams[team];
  if (tool === "select") return empty;
  if (sim.armageddon) return { ...empty, msg: "末日已开，神迹封闭" };
  const spell = SPELLS[tool];
  if (!spell) return empty;
  if (!spell.canUnlock(t.manaCap)) return { ...empty, msg: "法力上限未及，神迹尚未解锁" };

  return spell.cast(sim, team, x, z, dt);
}

export function flattenToward(
  sim: Sim,
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
