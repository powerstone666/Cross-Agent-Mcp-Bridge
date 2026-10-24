// The plug-in description of one agent: its name, how to build its adapter, its VS Code setting.
// Never implement an AgentModule in generic code. Only an agent's own folder does that.

import type { AgentAdapter } from "./agent-adapter.js";

// Approval route: terminal prompt, provider UI, or relay-handled automatic decisions.
export type HumanApprovalChannel = "terminal" | "agent-ui" | "automatic";

export interface CreateAgentAdapterInput {
  environment: NodeJS.ProcessEnv;
  targetRepositoryPath: string;
  humanApprovalChannel: HumanApprovalChannel;
}

// One VS Code setting an agent needs so its IDE runs through the relay.
// The settings script adds this key only and never changes others.
export interface VscodeSettingRequirement {
  key: string;
  value: string;
}

// `createAdapter` may throw: the registry then reports the agent as unavailable.
// `describeVscodeSetting` returns null when the agent needs no VS Code setting.
export interface AgentModule {
  // The name users type after "@", lowercase.
  agentName: string;
  displayName: string;
  createAdapter(input: CreateAgentAdapterInput): AgentAdapter;
  describeVscodeSetting(input: {
    relayRootPath: string;
  }): VscodeSettingRequirement | null;
}
