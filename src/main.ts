// Entry point of the relay: runs `chat` (the default) or `mcp`, by the first command-line word.
// Never name a specific agent here. Agents are found only through agent-modules.ts.

import { runChatCommand } from "./terminal-layer/chat-command.js";
import { runMcpCommand } from "./mcp-layer/mcp-command.js";
import { runInitCommand } from "./init-command.js";

// Command name to the function that runs it. Add new top-level commands here.
const COMMANDS: Readonly<Record<string, () => Promise<void>>> = {
  chat: runChatCommand,
  mcp: runMcpCommand,
  init: () => runInitCommand(process.argv.slice(3)),
};
const DEFAULT_COMMAND = "chat";

async function main(): Promise<void> {
  const commandName = process.argv[2] ?? DEFAULT_COMMAND;
  const command = COMMANDS[commandName];
  if (!command) {
    const known = Object.keys(COMMANDS).join(", ");
    throw new Error(`Unknown command "${commandName}". Use one of: ${known}`);
  }
  await command();
}

// `exitCode` instead of `process.exit()`, so output still being written can finish.
main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
