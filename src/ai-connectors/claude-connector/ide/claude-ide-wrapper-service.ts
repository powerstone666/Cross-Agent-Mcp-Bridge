// Sits between the Claude extension and the real `claude`, and serves relay turns on a socket.
// Forward every line unchanged. If the relay socket fails, the IDE must keep working.
import { spawn, type ChildProcessByStdio } from "node:child_process";
import { chmod, mkdir, rm } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { dirname } from "node:path";
import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import { isRecord } from "../../../bridge/utils/is-record.js";
import { removeWrapperWorkspace, writeWrapperWorkspace } from "../../../bridge/utils/ide-wrapper-workspace.js";
import {
  buildUserLine,
  parseJsonLine,
  readAssistantText,
  readResult,
  readTextDelta,
  type JsonObject,
} from "../claude-stream-lines.js";
import { parseIdeClientMessage, type IdeServerMessage } from "./claude-ide-protocol.js";

// Request ids the relay makes up. Their replies are not forwarded: the extension never asked.
const INJECTED_ID_PREFIX = "cross-agent-mcp-bridge:";
export const WAITING_FOR_IDE_LINE = "[waiting for the Claude IDE session to finish its current turn]\n";
// Owner only, so other users cannot send turns into the IDE.
const SOCKET_DIRECTORY_MODE = 0o700;

export interface ClaudeIdeWrapperOptions {
  command: string;
  commandArguments: string[];
  environment: NodeJS.ProcessEnv;
  socketPath: string;
  // The VS Code window's folder, noted next to the socket so the relay can find this window.
  workspaceFolder?: string;
  // Normally this process's stdin and stdout.
  extensionInput: Readable;
  extensionOutput: Writable;
}

interface InjectedTurn {
  requestId: string;
  client: Socket;
  sawDelta: boolean;
  fallbackText: string;
  isInterruptRequested: boolean;
}

export interface WrapperState {
  sessionId: string | undefined;
  isTurnActive: boolean;
  pendingApprovalCount: number;
}

// Approvals for relay turns reach the IDE and the human answers them there. This class never does.
export class ClaudeIdeWrapperService {
  private child: ChildProcessByStdio<Writable, Readable, null> | undefined;
  private socketServer: Server | undefined;
  private sessionId: string | undefined;
  private isTurnActive = false;
  private readonly pendingApprovalIds = new Set<string>();
  private injectedTurn: InjectedTurn | undefined;
  // A relay turn that arrived while the human was mid-turn or an approval was open.
  private queuedTurn: { client: Socket; requestId: string; text: string } | undefined;
  private nextInjectedId = 1;

  constructor(private readonly options: ClaudeIdeWrapperOptions) {}

  // Passthrough starts first and the socket last, so a socket failure never blocks the IDE.
  async start(): Promise<void> {
    const child = spawn(this.options.command, this.options.commandArguments, {
      env: this.options.environment,
      stdio: ["pipe", "pipe", "inherit"],
    });
    this.child = child;
    child.stdin.on("error", () => undefined); // waitForExit reports the exit
    child.on("exit", () => this.failInjectedTurn("Claude process exited"));

    createInterface({ input: this.options.extensionInput }).on("line", (line) =>
      this.handleExtensionLine(line),
    );
    this.options.extensionInput.on("end", () => child.stdin.end());
    createInterface({ input: child.stdout }).on("line", (line) => this.handleClaudeLine(line));

    try {
      await this.listenOnSocket();
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      console.error(`cross-agent-mcp-bridge: relay socket disabled (${detail})`);
      this.socketServer = undefined;
    }
  }

  waitForExit(): Promise<number> {
    const child = this.child;
    if (!child) return Promise.reject(new Error("Wrapper is not started"));
    return new Promise((resolve) => child.on("exit", (code) => resolve(code ?? 1)));
  }

  async stop(): Promise<void> {
    this.child?.kill();
    await new Promise<void>((resolve) =>
      this.socketServer ? this.socketServer.close(() => resolve()) : resolve(),
    );
    await rm(this.options.socketPath, { force: true });
    await removeWrapperWorkspace(this.options.socketPath);
  }

  readState(): WrapperState {
    return {
      sessionId: this.sessionId,
      isTurnActive: this.isTurnActive,
      pendingApprovalCount: this.pendingApprovalIds.size,
    };
  }

