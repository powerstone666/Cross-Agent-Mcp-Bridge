// Sits between the Codex extension and the real `codex app-server`, and serves relay turns on a socket.
// Forward every line unchanged. If the relay socket fails, the IDE must keep working.
import { spawn, type ChildProcessByStdio } from "node:child_process";
import { chmod, mkdir, rm } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { dirname } from "node:path";
import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import {
  parseIdeClientMessage,
  type NewThreadParams,
  type IdeServerMessage,
} from "./codex-ide-protocol.js";
import { isRecord } from "../../../bridge/utils/is-record.js";
import { removeWrapperWorkspace, writeWrapperWorkspace } from "../../../bridge/utils/ide-wrapper-workspace.js";

// Prefix of request ids the relay makes up. Replies to them are not forwarded,
// because the extension never sent those requests.
const INJECTED_ID_PREFIX = "cross-agent-mcp-bridge:";
// Owner only, so other users cannot send turns into the IDE.
const SOCKET_DIRECTORY_MODE = 0o700;
// Marks threads the relay starts as made by cross-agent-mcp-bridge.
const SERVICE_NAME = "cross-agent-mcp-bridge";
const NO_ACTIVE_THREAD_MESSAGE =
  "No active Codex thread in the IDE. Open a chat in Codex (VS Code) and send one message first.";

export interface CodexIdeWrapperOptions {
  command: string;
  commandArguments: string[];
  environment: NodeJS.ProcessEnv;
  socketPath: string;
  // Normally this process's stdin and stdout.
  extensionInput: Readable;
  extensionOutput: Writable;
}

// The one running relay turn. `stage` shows which reply we wait for: thread/start, then turn/start.
interface InjectedTurn {
  requestId: string;
  text: string;
  stage: "starting-thread" | "starting-turn";
  threadId: string | undefined;
  client: Socket;
  turnId: string | undefined;
  // The relay asked to stop before the turn id was known. Sent once it is.
  isInterruptRequested: boolean;
  // Id of the thread/start or turn/start request we wait on. Replies to other relay
  // requests, such as turn/interrupt, must not be mistaken for it.
  awaitedResponseId: string;
  // The folder a new relay thread is being started in (only while stage is "starting-thread").
  newThreadCwd?: string;
}

// Passes lines between the extension and app-server unchanged. Relay turns use the socket.
// Approvals for relay turns reach the IDE, where the human answers them.
export class CodexIdeWrapperService {
  private child: ChildProcessByStdio<Writable, Readable, null> | undefined;
  private socketServer: Server | undefined;
  // Learned by watching the traffic.
  private activeThreadId: string | undefined;
  // The workspace folder the extension last used, so a relay thread opens in the same project.
  private ideWorkspaceFolder: string | undefined;
  // The thread the relay itself created. It is never the IDE's thread, and it is reused only
  // for the same folder, so a thread made for one folder cannot swallow turns meant for another.
  private relayThread: { threadId: string; cwd: string } | undefined;
  private nextInjectedId = 1;
  // Only one at a time. injectTurn rejects a second.
  private injectedTurn: InjectedTurn | undefined;

  constructor(private readonly options: CodexIdeWrapperOptions) {}

  // Server and passthrough start first, the relay socket last,
  // so the IDE keeps working even if the socket fails.
  async start(): Promise<void> {
    const child = spawn(this.options.command, this.options.commandArguments, {
      env: this.options.environment,
      // Server error output goes straight to the extension's, unchanged.
      stdio: ["pipe", "pipe", "inherit"],
    });
    this.child = child;
    child.stdin.on("error", () => undefined); // ignored: waitForExit reports the exit

    createInterface({ input: this.options.extensionInput }).on("line", (line) =>
      this.handleExtensionLine(line),
    );
    // VS Code is shutting down: close the server's input so it finishes.
    this.options.extensionInput.on("end", () => child.stdin.end());
    createInterface({ input: child.stdout }).on("line", (line) =>
      this.handleServerLine(line),
    );

    try {
      await this.listenOnSocket();
    } catch (error) {
      // The IDE must keep working even if the relay socket cannot start.
      const detail = error instanceof Error ? error.message : String(error);
      console.error(`cross-agent-mcp-bridge: relay socket disabled (${detail})`);
      this.socketServer = undefined;
    }
  }

