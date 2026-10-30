// Describes Codex to the relay: its name, adapter factory and the VS Code setting it needs.
import { resolve } from "node:path";
import type { AgentModule } from "../../bridge/types/agent-module.js";
import { IdeFirstAdapter } from "../../bridge/ide-first-adapter.js";
import { pickEnvironment } from "../../bridge/utils/pick-environment.js";
import { createShowInIde } from "../../bridge/utils/show-in-ide.js";
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

    const createIde = () => new CodexIdeAdapter({
      socketDirectoryPath: config.ideSocketDirectoryPath,
      newThreadParams: {
        cwd: targetRepositoryPath,
        // Without an explicit target repo, open new threads in the IDE's own workspace.
        preferIdeWorkspace: environment.RELAY_TARGET_REPO === undefined,
        ...(ideApprovalPolicy && { approvalPolicy: ideApprovalPolicy }),
        ...(config.sandboxMode && { sandbox: config.sandboxMode }),
      },
      showInIde: createShowInIde(environment),
    });
    // Only CLI mode needs the Codex binary.
    const createCli = (binaryPath: string) => new CodexCliAdapter({
      command: binaryPath,
      commandArguments: ["app-server"],
      // Keep only variables Codex needs, such as PATH and its configured binary.
      environment: pickEnvironment({
        environment,
        allowedNames: CODEX_CHILD_ENVIRONMENT_ALLOWLIST,
      }),
      approvalPolicy: config.approvalPolicy,
      sandboxMode: config.sandboxMode,
    });

    const chosenMode = environment.RELAY_CODEX_MODE;
    if (humanApprovalChannel === "automatic") {
      // Unless a mode is chosen, use the IDE whenever a Codex window is open, so the human sees it.
      if (chosenMode === "ide" || !config.binaryPath) return createIde();
      if (chosenMode === "cli") return createCli(config.binaryPath);
      return new IdeFirstAdapter({
        ide: createIde(),
        cli: createCli(config.binaryPath),
        isIdeOpen: (status) => status.ideWrapperRunning === true,
      });
    }

    if (config.mode === "ide" || humanApprovalChannel === "agent-ui") return createIde();
    if (!config.binaryPath) {
      throw new Error(
        "Codex binary not found. Install the Codex VS Code extension or set RELAY_CODEX_BINARY.",
      );
    }
    return createCli(config.binaryPath);
  },

  // Makes VS Code start the wrapper script instead of the Codex server.
  describeVscodeSetting({ relayRootPath }) {
    return {
      key: CODEX_CLI_EXECUTABLE_SETTING_KEY,
      value: resolve(relayRootPath, CODEX_IDE_WRAPPER_RELATIVE_PATH),
    };
  },
};
