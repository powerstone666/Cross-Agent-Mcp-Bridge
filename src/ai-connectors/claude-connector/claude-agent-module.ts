// Describes Claude to the relay: its name, adapter factory and the VS Code setting it needs.
import { resolve } from "node:path";
import type { AgentModule } from "../../bridge/types/agent-module.js";
import { ClaudeCliAdapter } from "./cli/claude-cli-adapter.js";
import {
  CLAUDE_AGENT_NAME,
  CLAUDE_CLI_ARGUMENTS,
  CLAUDE_DISPLAY_NAME,
  CLAUDE_IDE_WRAPPER_RELATIVE_PATH,
  CLAUDE_PROCESS_WRAPPER_SETTING_KEY,
  loadClaudeConfig,
} from "./claude-config.js";
import { AgentHostIdeAdapter } from "../copilot-connector/ide/copilot-ide-adapter.js";
import { loadCopilotConfig } from "../copilot-connector/copilot-config.js";
import { ClaudeIdeAdapter } from "./ide/claude-ide-adapter.js";

export const claudeAgentModule: AgentModule = {
  agentName: CLAUDE_AGENT_NAME,
  displayName: CLAUDE_DISPLAY_NAME,

  createAdapter({ environment, humanApprovalChannel }) {
    const config = loadClaudeConfig({ environment });

    // Automatic mode uses CLI when present; the Agent Host is the messaging fallback.
    if (humanApprovalChannel === "agent-ui" || (humanApprovalChannel === "automatic" && !config.binaryPath)) {
      const hostConfig = loadCopilotConfig({ environment });
      return new AgentHostIdeAdapter({
        endpointDirectories: hostConfig.endpointDirectories,
        pinnedSessionId: null,
        provider: "claude",
      });
    }

    if (config.mode === "ide" && humanApprovalChannel !== "automatic") {
      return new ClaudeIdeAdapter({ socketDirectoryPath: config.ideSocketDirectoryPath });
    }

    if (!config.binaryPath) {
      throw new Error(
        "Claude binary not found. Install the Claude Code VS Code extension or set RELAY_CLAUDE_BINARY.",
      );
    }
    return new ClaudeCliAdapter({
      command: config.binaryPath,
      commandArguments: CLAUDE_CLI_ARGUMENTS,
      environment: environment,
    });
  },

  describeVscodeSetting({ relayRootPath }) {
    return {
      key: CLAUDE_PROCESS_WRAPPER_SETTING_KEY,
      value: resolve(relayRootPath, CLAUDE_IDE_WRAPPER_RELATIVE_PATH),
    };
  },
};
