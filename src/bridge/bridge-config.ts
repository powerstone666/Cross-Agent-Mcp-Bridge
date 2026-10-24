// Reads the settings every agent shares: the target repository and the event log folder.
// Never put agent-specific settings here. They belong in the <agent>-connector/ folder.

import { join, resolve } from "node:path";

// The name the event log uses for the person at the keyboard.
export const HUMAN_NAME = "human";
// How the relay identifies itself to agents and MCP clients.
export const CLIENT_NAME = "cross-agent-mcp-bridge";
export const CLIENT_VERSION = "0.1.0";
// Log folder, relative to the target repository, so each repository keeps its own logs.
export const LOG_DIRECTORY_NAME = ".cross-agent-mcp-bridge/log";
export const DEFAULT_AGENT_ROOM_NAME = "backend";

export interface BridgeConfig {
  // The project the agents work in.
  targetRepositoryPath: string;
  logDirectoryPath: string;
  agentRoomName: string;
}

interface LoadBridgeConfigInput {
  environment: NodeJS.ProcessEnv;
  workingDirectory: string;
}

// Reads RELAY_TARGET_REPO (default: the working directory) and RELAY_LOG_DIRECTORY.
// Paths are made absolute, so a later change of working directory cannot move the log.
export function loadBridgeConfig({
  environment,
  workingDirectory,
}: LoadBridgeConfigInput): BridgeConfig {
  const targetRepositoryPath = resolve(
    environment.RELAY_TARGET_REPO ?? workingDirectory,
  );
  const logDirectoryPath = environment.RELAY_LOG_DIRECTORY
    ? resolve(environment.RELAY_LOG_DIRECTORY)
    : join(targetRepositoryPath, LOG_DIRECTORY_NAME);
  const agentRoomName = environment.RELAY_AGENT_ROOM?.trim() || DEFAULT_AGENT_ROOM_NAME;

  return { targetRepositoryPath, logDirectoryPath, agentRoomName };
}
