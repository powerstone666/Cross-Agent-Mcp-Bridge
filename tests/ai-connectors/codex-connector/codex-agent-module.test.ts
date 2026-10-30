// Proves the module picks the right adapter per mode and passes through Codex settings.
import assert from "node:assert/strict";
import { test } from "node:test";
import { IdeFirstAdapter } from "../../../src/bridge/ide-first-adapter.js";
import { CodexCliAdapter } from "../../../src/ai-connectors/codex-connector/cli/codex-cli-adapter.js";
import { codexAgentModule } from "../../../src/ai-connectors/codex-connector/codex-agent-module.js";
import { CodexIdeAdapter } from "../../../src/ai-connectors/codex-connector/ide/codex-ide-adapter.js";

const baseInput = { targetRepositoryPath: "/tmp" } as const;

test("uses the IDE when there is no terminal to ask in", () => {
  const adapter = codexAgentModule.createAdapter({ ...baseInput, environment: {}, humanApprovalChannel: "agent-ui" });
  assert.ok(adapter instanceof CodexIdeAdapter);
});

test("automatic mode uses the IDE when a Codex window is open and the CLI otherwise, unless a mode is set", () => {
  const adapter = codexAgentModule.createAdapter({ ...baseInput, environment: { RELAY_CODEX_BINARY: "/fake/codex" }, humanApprovalChannel: "automatic" });
  assert.ok(adapter instanceof IdeFirstAdapter);
  const cli = codexAgentModule.createAdapter({ ...baseInput, environment: { RELAY_CODEX_BINARY: "/fake/codex", RELAY_CODEX_MODE: "cli" }, humanApprovalChannel: "automatic" });
  assert.ok(cli instanceof CodexCliAdapter);
  const ide = codexAgentModule.createAdapter({ ...baseInput, environment: { RELAY_CODEX_BINARY: "/fake/codex", RELAY_CODEX_MODE: "ide" }, humanApprovalChannel: "automatic" });
  assert.ok(ide instanceof CodexIdeAdapter);
});

test("uses its own thread with terminal approvals by default, and the IDE when asked", () => {
  const CLI = codexAgentModule.createAdapter({
    ...baseInput,
    environment: { RELAY_CODEX_BINARY: "/fake/codex" },
    humanApprovalChannel: "terminal",
  });
  assert.ok(CLI instanceof CodexCliAdapter);

  const IDE = codexAgentModule.createAdapter({
    ...baseInput,
    environment: { RELAY_CODEX_MODE: "ide" },
    humanApprovalChannel: "terminal",
  });
  assert.ok(IDE instanceof CodexIdeAdapter);
});

test("accepts Codex approval and sandbox settings", () => {
  const adapter = codexAgentModule.createAdapter({ ...baseInput, environment: { RELAY_CODEX_APPROVAL_POLICY: "never", RELAY_CODEX_SANDBOX: "danger-full-access" }, humanApprovalChannel: "agent-ui" });
  assert.ok(adapter instanceof CodexIdeAdapter);
});

test("declares the VS Code setting that routes the Codex IDE through the relay", () => {
  assert.deepEqual(codexAgentModule.describeVscodeSetting({ relayRootPath: "/repo/cross-agent-mcp-bridge" }), {
    key: "chatgpt.cliExecutable",
    value: "/repo/cross-agent-mcp-bridge/src/ai-connectors/codex-connector/ide/codex-ide-wrapper.sh",
  });
});
