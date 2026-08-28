import { Sim } from "./sim";
import { inMap, Team, Tool, TOOL_COST, UNLOCK_CAP } from "./types";

export interface SpellResult {
  ok: boolean;
  bolts: { x0: number; z0: number; x1: number; z1: number; life: number }[];
  shake: number;
  msg: string;
}

export function canUnlock(tool: Tool, cap: number): boolean {
  return cap >= UNLOCK_CAP[tool];
}

const STUB: Tool[] = ["armageddon"];

export function cast(sim: Sim, team: Team, tool: Tool, x: number, z: number, dt = 0.2): SpellResult {
  const empty: SpellResult = { ok: false, bolts: [], shake: 0, msg: "" };
  const t = sim.teams[team];
  if (tool === "select") return empty;
  if (sim.armageddon) return { ...empty, msg: "末日已开，神迹封闭" };
  if (!canUnlock(tool, t.manaCap)) return { ...empty, msg: "法力上限未及，神迹尚未解锁" };

  if (tool === "raise" || tool === "lower") {
    if (!inMap(x, z)) return empty;
    const sign = tool === "raise" ? 1 : -1;
    const perSec = TOOL_COST[tool];
    const cost = Math.max(0.04, perSec * dt);
    if (!sim.spend(team, cost)) return { ...empty, msg: "法力不足" };
    const dh = sign * 1.5 * dt;
    const ok = sim.world.sculpt(x, z, 1.4, dh);
    if (!ok && tool === "raise" && sim.world.heightAt(x, z) >= 8 - 1e-4) {
      t.mana += cost;
      return { ...empty, msg: "无法再升高" };
    }
    if (!ok && tool === "lower" && sim.world.heightAt(x, z) <= 0.02) {
      t.mana += cost;
      return { ...empty, msg: "已是水面" };
    }
    return { ok: true, bolts: [], shake: 0, msg: "" };
  }

  if (tool === "blast") {
    if (!inMap(x, z)) return empty;
    if (!sim.spend(team, TOOL_COST.blast)) return { ...empty, msg: "法力不足" };
    sim.blastAt(x, z);
    return { ok: true, bolts: [], shake: 0.28, msg: "一股气浪打出" };
  }

  if (tool === "lightning") {
    if (!inMap(x, z)) return empty;
    if (!sim.spend(team, TOOL_COST.lightning)) return { ...empty, msg: "法力不足" };
    sim.strikeLightning(x, z);
    return { ok: true, bolts: [], shake: 0.45, msg: "天雷落下" };
  }

  if (tool === "swamp") {
    if (!inMap(x, z)) return empty;
    if (sim.world.heightAt(x, z) <= 0.20) return { ...empty, msg: "水里不长沼泽" };
    if (!sim.spend(team, TOOL_COST.swamp)) return { ...empty, msg: "法力不足" };
    const n = sim.world.paintSwamp(x, z);
    if (!n) {
      sim.teams[team].mana += TOOL_COST.swamp;
      return { ...empty, msg: "这里长不出沼泽" };
    }
    return { ok: true, bolts: [], shake: 0, msg: "毒气沼泽落下" };
  }

  if (tool === "quake") {
    if (!inMap(x, z)) return empty;
    if (!sim.spend(team, TOOL_COST.quake)) return { ...empty, msg: "法力不足" };
    if (!sim.beginQuake(x, z)) {
      sim.teams[team].mana += TOOL_COST.quake;
      return { ...empty, msg: "大地震还在裂" };
    }
    return { ok: true, bolts: [], shake: 0.4, msg: "大地震动" };
  }

  if (tool === "tornado") {
    if (!inMap(x, z)) return empty;
    if (sim.world.heightAt(x, z) <= 0.20) return { ...empty, msg: "水上不起龙卷风" };
    if (!sim.spend(team, TOOL_COST.tornado)) return { ...empty, msg: "法力不足" };
    if (!sim.beginTornado(x, z)) {
      sim.teams[team].mana += TOOL_COST.tornado;
      return { ...empty, msg: "龙卷风还在刮" };
    }
    return { ok: true, bolts: [], shake: 0.2, msg: "龙卷风升起" };
  }

  if (tool === "volcano") {
    if (!inMap(x, z)) return empty;
    if (!sim.spend(team, TOOL_COST.volcano)) return { ...empty, msg: "法力不足" };
    if (!sim.beginVolcano(x, z)) {
      sim.teams[team].mana += TOOL_COST.volcano;
      return { ...empty, msg: "火山还在喷" };
    }
    return { ok: true, bolts: [], shake: 0.25, msg: "火山抬起" };
  }

  if (STUB.includes(tool)) {
    return { ...empty, msg: "地面重构中" };
  }

  return empty;
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