  private async listenOnSocket(): Promise<void> {
    const directoryPath = dirname(this.options.socketPath);
    await mkdir(directoryPath, { recursive: true, mode: SOCKET_DIRECTORY_MODE });
    await chmod(directoryPath, SOCKET_DIRECTORY_MODE);
    // A file left by a crashed wrapper would make listen fail with EADDRINUSE.
    await rm(this.options.socketPath, { force: true });

    const server = createServer((client) => this.handleRelayClient(client));
    this.socketServer = server;
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(this.options.socketPath, resolve);
    });
    if (this.options.workspaceFolder) await writeWrapperWorkspace(this.options.socketPath, this.options.workspaceFolder);
  }

  // Forward first and unchanged. Only then look at the line.
  private handleExtensionLine(line: string): void {
    this.child?.stdin.write(`${line}\n`);

    const message = parseJsonLine(line);
    if (!message) return;
    this.observeSessionId(message);

    if (message.type === "user") {
      this.isTurnActive = true;
    } else if (message.type === "control_response") {
      const response = message.response;
      if (isRecord(response) && typeof response.request_id === "string") {
        this.pendingApprovalIds.delete(response.request_id);
      }
    }
  }

  private handleClaudeLine(line: string): void {
    const message = parseJsonLine(line);
    if (message && isInjectedResponse(message)) return;

    this.options.extensionOutput.write(`${line}\n`);
    if (message) this.observeClaudeMessage(message);
  }

  private observeClaudeMessage(message: JsonObject): void {
    this.observeSessionId(message);

    if (message.type === "control_request") {
      const { request_id: requestId, request } = message;
      if (typeof requestId === "string" && isRecord(request) && request.subtype === "can_use_tool") {
        this.pendingApprovalIds.add(requestId);
      }
      return;
    }
    if (message.type === "control_cancel_request" && typeof message.request_id === "string") {
      this.pendingApprovalIds.delete(message.request_id);
      return;
    }
    this.collectInjectedOutput(message);

    if (readResult(message)) {
      this.isTurnActive = false;
      this.pendingApprovalIds.clear();
      this.startQueuedTurn();
    }
  }

  private observeSessionId(message: JsonObject): void {
    if (typeof message.session_id === "string" && message.session_id !== "") {
      this.sessionId = message.session_id;
    }
  }

  private collectInjectedOutput(message: JsonObject): void {
    const turn = this.injectedTurn;
    if (!turn) return;

    const delta = readTextDelta(message);
    if (delta !== undefined) {
      turn.sawDelta = true;
      this.sendToClient(turn.client, { type: "delta", requestId: turn.requestId, text: delta });
      return;
    }
    const assistantText = readAssistantText(message);
    if (assistantText) turn.fallbackText += assistantText;

    const result = readResult(message);
    if (!result) return;
    const fallback = turn.fallbackText || result.text;
    if (!result.isFailure && !turn.sawDelta && fallback) {
      this.sendToClient(turn.client, { type: "delta", requestId: turn.requestId, text: fallback });
    }
    this.sendToClient(turn.client, {
      type: "completed",
      requestId: turn.requestId,
      status: turn.isInterruptRequested ? "interrupted" : result.isFailure ? "failed" : "completed",
      errorMessage: result.isFailure ? result.text : null,
    });
    this.injectedTurn = undefined;
  }

  private handleRelayClient(client: Socket): void {
    client.on("error", () => undefined);
    // The relay left. Free the slot; the turn itself keeps running in the IDE.
    client.on("close", () => {
      if (this.injectedTurn?.client === client) this.injectedTurn = undefined;
      if (this.queuedTurn?.client === client) this.queuedTurn = undefined;
    });
    createInterface({ input: client }).on("line", (line) => {
      const message = parseIdeClientMessage(line);
      if (!message) return;
      if (message.type === "invalid") {
        if (message.requestId !== undefined) {
          this.sendToClient(client, { type: "error", requestId: message.requestId, message: message.reason });
        }
      } else if (message.type === "send") {
        this.injectTurn({ client, requestId: message.requestId, text: message.text });
      } else {
        this.interruptTurn(message.requestId);
      }
    });
  }

  // Only while the IDE is idle, so the relay never speaks over the human or an open approval.
  // Otherwise the turn waits and starts as soon as the IDE's current turn ends.
  private injectTurn({ client, requestId, text }: { client: Socket; requestId: string; text: string }): void {
    if (this.injectedTurn || this.queuedTurn) {
      this.sendToClient(client, { type: "error", requestId, message: "A relayed turn is already running." });
      return;
    }
    if (this.pendingApprovalIds.size > 0 || this.isTurnActive) {
      this.queuedTurn = { client, requestId, text };
      this.sendToClient(client, { type: "delta", requestId, text: WAITING_FOR_IDE_LINE });
      return;
    }
    this.isTurnActive = true;
    this.injectedTurn = { requestId, client, sawDelta: false, fallbackText: "", isInterruptRequested: false };
    this.child?.stdin.write(`${buildUserLine(text)}\n`);
    this.sendToClient(client, { type: "accepted", requestId });
  }

  private startQueuedTurn(): void {
    const queued = this.queuedTurn;
    if (!queued) return;
    this.queuedTurn = undefined;
    if (!queued.client.destroyed) this.injectTurn(queued);
  }

  private interruptTurn(requestId: string): void {
    if (this.queuedTurn?.requestId === requestId) {
      const { client } = this.queuedTurn;
      this.queuedTurn = undefined;
      this.sendToClient(client, { type: "completed", requestId, status: "interrupted", errorMessage: null });
      return;
    }
    const turn = this.injectedTurn;
    if (!turn || turn.requestId !== requestId || turn.isInterruptRequested) return;
    turn.isInterruptRequested = true;
    const interruptRequest = {
      type: "control_request",
      request_id: `${INJECTED_ID_PREFIX}${this.nextInjectedId++}`,
      request: { subtype: "interrupt" },
    };
    this.child?.stdin.write(`${JSON.stringify(interruptRequest)}\n`);
  }

  private failInjectedTurn(message: string): void {
    const turn = this.injectedTurn;
    if (!turn) return;
    this.sendToClient(turn.client, { type: "error", requestId: turn.requestId, message });
    this.injectedTurn = undefined;
  }

  private sendToClient(client: Socket, message: IdeServerMessage): void {
    if (!client.destroyed) client.write(`${JSON.stringify(message)}\n`);
  }
}

function isInjectedResponse(message: JsonObject): boolean {
  if (message.type !== "control_response" || !isRecord(message.response)) return false;
  const { request_id: requestId } = message.response;
  return typeof requestId === "string" && requestId.startsWith(INJECTED_ID_PREFIX);
}

// True when the extension talks stream-json on stdio. Anything else is passed straight through.
export function isStreamJsonInvocation({
  commandArguments,
}: {
  commandArguments: readonly string[];
}): boolean {
  return (
    commandArguments.includes("--input-format=stream-json") ||
    (commandArguments.includes("--input-format") && commandArguments.includes("stream-json"))
  );
}
