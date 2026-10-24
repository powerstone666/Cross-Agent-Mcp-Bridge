// The list of agents the relay can use. The only generic file that may import an agent module.
// Never put agent logic here. This file only lists modules.

import type { AgentModule } from "./bridge/types/agent-module.js";
import { claudeAgentModule } from "./ai-connectors/claude-connector/claude-agent-module.js";
import { codexAgentModule } from "./ai-connectors/codex-connector/codex-agent-module.js";
import { copilotAgentModule } from "./ai-connectors/copilot-connector/copilot-agent-module.js";
import { geminiAgentModule } from "./ai-connectors/gemini-connector/gemini-agent-module.js";

// To add an agent, create its <agent>-connector/ folder and add its module here.
export const AGENT_MODULES: readonly AgentModule[] = [
  codexAgentModule,
  claudeAgentModule,
  copilotAgentModule,
  geminiAgentModule,
];
