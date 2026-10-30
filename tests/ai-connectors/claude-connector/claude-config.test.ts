// Proves binary discovery order, adapter choice and the VS Code setting.
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { IdeFirstAdapter } from "../../../src/bridge/ide-first-adapter.js";
import { claudeAgentModule } from "../../../src/ai-connectors/claude-connector/claude-agent-module.js";
import { findClaudeBinary } from "../../../src/ai-connectors/claude-connector/claude-config.js";
import { ClaudeCliAdapter } from "../../../src/ai-connectors/claude-connector/cli/claude-cli-adapter.js";
import { ClaudeIdeAdapter } from "../../../src/ai-connectors/claude-connector/ide/claude-ide-adapter.js";
import { AgentHostIdeAdapter } from "../../../src/ai-connectors/copilot-connector/ide/copilot-ide-adapter.js";

async function withTempDirectory(run: (directory: string) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), "cross-agent-mcp-bridge-claude-"));
  try {
    await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function createExecutable(path: string) {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, "");
  await chmod(path, 0o755);
  return path;
}

const extensionBinary = (home: string, version: string) =>
  join(home, ".vscode", "extensions", `anthropic.claude-code-${version}-darwin-arm64`, "resources", "native-binary", "claude");

test("RELAY_CLAUDE_BINARY wins over the extension and PATH", async () => {
  await withTempDirectory(async (home) => {
    await createExecutable(extensionBinary(home, "2.1.0"));
    assert.equal(findClaudeBinary({ environment: { RELAY_CLAUDE_BINARY: "/pinned/claude" }, homeDirectory: home }), "/pinned/claude");
  });
});

test("picks the newest extension by numeric version, before PATH", async () => {
  await withTempDirectory(async (home) => {
    await createExecutable(extensionBinary(home, "2.1.9"));
    const newest = await createExecutable(extensionBinary(home, "2.1.10"));
    const onPath = await createExecutable(join(home, "bin", "claude"));
    assert.equal(findClaudeBinary({ environment: { PATH: join(home, "bin") }, homeDirectory: home }), newest);
    assert.notEqual(newest, onPath);
  });
});

test("falls back to claude on PATH, then null", async () => {
  await withTempDirectory(async (home) => {
    assert.equal(findClaudeBinary({ environment: { PATH: join(home, "bin") }, homeDirectory: home }), null);
    const onPath = await createExecutable(join(home, "bin", "claude"));
    assert.equal(findClaudeBinary({ environment: { PATH: join(home, "bin") }, homeDirectory: home }), onPath);
  });
});

const baseInput = { targetRepositoryPath: "/tmp" } as const;

test("rejects an unknown mode, including bypass modes", () => {
  for (const mode of ["bypassPermissions", "auto", "acceptEdits"]) {
    assert.throws(
      () => claudeAgentModule.createAdapter({ ...baseInput, environment: { RELAY_CLAUDE_MODE: mode }, humanApprovalChannel: "terminal" }),
      /RELAY_CLAUDE_MODE must be one of/,
    );
  }
});

test("picks the adapter by mode and approval channel", () => {
  const cli = claudeAgentModule.createAdapter({ ...baseInput, environment: { RELAY_CLAUDE_BINARY: "/fake/claude" }, humanApprovalChannel: "terminal" });
  assert.ok(cli instanceof ClaudeCliAdapter);
  const ide = claudeAgentModule.createAdapter({ ...baseInput, environment: { RELAY_CLAUDE_MODE: "ide" }, humanApprovalChannel: "terminal" });
  assert.ok(ide instanceof ClaudeIdeAdapter);
  const agentUi = claudeAgentModule.createAdapter({ ...baseInput, environment: {}, humanApprovalChannel: "agent-ui" });
  assert.ok(agentUi instanceof AgentHostIdeAdapter);
  // By default each turn uses the Claude Code panel when a window has it open, else the CLI.
  const automatic = claudeAgentModule.createAdapter({ ...baseInput, environment: { RELAY_CLAUDE_BINARY: "/fake/claude" }, humanApprovalChannel: "automatic" });
  assert.ok(automatic instanceof IdeFirstAdapter);
  const automaticCli = claudeAgentModule.createAdapter({ ...baseInput, environment: { RELAY_CLAUDE_BINARY: "/fake/claude", RELAY_CLAUDE_MODE: "cli" }, humanApprovalChannel: "automatic" });
  assert.ok(automaticCli instanceof ClaudeCliAdapter);
  // An explicit IDE mode wins over the CLI, so the turn shows in the Claude Code panel.
  const automaticIde = claudeAgentModule.createAdapter({ ...baseInput, environment: { RELAY_CLAUDE_BINARY: "/fake/claude", RELAY_CLAUDE_MODE: "ide" }, humanApprovalChannel: "automatic" });
  assert.ok(automaticIde instanceof ClaudeIdeAdapter);
});

test("declares the VS Code setting that routes Claude through the wrapper", () => {
  assert.equal(claudeAgentModule.agentName, "claude");
  assert.deepEqual(claudeAgentModule.describeVscodeSetting({ relayRootPath: "/repo/cross-agent-mcp-bridge" }), {
    key: "claudeCode.claudeProcessWrapper",
    value: "/repo/cross-agent-mcp-bridge/src/ai-connectors/claude-connector/ide/claude-ide-wrapper.sh",
  });
});
