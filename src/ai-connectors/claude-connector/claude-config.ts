// Claude names, environment variables and binary discovery.
import { accessSync, constants, existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { readChoice } from "../../bridge/utils/read-choice.js";

export const CLAUDE_AGENT_NAME = "claude";
export const CLAUDE_DISPLAY_NAME = "Claude";
export const CLAUDE_PROCESS_WRAPPER_SETTING_KEY = "claudeCode.claudeProcessWrapper";
export const CLAUDE_IDE_WRAPPER_RELATIVE_PATH = join(
  "src",
  "ai-connectors",
  "claude-connector",
  "ide",
  "claude-ide-wrapper.sh",
);
// One folder per agent, so agents never see each other's sockets.
const DEFAULT_IDE_SOCKET_DIRECTORY = ".cross-agent-mcp-bridge/ide-sockets/claude";
const EXTENSION_DIRECTORY_PREFIX = "anthropic.claude-code-";
const CLAUDE_PROGRAM_NAME = "claude";

export const CLAUDE_CLI_ARGUMENTS = [
  "-p",
  "--input-format",
  "stream-json",
  "--output-format",
  "stream-json",
  "--verbose",
  "--include-partial-messages",
  "--permission-prompt-tool",
  "stdio",
] as const;

export const CLAUDE_MODES = ["cli", "ide"] as const;
export type ClaudeMode = (typeof CLAUDE_MODES)[number];

export interface ClaudeConfig {
  mode: ClaudeMode;
  // null when no Claude install is found. Only CLI mode needs it.
  binaryPath: string | null;
  ideSocketDirectoryPath: string;
}

export function loadClaudeConfig({
  environment,
}: {
  environment: NodeJS.ProcessEnv;
}): ClaudeConfig {
  return {
    mode: readChoice({
      name: "RELAY_CLAUDE_MODE",
      value: environment.RELAY_CLAUDE_MODE,
      allowedValues: CLAUDE_MODES,
      defaultValue: "cli",
    }),
    binaryPath: findClaudeBinary({ environment, homeDirectory: homedir() }),
    ideSocketDirectoryPath: resolveClaudeIdeSocketDirectory({ environment }),
  };
}

// The wrapper and the adapter must resolve the same folder.
export function resolveClaudeIdeSocketDirectory({
  environment,
}: {
  environment: NodeJS.ProcessEnv;
}): string {
  return environment.RELAY_CLAUDE_IDE_SOCKET_DIRECTORY
    ? resolve(environment.RELAY_CLAUDE_IDE_SOCKET_DIRECTORY)
    : join(homedir(), DEFAULT_IDE_SOCKET_DIRECTORY);
}

// Order: RELAY_CLAUDE_BINARY, newest VS Code extension, then `claude` on PATH.
export function findClaudeBinary({
  environment,
  homeDirectory,
}: {
  environment: NodeJS.ProcessEnv;
  homeDirectory: string;
}): string | null {
  return (
    environment.RELAY_CLAUDE_BINARY ||
    findExtensionBinary({ homeDirectory }) ||
    findOnPath({ pathValue: environment.PATH })
  );
}

function findExtensionBinary({ homeDirectory }: { homeDirectory: string }): string | null {
  const extensionsPath = join(homeDirectory, ".vscode", "extensions");
  if (!existsSync(extensionsPath)) return null;

  // Numeric compare, so version 2.10 beats 2.9.
  const extensionNames = readdirSync(extensionsPath)
    .filter((name) => name.startsWith(EXTENSION_DIRECTORY_PREFIX))
    .sort((first, second) => second.localeCompare(first, undefined, { numeric: true }));

  for (const extensionName of extensionNames) {
    const candidatePath = join(extensionsPath, extensionName, "resources", "native-binary", CLAUDE_PROGRAM_NAME);
    if (existsSync(candidatePath)) return candidatePath;
  }
  return null;
}

function findOnPath({ pathValue }: { pathValue: string | undefined }): string | null {
  for (const directory of (pathValue ?? "").split(delimiter)) {
    if (!directory) continue;
    const candidatePath = join(directory, CLAUDE_PROGRAM_NAME);
    try {
      accessSync(candidatePath, constants.X_OK);
      return candidatePath;
    } catch {
      // not here, try the next folder
    }
  }
  return null;
}
