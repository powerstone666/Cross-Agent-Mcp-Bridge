// Describes Gemini to the relay: its name and adapter factory. Routes: cli and ide (Antigravity).
import type { AgentModule } from "../../bridge/types/agent-module.js";
import { pickEnvironment } from "../../bridge/utils/pick-environment.js";
import { GeminiCliAdapter } from "./cli/gemini-cli-adapter.js";
import { GeminiIdeAdapter } from "./ide/gemini-ide-adapter.js";
import {
  GEMINI_AGENT_NAME,
  GEMINI_CHILD_ENVIRONMENT_ALLOWLIST,
  GEMINI_DISPLAY_NAME,
  loadGeminiConfig,
} from "./gemini-config.js";

export const geminiAgentModule: AgentModule = {
  agentName: GEMINI_AGENT_NAME,
  displayName: GEMINI_DISPLAY_NAME,

  createAdapter({ environment, humanApprovalChannel }) {
    const config = loadGeminiConfig({ environment });

    const useIde = humanApprovalChannel === "automatic"
      ? !config.binaryPath
      : config.mode === "ide" || humanApprovalChannel === "agent-ui";
    if (useIde) {
      return new GeminiIdeAdapter({ environment });
    }

    if (!config.binaryPath) {
      throw new Error(
        "Gemini CLI not found. Install it (npm install -g @google/gemini-cli) or set RELAY_GEMINI_BINARY.",
      );
    }
    return new GeminiCliAdapter({
      command: config.binaryPath,
      commandArguments: [config.acpFlag, ...(config.approvalMode ? ["--approval-mode", config.approvalMode] : [])],
      // Keep only variables Gemini needs, such as PATH and its configured binary.
      environment: pickEnvironment({
        environment,
        allowedNames: GEMINI_CHILD_ENVIRONMENT_ALLOWLIST,
      }),
    });
  },

  describeVscodeSetting() {
    return null;
  },
};
