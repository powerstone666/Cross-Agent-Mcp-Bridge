// Gemini names, child environment allowlist, and Gemini CLI finder.
import { accessSync, constants, statSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { readChoice } from "../../bridge/utils/read-choice.js";

export const GEMINI_AGENT_NAME = "gemini";
export const GEMINI_DISPLAY_NAME = "Gemini";

// "cli" starts the Gemini CLI. "ide" goes through the open Antigravity window.
export const GEMINI_MODES = ["cli", "ide"] as const;

// Older releases use `--experimental-acp`, newer ones `--acp`.
const DEFAULT_ACP_FLAG = "--experimental-acp";

export const GEMINI_CHILD_ENVIRONMENT_ALLOWLIST = [
  "PATH",
  "HOME",
  "USER",
  "SHELL",
  "LANG",
  "LC_ALL",
  "TMPDIR",
  "TERM",
] as const;

const BINARY_NAME = "gemini";
const HOME_FALLBACK_DIRECTORIES = [join(".npm-global", "bin")];
const SYSTEM_FALLBACK_DIRECTORIES = ["/opt/homebrew/bin", "/usr/local/bin"];

export interface GeminiConfig {
  mode: (typeof GEMINI_MODES)[number];
  // null when no Gemini CLI is found.
  binaryPath: string | null;
  acpFlag: string;
  approvalMode: string | null;
}

export function loadGeminiConfig({
  environment,
}: {
  environment: NodeJS.ProcessEnv;
}): GeminiConfig {
  return {
    mode: readChoice({
      name: "RELAY_GEMINI_MODE",
      value: environment.RELAY_GEMINI_MODE,
      allowedValues: GEMINI_MODES,
      defaultValue: "cli",
    }),
    // RELAY_GEMINI_BINARY wins, so users can pin a Gemini version.
    binaryPath:
      environment.RELAY_GEMINI_BINARY ??
      findGeminiBinary({
        pathVariable: environment.PATH ?? "",
        homeDirectory: environment.HOME ?? homedir(),
      }),
    acpFlag: readAcpFlag(environment.RELAY_GEMINI_ACP_FLAG),
    approvalMode: environment.RELAY_GEMINI_APPROVAL_MODE || null,
  };
}

// Only the two real ACP flags are allowed, so this variable cannot smuggle in another option.
const ALLOWED_ACP_FLAGS = ["--experimental-acp", "--acp"] as const;

function readAcpFlag(value: string | undefined): string {
  if (value === undefined || value === "") return DEFAULT_ACP_FLAG;
  const match = ALLOWED_ACP_FLAGS.find((flag) => flag === value);
  if (match === undefined) {
    throw new Error(`RELAY_GEMINI_ACP_FLAG must be one of: ${ALLOWED_ACP_FLAGS.join(", ")}`);
  }
  return match;
}

interface FindGeminiBinaryInput {
  pathVariable: string;
  homeDirectory: string;
  systemDirectories?: readonly string[];
}

// Looks on PATH first, then in the usual install folders. Only reads the disk.
export function findGeminiBinary({
  pathVariable,
  homeDirectory,
  systemDirectories = SYSTEM_FALLBACK_DIRECTORIES,
}: FindGeminiBinaryInput): string | null {
  const directories = [
    ...pathVariable.split(delimiter).filter(Boolean),
    ...HOME_FALLBACK_DIRECTORIES.map((directory) => join(homeDirectory, directory)),
    ...systemDirectories,
  ];
  for (const directory of directories) {
    const candidatePath = join(directory, BINARY_NAME);
    if (isExecutableFile(candidatePath)) return candidatePath;
  }
  return null;
}

function isExecutableFile(path: string): boolean {
  try {
    if (!statSync(path).isFile()) return false;
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}
