// Proves the Codex program is found in the newest extension folder, or null. Version "26.10"
// must count as newer than "26.9".
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { findCodexBinary, loadCodexConfig } from "../../../src/ai-connectors/codex-connector/codex-config.js";

async function createExtension(homeDirectory: string, extensionName: string) {
  const platformDirectory = join(homeDirectory, ".vscode", "extensions", extensionName, "bin", "macos-aarch64");
  await mkdir(platformDirectory, { recursive: true });
  await writeFile(join(platformDirectory, "codex"), "");
  return join(platformDirectory, "codex");
}

test("picks the newest installed Codex extension", async () => {
  const homeDirectory = await mkdtemp(join(tmpdir(), "cross-agent-mcp-bridge-home-"));
  try {
    await createExtension(homeDirectory, "openai.chatgpt-26.9.0-darwin-arm64");
    const newest = await createExtension(homeDirectory, "openai.chatgpt-26.10.1-darwin-arm64");
    assert.equal(findCodexBinary({ homeDirectory }), newest);
  } finally {
    await rm(homeDirectory, { recursive: true, force: true });
  }
});

test("returns null when no extension is installed", async () => {
  const homeDirectory = await mkdtemp(join(tmpdir(), "cross-agent-mcp-bridge-home-"));
  try {
    assert.equal(findCodexBinary({ homeDirectory }), null);
  } finally {
    await rm(homeDirectory, { recursive: true, force: true });
  }
});

test("leaves policy and sandbox unset unless the user sets them", () => {
  const config = loadCodexConfig({ environment: {} });
  assert.equal(config.approvalPolicy, null);
  assert.equal(config.sandboxMode, null);
  assert.equal(loadCodexConfig({ environment: { RELAY_CODEX_APPROVAL_POLICY: "untrusted" } }).approvalPolicy, "untrusted");
  assert.equal(loadCodexConfig({ environment: { RELAY_CODEX_APPROVAL_POLICY: "never" } }).approvalPolicy, "never");
  assert.equal(loadCodexConfig({ environment: { RELAY_CODEX_SANDBOX: "danger-full-access" } }).sandboxMode, "danger-full-access");
});

test("keeps each agent's IDE sockets in its own folder", () => {
  assert.match(loadCodexConfig({ environment: {} }).ideSocketDirectoryPath, /\.cross-agent-mcp-bridge\/ide-sockets\/codex$/);
  assert.equal(loadCodexConfig({ environment: { RELAY_CODEX_IDE_SOCKET_DIRECTORY: "/tmp/x" } }).ideSocketDirectoryPath, "/tmp/x");
});

