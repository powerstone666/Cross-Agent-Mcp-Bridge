// Proves the module always builds the IDE adapter, needs no VS Code setting and reads its folder override.
import assert from "node:assert/strict";
import { test } from "node:test";
import { copilotAgentModule } from "../../../src/ai-connectors/copilot-connector/copilot-agent-module.js";
import { loadCopilotConfig } from "../../../src/ai-connectors/copilot-connector/copilot-config.js";
import { CopilotIdeAdapter } from "../../../src/ai-connectors/copilot-connector/ide/copilot-ide-adapter.js";

test("always returns the IDE adapter and names the agent", () => {
  for (const humanApprovalChannel of ["terminal", "agent-ui"] as const) {
    const adapter = copilotAgentModule.createAdapter({
      environment: {},
      targetRepositoryPath: "/tmp",
      humanApprovalChannel,
    });
    assert.ok(adapter instanceof CopilotIdeAdapter);
  }
  assert.equal(copilotAgentModule.agentName, "copilot");
  assert.equal(copilotAgentModule.displayName, "GitHub Copilot");
  assert.equal(copilotAgentModule.describeVscodeSetting({ relayRootPath: "/repo" }), null);
});

test("uses the per-platform registry folders unless overridden", () => {
  const mac = loadCopilotConfig({ environment: {}, platform: "darwin", homeDirectory: "/home/u" });
  assert.deepEqual(mac.endpointDirectories, [
    "/home/u/Library/Application Support/Code/agent-host/local-endpoint/entries",
    "/home/u/Library/Application Support/Code - Insiders/agent-host/local-endpoint/entries",
  ]);
  const linux = loadCopilotConfig({ environment: {}, platform: "linux", homeDirectory: "/home/u" });
  assert.equal(linux.endpointDirectories[0], "/home/u/.config/Code/agent-host/local-endpoint/entries");

  const overridden = loadCopilotConfig({
    environment: { RELAY_COPILOT_ENDPOINT_DIRECTORY: "/x/entries", RELAY_COPILOT_SESSION_ID: "abc" },
  });
  assert.deepEqual(overridden, { endpointDirectories: ["/x/entries"], pinnedSessionId: "abc" });
});
