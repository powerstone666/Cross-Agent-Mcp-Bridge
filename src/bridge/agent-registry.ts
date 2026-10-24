// Turns the agent modules into ready adapters, and lists the agents that could not start.
// Never name a specific agent here. This file only uses the generic AgentModule type.

import type { AgentAdapter } from "./types/agent-adapter.js";
import type {
  AgentModule,
  HumanApprovalChannel,
} from "./types/agent-module.js";

// One agent that started. The `list_agents` tool and the terminal chat show these.
export interface AgentInfo {
  agentName: string;
  displayName: string;
  role: "coordinator" | "worker";
  coordinator: string | null;
}

// One agent that could not start, with the error message that says why.
export interface UnavailableAgent {
  agentName: string;
  reason: string;
}

// `close()` closes every adapter. Call it when the relay shuts down.
export interface AgentRegistry {
  adapters: ReadonlyMap<string, AgentAdapter>;
  agentInfos: readonly AgentInfo[];
  unavailableAgents: readonly UnavailableAgent[];
  close(): void;
}

interface CreateAgentRegistryInput {
  modules: readonly AgentModule[];
  environment: NodeJS.ProcessEnv;
  targetRepositoryPath: string;
  humanApprovalChannel: HumanApprovalChannel;
}

// Builds one adapter per module. A module that fails goes into `unavailableAgents` instead
// of throwing, so one broken agent cannot block the healthy ones.
export function createAgentRegistry({
  modules,
  environment,
  targetRepositoryPath,
  humanApprovalChannel,
}: CreateAgentRegistryInput): AgentRegistry {
  const adapters = new Map<string, AgentAdapter>();
  const agentInfos: AgentInfo[] = [];
  const unavailableAgents: UnavailableAgent[] = [];

  for (const module of modules) {
    try {
      adapters.set(
        module.agentName,
        module.createAdapter({ environment, targetRepositoryPath, humanApprovalChannel }),
      );
      agentInfos.push({ agentName: module.agentName, displayName: module.displayName, role: "worker", coordinator: null });
    } catch (error) {
      unavailableAgents.push({
        agentName: module.agentName,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const requestedCoordinator = environment.RELAY_COORDINATOR_AGENT?.trim();
  const coordinator = requestedCoordinator || agentInfos[0]?.agentName;
  if (requestedCoordinator && !adapters.has(requestedCoordinator)) {
    for (const adapter of adapters.values()) adapter.close();
    throw new Error(`RELAY_COORDINATOR_AGENT must name an available agent: ${agentInfos.map((agent) => agent.agentName).join(", ") || "none"}`);
  }
  for (const info of agentInfos) {
    info.role = info.agentName === coordinator ? "coordinator" : "worker";
    info.coordinator = info.role === "worker" ? coordinator ?? null : null;
  }

  return {
    adapters,
    agentInfos,
    unavailableAgents,
    close() {
      for (const adapter of adapters.values()) adapter.close();
    },
  };
}
