// Describes Gemini to the relay: its name and adapter factory. Routes: cli and ide (Antigravity).
import type { AgentModule } from "../../bridge/types/agent-module.js";
import { IdeFirstAdapter } from "../../bridge/ide-first-adapter.js";
import { createShowInIde } from "../../bridge/utils/show-in-ide.js";
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

    const createIde = () => new GeminiIdeAdapter({ environment, showInIde: createShowInIde(environment) });
    const createCli = (binaryPath: string) => new GeminiCliAdapter({
      command: binaryPath,
      commandArguments: [config.acpFlag, ...(config.approvalMode ? ["--approval-mode", config.approvalMode] : [])],
      // Keep only variables Gemini needs, such as PATH and its configured binary.
      environment: pickEnvironment({
        environment,
        allowedNames: GEMINI_CHILD_ENVIRONMENT_ALLOWLIST,
      }),
    });
    const chosenMode = environment.RELAY_GEMINI_MODE;
    if (humanApprovalChannel === "automatic") {
      // An explicit RELAY_GEMINI_MODE wins. Otherwise use Antigravity whenever it is open, so the
      // human sees the turn, and the CLI when it is not.
      if (chosenMode === "ide" || !config.binaryPath) return createIde();
      if (chosenMode !== "cli") {
        return new IdeFirstAdapter({
          ide: createIde(),
          cli: createCli(config.binaryPath),
          isIdeOpen: (status) => status.hubRunning === true,
        });
      }
    } else if (config.mode === "ide" || humanApprovalChannel === "agent-ui") {
      return createIde();
    }

    if (!config.binaryPath) {
      throw new Error(
        "Gemini CLI not found. Install it (npm install -g @google/gemini-cli) or set RELAY_GEMINI_BINARY.",
      );
    }
    return createCli(config.binaryPath);
  },

  describeVscodeSetting() {
    return null;
  },
};
