// JSON-RPC client for a `codex app-server` child process. Only CLI mode uses it.
// It only moves messages and never decides approvals.
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { isRecord } from "../../../bridge/utils/is-record.js";

// Standard JSON-RPC internal error code.
const JSON_RPC_INTERNAL_ERROR_CODE = -32603;
// Last error-output lines kept to explain a crash without unlimited memory.
const STDERR_TAIL_LINE_LIMIT = 20;

export interface CodexRpcClientOptions {
  command: string;
  commandArguments: string[];
  environment: NodeJS.ProcessEnv;
}

// A message with a method and params. A server request has the same shape but needs an answer.
export interface RpcNotification {
  method: string;
  params: unknown;
}

type NotificationHandler = (notification: RpcNotification) => void;
type ServerRequestHandler = (request: RpcNotification) => Promise<unknown>;
type ExitHandler = (error: Error) => void;

interface PendingRequest {
  resolve(value: unknown): void;
  reject(error: Error): void;
}

// Incoming lines are replies, notifications, or server requests (such as approvals).
// Messages have no "jsonrpc" field.
export class CodexRpcClient {
  private child: ChildProcessWithoutNullStreams | undefined;
  private nextRequestId = 1;
  private readonly pendingRequests = new Map<number, PendingRequest>();
  private readonly notificationHandlers = new Set<NotificationHandler>();
  private readonly exitHandlers = new Set<ExitHandler>();
  private serverRequestHandler: ServerRequestHandler | undefined;
  private readonly stderrTail: string[] = [];

  constructor(private readonly options: CodexRpcClientOptions) {}

  // Call once, and register handlers before sending requests.
  start(): void {
    const child = spawn(this.options.command, this.options.commandArguments, {
      env: this.options.environment,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child = child;

    createInterface({ input: child.stdout }).on("line", (line) =>
      this.handleLine(line),
    );
    child.stderr.on("data", (chunk) => this.rememberStderr(String(chunk)));
    // A write to a stopped child must not crash the relay with an unhandled error.
    child.stdin.on("error", () => undefined);
    child.on("error", (error) => this.handleExit(error));
    child.on("exit", (code, signal) =>
      this.handleExit(
        new Error(
          `Codex app-server exited (code ${code}, signal ${signal}). ${this.stderrTail.join("\n")}`.trim(),
        ),
      ),
    );
  }

  // Resolves with the reply `result`. Fails on an error reply or if the server exits first.
  request<Result = unknown>(method: string, params?: unknown): Promise<Result> {
    const id = this.nextRequestId++;
    return new Promise<Result>((resolve, reject) => {
      this.pendingRequests.set(id, {
        resolve: (value) => resolve(value as Result),
        reject,
      });
      try {
        this.send({ id, method, params });
      } catch (error) {
        this.pendingRequests.delete(id);
        reject(toError(error));
      }
    });
  }

  // Sends a message with no id, so there is no reply (for example `initialized`).
  notify(method: string, params?: unknown): void {
    this.send({ method, params });
  }

  // Sees notifications from all threads. Returns a function that removes the handler.
  onNotification(handler: NotificationHandler): () => void {
    this.notificationHandlers.add(handler);
    return () => this.notificationHandlers.delete(handler);
  }

  // Runs when the process fails to start or exits. Returns a function that removes it.
  onExit(handler: ExitHandler): () => void {
    this.exitHandlers.add(handler);
    return () => this.exitHandlers.delete(handler);
  }

  // Answers server requests such as approvals. Without it, each gets an error reply.
  setServerRequestHandler(handler: ServerRequestHandler): void {
    this.serverRequestHandler = handler;
  }

  // Pending requests then fail through the exit handler.
  close(): void {
    this.child?.kill();
  }

  private send(message: Record<string, unknown>): void {
    const stdin = this.child?.stdin;
    if (!stdin || stdin.destroyed) {
      throw new Error("Codex app-server is not running");
    }
    stdin.write(`${JSON.stringify(message)}\n`);
  }

  private handleLine(line: string): void {
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      return; // not a protocol message, so ignore it
    }
    if (!isRecord(message)) return;

    const { id, method, params } = message;
    // method and id: server request. method only: notification. id only: reply to our request.
    const hasId = typeof id === "string" || typeof id === "number";

    if (typeof method === "string" && hasId) {
      void this.answerServerRequest({ id, method, params });
    } else if (typeof method === "string") {
      for (const handler of this.notificationHandlers) {
        handler({ method, params });
      }
    } else if (typeof id === "number") {
      // Our request ids are numbers, so any other id cannot match.
      this.settleRequest({ id, message });
    }
  }

  private settleRequest({
    id,
    message,
  }: {
    id: number;
    message: Record<string, unknown>;
  }): void {
    const pending = this.pendingRequests.get(id);
    if (!pending) return;
    this.pendingRequests.delete(id);

    const { error, result } = message;
    if (isRecord(error)) {
      const detail =
        typeof error.message === "string" ? error.message : "unknown error";
      pending.reject(new Error(`Codex request failed: ${detail}`));
      return;
    }
    pending.resolve(result);
  }

  private async answerServerRequest({
    id,
    method,
    params,
  }: {
    id: string | number;
    method: string;
    params: unknown;
  }): Promise<void> {
    // Always reply exactly once, or the Codex turn would wait forever.
    try {
      if (!this.serverRequestHandler) {
        throw new Error(`Unsupported server request: ${method}`);
      }
      const result = await this.serverRequestHandler({ method, params });
      this.send({ id, result });
    } catch (error) {
      try {
        this.send({
          id,
          error: {
            code: JSON_RPC_INTERNAL_ERROR_CODE,
            message: toError(error).message,
          },
        });
      } catch {
        // The child has already stopped; the exit handler reported it.
      }
    }
  }

  // So no caller waits forever after the child stops.
  private handleExit(error: Error): void {
    for (const pending of this.pendingRequests.values()) pending.reject(error);
    this.pendingRequests.clear();
    for (const handler of this.exitHandlers) handler(error);
  }

  private rememberStderr(text: string): void {
    this.stderrTail.push(...text.split("\n").filter(Boolean));
    this.stderrTail.splice(0, this.stderrTail.length - STDERR_TAIL_LINE_LIMIT);
  }
}

// JavaScript allows throwing values that are not errors.
function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