  waitForExit(): Promise<number> {
    const child = this.child;
    if (!child) return Promise.reject(new Error("Wrapper is not started"));
    return new Promise((resolve) =>
      child.on("exit", (code) => resolve(code ?? 1)),
    );
  }

  async stop(): Promise<void> {
    this.child?.kill();
    await new Promise<void>((resolve) =>
      this.socketServer ? this.socketServer.close(() => resolve()) : resolve(),
    );
    await rm(this.options.socketPath, { force: true });
    await removeWrapperWorkspace(this.options.socketPath);
  }

  private async listenOnSocket(): Promise<void> {
    await mkdir(dirname(this.options.socketPath), {
      recursive: true,
      mode: SOCKET_DIRECTORY_MODE,
    });
    // mkdir leaves an existing folder as it is, so tighten it too.
    await chmod(dirname(this.options.socketPath), SOCKET_DIRECTORY_MODE);
    // Remove a file left by a crashed wrapper, or listen fails with EADDRINUSE.
    await rm(this.options.socketPath, { force: true });

    const server = createServer((client) => this.handleRelayClient(client));
    this.socketServer = server;
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(this.options.socketPath, resolve);
    });
  }

  // Forward first and unchanged. Only then look at the line.
  private handleExtensionLine(line: string): void {
    this.child?.stdin.write(`${line}\n`);

    // Remember the IDE's thread so relay turns join the conversation the human sees.
    const message = parseLine(line);
    if (message && isRecord(message.params) && typeof message.params.cwd === "string") {
      if (message.params.cwd !== this.ideWorkspaceFolder) {
        void writeWrapperWorkspace(this.options.socketPath, message.params.cwd);
      }
      this.ideWorkspaceFolder = message.params.cwd;
    }
    if (
      message &&
      (message.method === "turn/start" || message.method === "thread/resume") &&
      isRecord(message.params) &&
      typeof message.params.threadId === "string"
    ) {
      this.activeThreadId = message.params.threadId;
    }
  }

  private handleServerLine(line: string): void {
    const message = parseLine(line);
    const id = message?.id;
    const isInjectedResponse =
      typeof id === "string" &&
      id.startsWith(INJECTED_ID_PREFIX) &&
      message?.method === undefined;

    // Approvals are server requests with a `method`, so they are not matched and reach the IDE.
    if (isInjectedResponse) {
      this.handleInjectedResponse(message ?? {});
      return; // the extension never made this request, so it must not see the reply
    }

    this.options.extensionOutput.write(`${line}\n`);
    if (message) {
      this.observeServerNotification(message);
    }
  }

  private observeServerNotification(message: Record<string, unknown>): void {
    const { method, params } = message;
    if (typeof method !== "string" || !isRecord(params)) return;

    // Threads the relay made itself must not become the IDE's active thread.
    const isRelayStartingThread = this.injectedTurn?.stage === "starting-thread";
    if (method === "thread/started" && isRecord(params.thread) && !isRelayStartingThread) {
      const startedId = params.thread.id;
      if (typeof startedId === "string" && startedId !== this.relayThread?.threadId) {
        this.activeThreadId = startedId;
      }
    }

    // The IDE may use other threads too. Pass on only the relay turn's thread.
    const turn = this.injectedTurn;
    if (!turn || turn.threadId === undefined || params.threadId !== turn.threadId) {
      return;
    }

    // The human can also run turns on this thread. Once the relay turn id is known,
    // ignore other turns' messages so their text never reaches the relay.
    const notificationTurnId =
      typeof params.turnId === "string"
        ? params.turnId
        : isRecord(params.turn) && typeof params.turn.id === "string"
          ? params.turn.id
          : undefined;
    if (
      turn.turnId !== undefined &&
      notificationTurnId !== undefined &&
      notificationTurnId !== turn.turnId
    ) {
      return;
    }

    if (method === "item/agentMessage/delta" && typeof params.delta === "string") {
      this.sendToClient(turn.client, {
        type: "delta",
        requestId: turn.requestId,
        text: params.delta,
      });
    } else if (method === "turn/completed") {
      const completedTurn = isRecord(params.turn) ? params.turn : {};
      this.sendToClient(turn.client, {
        type: "completed",
        requestId: turn.requestId,
        status:
          typeof completedTurn.status === "string"
            ? completedTurn.status
            : "completed",
        errorMessage:
          isRecord(completedTurn.error) &&
          typeof completedTurn.error.message === "string"
            ? completedTurn.error.message
            : null,
      });
      this.injectedTurn = undefined;
    }
  }

  // The server answers thread/start (only if the IDE had no thread), then turn/start.
  private handleInjectedResponse(message: Record<string, unknown>): void {
    const turn = this.injectedTurn;
    if (!turn || message.id !== turn.awaitedResponseId) return;

    if (isRecord(message.error)) {
      const detail =
        typeof message.error.message === "string"
          ? message.error.message
          : "turn/start was rejected";
      this.sendToClient(turn.client, {
        type: "error",
        requestId: turn.requestId,
        message: detail,
      });
      this.injectedTurn = undefined;
      return;
    }

    if (turn.stage === "starting-thread") {
      const threadPayload = isRecord(message.result) ? message.result.thread : undefined;
      if (!isRecord(threadPayload) || typeof threadPayload.id !== "string") {
        this.sendToClient(turn.client, {
          type: "error",
          requestId: turn.requestId,
          message: "thread/start returned no thread id",
        });
        this.injectedTurn = undefined;
        return;
      }
      // Remember it as the relay's own thread. It is not the IDE's active thread.
      this.relayThread = { threadId: threadPayload.id, cwd: turn.newThreadCwd ?? "" };
      turn.threadId = threadPayload.id;
      turn.stage = "starting-turn";
      turn.awaitedResponseId = this.startTurn({ threadId: threadPayload.id, text: turn.text });
      return;
    }

    // Second stage: the turn id is needed later to interrupt the turn.
    const turnPayload = isRecord(message.result) ? message.result.turn : undefined;
    if (!isRecord(turnPayload) || typeof turnPayload.id !== "string" || !turn.threadId) {
      // Without a turn id the turn cannot be followed or stopped, so report an error.
      this.sendToClient(turn.client, {
        type: "error",
        requestId: turn.requestId,
        message: "turn/start returned no turn id",
      });
      this.injectedTurn = undefined;
      return;
    }
    turn.turnId = turnPayload.id;
    this.sendToClient(turn.client, {
      type: "accepted",
      requestId: turn.requestId,
      threadId: turn.threadId,
      turnId: turn.turnId,
    });
    if (turn.isInterruptRequested) this.interruptTurn(turn.requestId);
  }

  private handleRelayClient(client: Socket): void {
    client.on("error", () => undefined);
    // The relay disconnected: free the single turn slot.
    client.on("close", () => {
      if (this.injectedTurn?.client === client) this.injectedTurn = undefined;
    });
    createInterface({ input: client }).on("line", (line) => {
      const message = parseIdeClientMessage(line);
      if (!message) return;
      if (message.type === "invalid") {
        if (message.requestId !== undefined) {
          this.sendToClient(client, { type: "error", requestId: message.requestId, message: message.reason });
        }
      } else if (message.type === "send") {
        this.injectTurn({
          client,
          requestId: message.requestId,
          text: message.text,
          newThreadParams: message.newThreadParams,
        });
      } else {
        this.interruptTurn(message.requestId);
      }
    });
  }

  // With an IDE thread, send turn/start. Otherwise send thread/start first, then turn/start.
  private injectTurn({
    client,
    requestId,
    text,
    newThreadParams,
  }: {
    client: Socket;
    requestId: string;
    text: string;
    newThreadParams: NewThreadParams | undefined;
  }): void {
    if (this.injectedTurn) {
      this.sendToClient(client, { type: "error", requestId, message: "A relayed turn is already running." });
      return;
    }

    if (this.activeThreadId) {
      const awaitedResponseId = this.startTurn({ threadId: this.activeThreadId, text });
      this.injectedTurn = { requestId, text, stage: "starting-turn", threadId: this.activeThreadId, client, turnId: undefined, isInterruptRequested: false, awaitedResponseId };
      return;
    }

    // No IDE thread and no settings for a new one: do not guess, report an error.
    if (!newThreadParams) {
      this.sendToClient(client, { type: "error", requestId, message: NO_ACTIVE_THREAD_MESSAGE });
      return;
    }
    const { preferIdeWorkspace, cwd, ...chosenSettings } = newThreadParams;
    const threadCwd = (preferIdeWorkspace && this.ideWorkspaceFolder) || cwd;

    // Keep follow-up relay turns in one conversation, but only inside the same folder.
    if (this.relayThread?.cwd === threadCwd) {
      const { threadId } = this.relayThread;
      const awaitedResponseId = this.startTurn({ threadId, text });
      this.injectedTurn = { requestId, text, stage: "starting-turn", threadId, client, turnId: undefined, isInterruptRequested: false, awaitedResponseId };
      return;
    }

    // Only settings the user chose are sent; the rest comes from the user's own Codex defaults.
    const awaitedResponseId = this.writeInjectedRequest("thread/start", {
      ...chosenSettings,
      cwd: threadCwd,
      serviceName: SERVICE_NAME,
    });
    this.injectedTurn = { requestId, text, stage: "starting-thread", threadId: undefined, client, turnId: undefined, isInterruptRequested: false, awaitedResponseId, newThreadCwd: threadCwd };
  }

  private startTurn({ threadId, text }: { threadId: string; text: string }): string {
    return this.writeInjectedRequest("turn/start", {
      threadId,
      input: [{ type: "text", text, text_elements: [] }],
    });
  }

  // If the turn id is unknown yet, remember the stop and send it once the id arrives,
  // so a fast stop is never lost.
  private interruptTurn(requestId: string): void {
    const turn = this.injectedTurn;
    if (!turn || turn.requestId !== requestId) return;
    if (!turn.turnId || !turn.threadId) {
      turn.isInterruptRequested = true;
      return;
    }
    this.writeInjectedRequest("turn/interrupt", { threadId: turn.threadId, turnId: turn.turnId });
  }

  private writeInjectedRequest(method: string, params: Record<string, unknown>): string {
    const id = `${INJECTED_ID_PREFIX}${this.nextInjectedId++}`;
    this.writeToServer({ id, method, params });
    return id;
  }

  private writeToServer(message: Record<string, unknown>): void {
    this.child?.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private sendToClient(client: Socket, message: IdeServerMessage): void {
    if (!client.destroyed) client.write(`${JSON.stringify(message)}\n`);
  }
}

// Only for looking at a line. Callers forward the original line either way.
function parseLine(line: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(line);
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined; // not a protocol message; the line is still forwarded unchanged
  }
}

// When unsure, answer false: a wrong true would break other codex commands,
// while a wrong false only skips the relay.
const APP_SERVER_COMMAND = "app-server";

// True for `codex [options] app-server [options]`. Options can come first, so search for it.
// `app-server daemon` is a subcommand, so it returns false.
export function isAppServerInvocation({
  commandArguments,
}: {
  commandArguments: readonly string[];
}): boolean {
  const commandIndex = commandArguments.indexOf(APP_SERVER_COMMAND);
  if (commandIndex === -1) return false;

  // A non-option word after `app-server` is a subcommand. Do not wrap it.
  const nextArgument = commandArguments[commandIndex + 1];
  return nextArgument === undefined || nextArgument.startsWith("-");
}
