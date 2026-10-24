// Describes Codex to the relay: its name, adapter factory and the VS Code setting it needs.
import { resolve } from "node:path";
import type { AgentModule } from "../../bridge/types/agent-module.js";
import { pickEnvironment } from "../../bridge/utils/pick-environment.js";
import { CodexCliAdapter } from "./cli/codex-cli-adapter.js";
import {
  CODEX_AGENT_NAME,
  CODEX_CHILD_ENVIRONMENT_ALLOWLIST,
  CODEX_CLI_EXECUTABLE_SETTING_KEY,
  CODEX_DISPLAY_NAME,
  CODEX_IDE_WRAPPER_RELATIVE_PATH,
  loadCodexConfig,
} from "./codex-config.js";
import { CodexIdeAdapter } from "./ide/codex-ide-adapter.js";

export const codexAgentModule: AgentModule = {
  agentName: CODEX_AGENT_NAME,
  displayName: CODEX_DISPLAY_NAME,

  // IDE mode needs no Codex binary: the wrapper starts the real Codex itself.
  createAdapter({ environment, targetRepositoryPath, humanApprovalChannel }) {
    const config = loadCodexConfig({ environment });
    const ideApprovalPolicy = config.approvalPolicy ?? (humanApprovalChannel === "automatic" ? "never" : null);

    const useIde = humanApprovalChannel === "automatic"
      ? !config.binaryPath
      : config.mode === "ide" || humanApprovalChannel === "agent-ui";
    if (useIde) {
      return new CodexIdeAdapter({
        socketDirectoryPath: config.ideSocketDirectoryPath,
        newThreadParams: {
          cwd: targetRepositoryPath,
          // Without an explicit target repo, open new threads in the IDE's own workspace.
          preferIdeWorkspace: environment.RELAY_TARGET_REPO === undefined,
          ...(ideApprovalPolicy && { approvalPolicy: ideApprovalPolicy }),
          ...(config.sandboxMode && { sandbox: config.sandboxMode }),
        },
      });
    }

    // Only CLI mode needs the Codex binary.
    if (!config.binaryPath) {
      throw new Error(
        "Codex binary not found. Install the Codex VS Code extension or set RELAY_CODEX_BINARY.",
      );
    }
    return new CodexCliAdapter({
      command: config.binaryPath,
      commandArguments: ["app-server"],
      // Keep only variables Codex needs, such as PATH and its configured binary.
      environment: pickEnvironment({
        environment,
        allowedNames: CODEX_CHILD_ENVIRONMENT_ALLOWLIST,
      }),
      approvalPolicy: config.approvalPolicy,
      sandboxMode: config.sandboxMode,
    });
  },

  // Makes VS Code start the wrapper script instead of the Codex server.
  describeVscodeSetting({ relayRootPath }) {
    return {
      key: CODEX_CLI_EXECUTABLE_SETTING_KEY,
      value: resolve(relayRootPath, CODEX_IDE_WRAPPER_RELATIVE_PATH),
    };
  },
};
