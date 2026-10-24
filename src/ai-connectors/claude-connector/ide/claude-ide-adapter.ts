// Sends a relay turn into the Claude IDE session through the wrapper's socket.
// Never answer an approval here. The human answers it in VS Code.
import { randomUUID } from "node:crypto";
import { readdir, stat } from "node:fs/promises";
import { connect, type Socket } from "node:net";
import { join } from "node:path";
import { createInterface } from "node:readline";
import type {
  AgentAdapter,
  AgentEvent,
  AgentStatus,
  AgentTurnRequest,
} from "../../../bridge/types/agent-adapter.js";
import { createAsyncQueue } from "../../../bridge/utils/create-async-queue.js";
import {
  parseIdeServerMessage,
  type IdeClientMessage,
  type IdeServerMessage,
} from "./claude-ide-protocol.js";

// The wrapper names its socket <pid>.sock.
const SOCKET_FILE_SUFFIX = ".sock";

export interface ClaudeIdeAdapterOptions {
  socketDirectoryPath: string;
}

export class ClaudeIdeAdapter implements AgentAdapter {
  constructor(private readonly options: ClaudeIdeAdapterOptions) {}

  // A connection serves one turn only.
  async *run(request: AgentTurnRequest): AsyncGenerator<AgentEvent> {
    const socket = await this.connectToNewestWrapper();
    // Replies with a different id belong to another client and are ignored.
    const requestId = randomUUID();
    const events = createAsyncQueue<AgentEvent>();

    const sendMessage = (message: IdeClientMessage) =>
      socket.write(`${JSON.stringify(message)}\n`);
    const interruptTurn = () => sendMessage({ type: "interrupt", requestId });

    createInterface({ input: socket }).on("line", (line) => {
      const message = parseIdeServerMessage(line);
      if (!message || message.requestId !== requestId) return;
      if (message.type === "delta") {
        events.push({ kind: "reply_delta", text: message.text });
      } else if (message.type === "error") {
        events.push({ kind: "error", text: message.message });
        events.end();
      } else if (message.type === "completed") {
        events.push(toTerminalEvent(message));
        events.end();
      }
    });
    socket.on("close", () => {
      events.push({ kind: "error", text: "Lost connection to the Claude IDE wrapper" });
      events.end();
    });

    request.signal.addEventListener("abort", interruptTurn, { once: true });
    try {
      sendMessage({ type: "send", requestId, text: request.messageText });
      // An already-aborted signal never fires "abort", so check it here.
      if (request.signal.aborted) interruptTurn();
      for await (const event of events) yield event;
    } finally {
      request.signal.removeEventListener("abort", interruptTurn);
      socket.destroy();
    }
  }

  // Only sockets that accept a connection count. Stale socket files do not.
  async readStatus(): Promise<AgentStatus> {
    let socketPaths: string[];
    try {
      socketPaths = await this.listSocketPathsNewestFirst();
    } catch (error) {
      return { mode: "ide", ideWrapperRunning: false, problem: error instanceof Error ? error.message : String(error) };
    }
    const connections = await Promise.all(
      socketPaths.map((socketPath) => connectToSocket(socketPath).catch(() => undefined)),
    );
    const liveConnections = connections.filter((socket) => socket !== undefined);
    for (const socket of liveConnections) socket.destroy();
    return {
      mode: "ide",
      ideWrapperRunning: liveConnections.length > 0,
      liveWrapperCount: liveConnections.length,
    };
  }

  close(): void {}

  // The newest wrapper most likely belongs to the VS Code window the user is looking at.
  private async connectToNewestWrapper(): Promise<Socket> {
    for (const socketPath of await this.listSocketPathsNewestFirst()) {
      try {
        return await connectToSocket(socketPath);
      } catch {
        // stale socket from a killed wrapper, try the next one
      }
    }
    throw new Error(
      "No Claude IDE wrapper is running. Set claudeCode.claudeProcessWrapper to the wrapper script and reload VS Code.",
    );
  }

  private async listSocketPathsNewestFirst(): Promise<string[]> {
    let fileNames: string[];
    try {
      fileNames = await readdir(this.options.socketDirectoryPath);
    } catch {
      return [];
    }
    const entries = await Promise.all(
      fileNames
        .filter((fileName) => fileName.endsWith(SOCKET_FILE_SUFFIX))
        .map(async (fileName) => {
          const path = join(this.options.socketDirectoryPath, fileName);
          try {
            return { path, modifiedMs: (await stat(path)).mtimeMs };
          } catch {
            return undefined; // removed after the folder was listed
          }
        }),
    );
    return entries
      .filter((entry) => entry !== undefined)
      .sort((first, second) => second.modifiedMs - first.modifiedMs)
      .map((entry) => entry.path);
  }
}

function connectToSocket(socketPath: string): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = connect(socketPath);
    socket.once("connect", () => resolve(socket));
    socket.once("error", reject);
  });
}

function toTerminalEvent(
  message: Extract<IdeServerMessage, { type: "completed" }>,
): AgentEvent {
  if (message.status === "interrupted") return { kind: "cancelled", text: "Turn interrupted" };
  if (message.status === "failed") {
    return { kind: "error", text: message.errorMessage ?? "Claude turn failed" };
  }
  return { kind: "reply_complete", text: "" };
}
