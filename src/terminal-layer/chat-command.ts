// Runs the terminal chat: reads what the human types, sends it to the bridge, prints the reply.
// Agent actions run automatically unless the user prefixes a message with /review.
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { AGENT_MODULES } from "../agent-modules.js";
import { createAgentRegistry } from "../bridge/agent-registry.js";
import { HUMAN_NAME, loadBridgeConfig } from "../bridge/bridge-config.js";
import { EventLogService } from "../bridge/event-log-service.js";
import { TerminalApprovalPrompter } from "./terminal-approval-prompter.js";
import { BridgeService } from "../bridge/bridge-service.js";
import { AgentRoomService } from "../bridge/agent-room-service.js";

const EXIT_COMMAND = "/exit";
const REVIEW_PREFIX = "/review ";

// Throws if no agent could start.
export async function runChatCommand(): Promise<void> {
  const config = loadBridgeConfig({
    environment: process.env,
    workingDirectory: process.cwd(),
  });

  const agentRegistry = createAgentRegistry({
    modules: AGENT_MODULES,
    environment: process.env,
    targetRepositoryPath: config.targetRepositoryPath,
    humanApprovalChannel: "terminal",
  });
  for (const { agentName, reason } of agentRegistry.unavailableAgents) {
    console.warn(`Agent @${agentName} unavailable: ${reason}`);
  }
  if (agentRegistry.adapters.size === 0) {
    throw new Error("No agent is available. See the messages above.");
  }

  // Chat and approval prompts share one readline so they do not compete for input.
  const readline = createInterface({ input: stdin, output: stdout });
  const conversationId = randomUUID();
  const agentRoom = new AgentRoomService({
    targetRepositoryPath: config.targetRepositoryPath,
    sessionId: conversationId,
    roomName: config.agentRoomName,
    participants: [HUMAN_NAME, ...agentRegistry.agentInfos.map((info) => info.agentName)],
    coordinatorId: agentRegistry.agentInfos.find((agent) => agent.role === "coordinator")?.agentName,
  });
  await agentRoom.initialize();
  const bridgeService = new BridgeService({
    adapters: agentRegistry.adapters,
    eventLog: new EventLogService({ logDirectoryPath: config.logDirectoryPath }),
    approvalPrompter: new TerminalApprovalPrompter({
      askQuestion: (question, signal) => readline.question(question, { signal }),
      writeLine: (text) => console.log(text),
    }),
    conversationId,
    workingDirectory: config.targetRepositoryPath,
    agentRoom,
  });

  const mentions = agentRegistry.agentInfos.map((info) => `@${info.agentName}`).join(", ");
  console.log(`cross-agent-mcp-bridge ready. Target repo: ${config.targetRepositoryPath}`);
  console.log(`Agents: ${mentions}. Log: ${config.logDirectoryPath}`);
  console.log(`Agent room: ${agentRoom.pathsForRoom.roomDirectoryPath}`);
  console.log(`Type "@<agent> <message>", prefix with /review to approve actions yourself, or ${EXIT_COMMAND} to quit. Ctrl+C cancels a running turn.`);

  // Closing the registry here also stops the agents' processes.
  readline.on("close", () => agentRegistry.close());

  let turnAbortController: AbortController | undefined;
  // Ctrl+C during a turn aborts it (a cancel, never an accept); at the prompt it quits.
  readline.on("SIGINT", () => {
    if (turnAbortController) turnAbortController.abort();
    else readline.close();
  });

  try {
    while (true) {
      const inputText = (await readline.question("you> ")).trim();
      if (!inputText) continue;
      if (inputText === EXIT_COMMAND) break;

      const requireHumanApproval = inputText.startsWith(REVIEW_PREFIX);
      const messageText = requireHumanApproval ? inputText.slice(REVIEW_PREFIX.length).trim() : inputText;

      turnAbortController = new AbortController();
      for await (const event of bridgeService.handleUserInput({
        inputText: messageText,
        signal: turnAbortController.signal,
        requireHumanApproval,
      })) {
        if (event.kind === "reply_delta") stdout.write(event.text);
        else if (event.kind === "reply_complete") stdout.write("\n");
        else console.log(`\n[${event.kind}] ${event.text}`);
      }
      turnAbortController = undefined;
    }
  } finally {
    agentRegistry.close();
    readline.close();
  }
}
