// JSON-RPC client for a `gemini --experimental-acp` child process.
// It only moves messages and never decides approvals.
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { isRecord } from "../../../bridge/utils/is-record.js";

const JSON_RPC_METHOD_NOT_FOUND_CODE = -32601;
const JSON_RPC_INTERNAL_ERROR_CODE = -32603;
const STDERR_TAIL_LINE_LIMIT = 20;

export interface GeminiAcpClientOptions {
  command: string;
  commandArguments: string[];
  environment: NodeJS.ProcessEnv;
  workingDirectory: string;
}

// An incoming message with a method. With an id it is a request that needs an answer.
export interface AcpMessage {
  method: string;
  params: unknown;
}

// A request handler throws this to answer with a "method not found" error.
export class AcpMethodNotFoundError extends Error {}

type NotificationHandler = (notification: AcpMessage) => void;
type AgentRequestHandler = (request: AcpMessage) => Promise<unknown>;
type ExitHandler = (error: Error) => void;

interface PendingRequest {
  resolve(value: unknown): void;
  reject(error: Error): void;
}

export class GeminiAcpClient {
  private child: ChildProcessWithoutNullStreams | undefined;
  private nextRequestId = 1;
  private readonly pendingRequests = new Map<number, PendingRequest>();
  private readonly notificationHandlers = new Set<NotificationHandler>();
  private readonly exitHandlers = new Set<ExitHandler>();
  private agentRequestHandler: AgentRequestHandler | undefined;
  private readonly stderrTail: string[] = [];

  constructor(private readonly options: GeminiAcpClientOptions) {}

  // Call once, and register handlers before sending requests.
  start(): void {
    const child = spawn(this.options.command, this.options.commandArguments, {
      env: this.options.environment,
      cwd: this.options.workingDirectory,
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
          `Gemini exited (code ${code}, signal ${signal}). ${this.stderrTail.join("\n")}`.trim(),
        ),
      ),
    );
  }

  // Resolves with the reply `result`. Fails on an error reply or if the child exits first.
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

  // A message with no id, so there is no reply.
  notify(method: string, params?: unknown): void {
    this.send({ method, params });
  }

  // Returns a function that removes the handler.
  onNotification(handler: NotificationHandler): () => void {
    this.notificationHandlers.add(handler);
    return () => this.notificationHandlers.delete(handler);
  }

  // Runs when the process fails to start or exits. Returns a function that removes it.
  onExit(handler: ExitHandler): () => void {
    this.exitHandlers.add(handler);
    return () => this.exitHandlers.delete(handler);
  }

  // Without a handler, every agent request gets a "method not found" error.
  setAgentRequestHandler(handler: AgentRequestHandler): void {
    this.agentRequestHandler = handler;
  }

  close(): void {
    this.child?.kill();
  }

  private send(message: Record<string, unknown>): void {
    const stdin = this.child?.stdin;
    if (!stdin || stdin.destroyed) {
      throw new Error("Gemini is not running");
    }
    stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
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
    const hasId = typeof id === "string" || typeof id === "number";

    if (typeof method === "string" && hasId) {
      void this.answerAgentRequest({ id, method, params });
    } else if (typeof method === "string") {
      for (const handler of this.notificationHandlers) {
        handler({ method, params });
      }
    } else if (typeof id === "number") {
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
      pending.reject(new Error(`Gemini request failed: ${detail}`));
      return;
    }
    pending.resolve(result);
  }

  private async answerAgentRequest({
    id,
    method,
    params,
  }: {
    id: string | number;
    method: string;
    params: unknown;
  }): Promise<void> {
    // Always reply exactly once, or the Gemini turn would wait forever.
    try {
      if (!this.agentRequestHandler) throw new AcpMethodNotFoundError(method);
      const result = await this.agentRequestHandler({ method, params });
      this.send({ id, result });
    } catch (error) {
      const code =
        error instanceof AcpMethodNotFoundError
          ? JSON_RPC_METHOD_NOT_FOUND_CODE
          : JSON_RPC_INTERNAL_ERROR_CODE;
      try {
        this.send({ id, error: { code, message: toError(error).message } });
      } catch {
        // The child has already stopped; the exit handler reported it.
      }
    }
  }

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

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
