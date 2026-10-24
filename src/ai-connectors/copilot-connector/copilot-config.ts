// Copilot names, host registry folders, protocol versions and the environment reader.
// Never read Copilot credential files. The host token comes only from a registry entry.
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export const COPILOT_AGENT_NAME = "copilot";
export const COPILOT_DISPLAY_NAME = "GitHub Copilot";

export const ROOT_CHANNEL = "ahp-root://";
// Most preferred first. The host picks one and the client accepts only these.
export const AHP_PROTOCOL_VERSIONS = ["0.10.0", "0.9.0", "0.8.0"] as const;

export const MAX_MESSAGE_BYTES = 8 * 1024 * 1024;
export const ACK_TIMEOUT_MS = 10_000;
export const REQUEST_TIMEOUT_MS = 30_000;

const EDITOR_PRODUCT_FOLDERS = ["Code", "Code - Insiders"];
const REGISTRY_SUBPATH = join("agent-host", "local-endpoint", "entries");

export interface CopilotConfig {
  endpointDirectories: string[];
  // null means "use the newest session".
  pinnedSessionId: string | null;
}

export function loadCopilotConfig({
  environment,
  platform = process.platform,
  homeDirectory = homedir(),
}: {
  environment: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  homeDirectory?: string;
}): CopilotConfig {
  const overrideDirectory = environment.RELAY_COPILOT_ENDPOINT_DIRECTORY;
  return {
    endpointDirectories: overrideDirectory
      ? [resolve(overrideDirectory)]
      : defaultEndpointDirectories({ environment, platform, homeDirectory }),
    pinnedSessionId: environment.RELAY_COPILOT_SESSION_ID || null,
  };
}

function defaultEndpointDirectories({
  environment,
  platform,
  homeDirectory,
}: {
  environment: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  homeDirectory: string;
}): string[] {
  const settingsRoot =
    platform === "darwin"
      ? join(homeDirectory, "Library", "Application Support")
      : platform === "win32"
        ? (environment.APPDATA ?? join(homeDirectory, "AppData", "Roaming"))
        : join(homeDirectory, ".config");
  return EDITOR_PRODUCT_FOLDERS.map((folder) => join(settingsRoot, folder, REGISTRY_SUBPATH));
}
