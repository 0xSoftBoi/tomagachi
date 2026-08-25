import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { config } from "./config.js";

export interface AgentState {
  suwappuApiKey?: string;
  suwappuAgentId?: string;
  epoch: number;
  activeJob?: { id: string; provider: string; startedAt: string; paidUsdc: string };
}

const statePath = join(config.stateDir, "state.json");

export function loadState(): AgentState {
  if (!existsSync(statePath)) return { epoch: 0 };
  return JSON.parse(readFileSync(statePath, "utf8"));
}

export function saveState(s: AgentState): void {
  mkdirSync(config.stateDir, { recursive: true });
  writeFileSync(statePath, JSON.stringify(s, null, 2));
}
