// Describes Copilot to the relay: its name and adapter factory. Copilot has an IDE route only.
// Copilot uses the VS Code agent host; this connector has no CLI route.
import type { AgentModule } from "../../bridge/types/agent-module.js";
import {
  COPILOT_AGENT_NAME,
  COPILOT_DISPLAY_NAME,
  loadCopilotConfig,
} from "./copilot-config.js";
import { CopilotIdeAdapter } from "./ide/copilot-ide-adapter.js";

// The agent host's provider id for Copilot; it is not the same as the relay's agent name.
const COPILOT_HOST_PROVIDER = "copilotcli";

export const copilotAgentModule: AgentModule = {
  agentName: COPILOT_AGENT_NAME,
  displayName: COPILOT_DISPLAY_NAME,

  createAdapter({ environment }) {
    const config = loadCopilotConfig({ environment });
    return new CopilotIdeAdapter({
      endpointDirectories: config.endpointDirectories,
      pinnedSessionId: config.pinnedSessionId,
      provider: COPILOT_HOST_PROVIDER,
    });
  },

  // VS Code publishes its own host entry, so no setting is needed.
  describeVscodeSetting: () => null,
};
