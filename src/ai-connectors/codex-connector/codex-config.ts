// Codex names, settings, the environment reader, and the Codex binary finder.
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { readChoice } from "../../bridge/utils/read-choice.js";

// The name people type after "@".
export const CODEX_AGENT_NAME = "codex";
export const CODEX_DISPLAY_NAME = "Codex";
// The VS Code setting that sets which program the Codex extension starts as its server.
export const CODEX_CLI_EXECUTABLE_SETTING_KEY = "chatgpt.cliExecutable";
export const CODEX_IDE_WRAPPER_RELATIVE_PATH = join("src", "ai-connectors", "codex-connector", "ide", "codex-ide-wrapper.sh");
// Where the Codex IDE wrapper creates its socket. One folder per agent, so agents never mix sockets.
const DEFAULT_IDE_SOCKET_DIRECTORY = ".cross-agent-mcp-bridge/ide-sockets/codex";

// Variables the Codex child process may receive.
export const CODEX_CHILD_ENVIRONMENT_ALLOWLIST = [
  "PATH",
  "HOME",
  "USER",
  "SHELL",
  "LANG",
  "LC_ALL",
  "TMPDIR",
  "TERM",
  "CODEX_HOME",
] as const;

// "cli" has its own thread and terminal approval; "ide" runs in the IDE thread.
export const CODEX_MODES = ["cli", "ide"] as const;

export type CodexMode = (typeof CODEX_MODES)[number];
export interface CodexConfig {
  mode: CodexMode;
  // null means "use the Codex default", which comes from the user's own Codex settings.
  approvalPolicy: string | null;
  sandboxMode: string | null;
  // null when no Codex install is found. Only CLI mode needs it.
  binaryPath: string | null;
  ideSocketDirectoryPath: string;
}

export function loadCodexConfig({
  environment,
}: {
  environment: NodeJS.ProcessEnv;
}): CodexConfig {
  return {
    mode: readChoice({
      name: "RELAY_CODEX_MODE",
      value: environment.RELAY_CODEX_MODE,
      allowedValues: CODEX_MODES,
      defaultValue: "cli",
    }),
    approvalPolicy: environment.RELAY_CODEX_APPROVAL_POLICY || null,
    sandboxMode: environment.RELAY_CODEX_SANDBOX || null,
    // RELAY_CODEX_BINARY wins, so users can pin a Codex version.
    binaryPath:
      environment.RELAY_CODEX_BINARY ??
      findCodexBinary({ homeDirectory: homedir() }),
    ideSocketDirectoryPath: resolveIdeSocketDirectory({ environment }),
  };
}

// RELAY_CODEX_IDE_SOCKET_DIRECTORY overrides the default. Wrapper and adapter must share it.
export function resolveIdeSocketDirectory({
  environment,
}: {
  environment: NodeJS.ProcessEnv;
}): string {
  return environment.RELAY_CODEX_IDE_SOCKET_DIRECTORY
    ? resolve(environment.RELAY_CODEX_IDE_SOCKET_DIRECTORY)
    : join(homedir(), DEFAULT_IDE_SOCKET_DIRECTORY);
}

// Codex extension folders start with this. Only reads the disk; never runs anything.
const EXTENSION_DIRECTORY_PREFIX = "openai.chatgpt-";

// Returns the `codex` path in the newest installed extension, or null.
export function findCodexBinary({
  homeDirectory,
}: {
  homeDirectory: string;
}): string | null {
  const extensionsPath = join(homeDirectory, ".vscode", "extensions");
  if (!existsSync(extensionsPath)) return null;

  // Newest first; numeric compare, so version 10 beats 9.
  const extensionNames = readdirSync(extensionsPath)
    .filter((name) => name.startsWith(EXTENSION_DIRECTORY_PREFIX))
    .sort((first, second) =>
      second.localeCompare(first, undefined, { numeric: true }),
    );

  for (const extensionName of extensionNames) {
    const binaryRoot = join(extensionsPath, extensionName, "bin");
    if (!existsSync(binaryRoot)) continue;

    // The platform folder varies by OS and CPU, so take the first one with a codex file.
    for (const platformName of readdirSync(binaryRoot)) {
      const candidatePath = join(binaryRoot, platformName, "codex");
      if (existsSync(candidatePath)) return candidatePath;
    }
  }
  return null;
}
