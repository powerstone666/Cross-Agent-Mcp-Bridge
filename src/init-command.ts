// Runs the existing VS Code setup script; dry-run stays the default and --apply is explicit.
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { AgentRoomManager } from "./bridge/agent-room-manager.js";
import { loadBridgeConfig } from "./bridge/bridge-config.js";

const relayRootPath = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export async function runInitCommand(arguments_: string[] = []): Promise<void> {
  const config = loadBridgeConfig({ environment: process.env, workingDirectory: process.cwd() });
  const tsxCliPath = resolve(relayRootPath, "node_modules/tsx/dist/cli.mjs");
  const setupScriptPath = resolve(
    relayRootPath,
    "configure-vscode-settings.ts",
  );

  // The existing script owns planning, conflict handling, backups, and writes.
  // Keep its dry-run default so `init` cannot silently change user settings.
  await new Promise<void>((resolvePromise, reject) => {
    const child = spawn(
      process.execPath,
      [tsxCliPath, setupScriptPath, ...arguments_],
      { cwd: relayRootPath, stdio: "inherit" },
    );
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) return resolvePromise();
      if (signal) return reject(new Error(`Setup script stopped by ${signal}.`));
      process.exitCode = code ?? 1;
      resolvePromise();
    });
  });

  if (process.exitCode && process.exitCode !== 0) return;
  if (!arguments_.includes("--apply")) {
    console.log(`Project room preview: ${config.targetRepositoryPath}/.agent-room/rooms/${config.agentRoomName}/`);
    console.log("Run with --apply to create the shared room and apply the displayed VS Code settings.");
    return;
  }

  // Initialize the shared room beside the project files so every agent joins the same workspace.
  const roomManager = new AgentRoomManager({ targetRepositoryPath: config.targetRepositoryPath, sessionId: randomUUID(), roomName: config.agentRoomName });
  await roomManager.createRoom(config.agentRoomName);
  console.log(`Initialized ${config.targetRepositoryPath}/.agent-room/rooms/${config.agentRoomName}/`);
  console.log("Start the shared MCP server and dashboard with: npm run mcp");
}
