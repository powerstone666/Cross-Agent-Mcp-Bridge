// Proves binary discovery, approval mode pass-through, and adapter creation.
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { GeminiCliAdapter } from "../../../src/ai-connectors/gemini-connector/cli/gemini-cli-adapter.js";
import { GeminiIdeAdapter } from "../../../src/ai-connectors/gemini-connector/ide/gemini-ide-adapter.js";
import { geminiAgentModule } from "../../../src/ai-connectors/gemini-connector/gemini-agent-module.js";
import {
  findGeminiBinary,
  loadGeminiConfig,
} from "../../../src/ai-connectors/gemini-connector/gemini-config.js";

const baseInput = { targetRepositoryPath: "/tmp", humanApprovalChannel: "terminal" } as const;

function makeTempDirectory() {
  return mkdtempSync(join(tmpdir(), "gemini-test-"));
}

function writeExecutable(directory: string) {
  mkdirSync(directory, { recursive: true });
  const path = join(directory, "gemini");
  writeFileSync(path, "#!/bin/sh\n");
  chmodSync(path, 0o755);
  return path;
}

test("RELAY_GEMINI_BINARY wins over PATH", () => {
  const onPath = makeTempDirectory();
  writeExecutable(onPath);
  const config = loadGeminiConfig({ environment: { RELAY_GEMINI_BINARY: "/pinned/gemini", PATH: onPath } });
  assert.equal(config.binaryPath, "/pinned/gemini");
});

test("finds gemini on PATH before the install folders", () => {
  const pathDirectory = makeTempDirectory();
  const homeDirectory = makeTempDirectory();
  const expected = writeExecutable(pathDirectory);
  writeExecutable(join(homeDirectory, ".npm-global", "bin"));
  assert.equal(findGeminiBinary({ pathVariable: pathDirectory, homeDirectory, systemDirectories: [] }), expected);
});

test("falls back to ~/.npm-global/bin and then the system folders", () => {
  const homeDirectory = makeTempDirectory();
  const systemDirectory = makeTempDirectory();
  const systemBinary = writeExecutable(systemDirectory);
  assert.equal(findGeminiBinary({ pathVariable: "", homeDirectory, systemDirectories: [systemDirectory] }), systemBinary);

  const homeBinary = writeExecutable(join(homeDirectory, ".npm-global", "bin"));
  assert.equal(findGeminiBinary({ pathVariable: "", homeDirectory, systemDirectories: [systemDirectory] }), homeBinary);
});

test("returns null when no Gemini CLI exists", () => {
  assert.equal(findGeminiBinary({ pathVariable: makeTempDirectory(), homeDirectory: makeTempDirectory(), systemDirectories: [] }), null);
});

test("creates the CLI adapter when a binary is configured", () => {
  const adapter = geminiAgentModule.createAdapter({ ...baseInput, environment: { RELAY_GEMINI_BINARY: "/fake/gemini" } });
  assert.ok(adapter instanceof GeminiCliAdapter);
});

test("gives a clear error when the binary is missing", () => {
  const environment = { PATH: makeTempDirectory(), HOME: makeTempDirectory() };
  // Skip when the machine really has Gemini in a system folder.
  if (loadGeminiConfig({ environment }).binaryPath) return;
  assert.throws(() => geminiAgentModule.createAdapter({ ...baseInput, environment }), /Gemini CLI not found/);
});

test("uses the Gemini CLI in the terminal by default", () => {
  const adapter = geminiAgentModule.createAdapter({ ...baseInput, humanApprovalChannel: "terminal", environment: { RELAY_GEMINI_BINARY: "/fake/gemini" } });
  assert.ok(adapter instanceof GeminiCliAdapter);
});

test("uses Gemini's approval default unless a mode is chosen", () => {
  assert.equal(loadGeminiConfig({ environment: {} }).approvalMode, null);
  assert.equal(loadGeminiConfig({ environment: { RELAY_GEMINI_APPROVAL_MODE: "yolo" } }).approvalMode, "yolo");
});

test("rejects an ACP flag that could carry a bypass option", () => {
  assert.throws(() => loadGeminiConfig({ environment: { RELAY_GEMINI_ACP_FLAG: "--yolo" } }), /RELAY_GEMINI_ACP_FLAG/);
  assert.equal(loadGeminiConfig({ environment: { RELAY_GEMINI_ACP_FLAG: "--acp" } }).acpFlag, "--acp");
});

test("needs no VS Code setting", () => {
  assert.equal(geminiAgentModule.describeVscodeSetting({ relayRootPath: "/repo" }), null);
});

test("allows only the two real ACP flags", () => {
  for (const flag of ["--approval-mode", "--sandbox", "--yolo", "-y"]) {
    assert.throws(() => loadGeminiConfig({ environment: { RELAY_GEMINI_ACP_FLAG: flag } }), /RELAY_GEMINI_ACP_FLAG must be one of/);
  }
  assert.equal(loadGeminiConfig({ environment: { RELAY_GEMINI_ACP_FLAG: "--experimental-acp" } }).acpFlag, "--experimental-acp");
});

test("uses the Antigravity route when there is no terminal, or when asked", () => {
  const base = { targetRepositoryPath: "/tmp" } as const;
  const viaMcp = geminiAgentModule.createAdapter({ ...base, environment: {}, humanApprovalChannel: "agent-ui" });
  assert.ok(viaMcp instanceof GeminiIdeAdapter);

  const asked = geminiAgentModule.createAdapter({ ...base, environment: { RELAY_GEMINI_MODE: "ide" }, humanApprovalChannel: "terminal" });
  assert.ok(asked instanceof GeminiIdeAdapter);
  const automatic = geminiAgentModule.createAdapter({ ...base, environment: { RELAY_GEMINI_BINARY: "/fake/gemini", RELAY_GEMINI_MODE: "ide" }, humanApprovalChannel: "automatic" });
  assert.ok(automatic instanceof GeminiCliAdapter);
});

test("rejects an unknown mode", () => {
  assert.throws(
    () => geminiAgentModule.createAdapter({ targetRepositoryPath: "/tmp", environment: { RELAY_GEMINI_MODE: "browser" }, humanApprovalChannel: "terminal" }),
    /RELAY_GEMINI_MODE must be one of/,
  );
});

