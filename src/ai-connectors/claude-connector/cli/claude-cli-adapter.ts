// Runs relay turns in one long-lived `claude -p` child that speaks stream-json on stdio.
// Never auto-approve and never send updatedPermissions.
import { spawn, type ChildProcessByStdio } from "node:child_process";
import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import type {
  AgentAdapter,
  AgentEvent,
  AgentStatus,
  AgentTurnRequest,
  ApprovalDecision,
  ApprovalRequest,
} from "../../../bridge/types/agent-adapter.js";
import { createAsyncQueue, type AsyncQueue } from "../../../bridge/utils/create-async-queue.js";
import { isRecord } from "../../../bridge/utils/is-record.js";
import {
  buildUserLine,
  parseJsonLine,
  readAssistantText,
  readResult,
  readTextDelta,
  type JsonObject,
} from "../claude-stream-lines.js";

const FILE_CHANGE_TOOLS = ["Edit", "Write", "MultiEdit", "NotebookEdit"];
const STDERR_LINES_KEPT = 10;
const DETAIL_TEXT_LIMIT = 500;
// If Claude never ends an interrupted turn, give up and restart the child on the next turn.
const INTERRUPT_GRACE_MS = 5000;
const USER_DECLINED_MESSAGE = "User declined";
const USER_CANCELLED_MESSAGE = "User cancelled";

export interface ClaudeCliAdapterOptions {
  command: string;
  commandArguments: readonly string[];
  environment: NodeJS.ProcessEnv;
}

type ClaudeChild = ChildProcessByStdio<Writable, Readable, Readable>;

interface ActiveTurn {
  events: AsyncQueue<AgentEvent>;
  requestApproval: AgentTurnRequest["requestApproval"];
  sawDelta: boolean;
  fallbackText: string;
  // Set when the human cancelled or the signal aborted. The turn then ends as cancelled.
  isCancelRequested: boolean;
}

interface Session {
  child: ClaudeChild;
  stderrTail: string[];
  workingDirectory: string;
}

// The human answers every approval through `requestApproval`. With no turn running,
// an approval request is denied, because nobody is there to ask.
export class ClaudeCliAdapter implements AgentAdapter {
  private session: Session | undefined;
  private activeTurn: ActiveTurn | undefined;
  private nextRequestNumber = 1;
  // Approvals the CLI withdrew. Their late answer must deny and interrupt.
  private readonly withdrawnApprovalIds = new Set<string>();

  constructor(private readonly options: ClaudeCliAdapterOptions) {}

  // The stream ends after exactly one final event: reply_complete, cancelled or error.
  async *run(request: AgentTurnRequest): AsyncGenerator<AgentEvent> {
    if (request.signal.aborted) {
      yield { kind: "cancelled", text: "Turn interrupted" };
      return;
    }
    const session = this.ensureSession(request.workingDirectory);
    const turn: ActiveTurn = {
      events: createAsyncQueue<AgentEvent>(),
      requestApproval: request.requestApproval,
      sawDelta: false,
      fallbackText: "",
      isCancelRequested: false,
    };
    this.activeTurn = turn;

    let graceTimer: NodeJS.Timeout | undefined;
    const interruptTurn = () => {
      turn.isCancelRequested = true;
      this.writeLine(session, {
        type: "control_request",
        request_id: this.nextRequestId(),
        request: { subtype: "interrupt" },
      });
      graceTimer = setTimeout(() => {
        turn.events.push({ kind: "cancelled", text: "Turn interrupted" });
        turn.events.end();
        session.child.kill();
      }, INTERRUPT_GRACE_MS);
    };
    request.signal.addEventListener("abort", interruptTurn, { once: true });

    try {
      session.child.stdin.write(`${buildUserLine(request.messageText)}\n`);
      for await (const event of turn.events) yield event;
    } finally {
      clearTimeout(graceTimer);
      request.signal.removeEventListener("abort", interruptTurn);
      this.activeTurn = undefined;
    }
  }

  async readStatus(): Promise<AgentStatus> {
    return { mode: "cli", isSessionOpen: this.session !== undefined };
  }

  close(): void {
    this.session?.child.kill();
    this.session = undefined;
  }

  // Started on the first turn and kept, so Claude keeps the conversation context.
  // A turn for another repository starts a new session there.
  private ensureSession(workingDirectory: string): Session {
    if (this.session?.workingDirectory === workingDirectory) return this.session;
    this.close();

    const child = spawn(this.options.command, [...this.options.commandArguments], {
      cwd: workingDirectory,
      env: this.options.environment,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const session: Session = { child, stderrTail: [], workingDirectory };
    this.session = session;

    child.stdin.on("error", () => undefined); // the exit handler reports the failure
    createInterface({ input: child.stdout }).on("line", (line) => this.handleLine(session, line));
    createInterface({ input: child.stderr }).on("line", (line) => {
      session.stderrTail.push(line);
      if (session.stderrTail.length > STDERR_LINES_KEPT) session.stderrTail.shift();
    });
    child.on("error", (error) => this.handleExit(session, error.message));
    child.on("exit", (code, signal) =>
      this.handleExit(session, `Claude exited (${code ?? signal})`),
    );
    return session;
  }

  private handleExit(session: Session, reason: string): void {
    if (this.session === session) this.session = undefined;
    const turn = this.activeTurn;
    if (!turn) return;
    const stderrText = session.stderrTail.join("\n");
    turn.events.push({ kind: "error", text: stderrText ? `${reason}: ${stderrText}` : reason });
    turn.events.end();
  }

  private handleLine(session: Session, line: string): void {
    const message = parseJsonLine(line);
    if (!message) return;

    if (message.type === "control_request") {
      void this.answerControlRequest(session, message);
    } else if (message.type === "control_cancel_request") {
      if (typeof message.request_id === "string") this.withdrawnApprovalIds.add(message.request_id);
    } else {
      this.collectTurnOutput(message);
    }
  }

  private collectTurnOutput(message: JsonObject): void {
    const turn = this.activeTurn;
    if (!turn) return;

    const delta = readTextDelta(message);
    if (delta !== undefined) {
      turn.sawDelta = true;
      turn.events.push({ kind: "reply_delta", text: delta });
      return;
    }
    const assistantText = readAssistantText(message);
    if (assistantText) turn.fallbackText += assistantText;

    const result = readResult(message);
    if (!result) return;
    if (turn.isCancelRequested) {
      turn.events.push({ kind: "cancelled", text: "Turn interrupted" });
    } else if (result.isFailure) {
      turn.events.push({ kind: "error", text: result.text });
    } else {
      const fallback = turn.fallbackText || result.text;
      if (!turn.sawDelta && fallback) turn.events.push({ kind: "reply_delta", text: fallback });
      turn.events.push({ kind: "reply_complete", text: "" });
    }
    turn.events.end();
  }

  private async answerControlRequest(session: Session, message: JsonObject): Promise<void> {
    const requestId = message.request_id;
    const request = message.request;
    if (typeof requestId !== "string" || !isRecord(request)) return;

    if (request.subtype !== "can_use_tool") {
      // Includes request_user_dialog. An error reply keeps Claude from waiting forever.
      this.writeLine(session, {
        type: "control_response",
        response: { subtype: "error", request_id: requestId, error: `Unsupported request: ${String(request.subtype)}` },
      });
      return;
    }

    const originalInput = isRecord(request.input) ? request.input : {};
    const decision = await this.askHuman(request);
    const isWithdrawn = this.withdrawnApprovalIds.delete(requestId);
    // No updatedPermissions on purpose: it would create permanent allow rules.
    const reply =
      decision === "accept" && !isWithdrawn
        ? { behavior: "allow", updatedInput: originalInput }
        : decision === "decline" && !isWithdrawn
          ? { behavior: "deny", message: USER_DECLINED_MESSAGE, interrupt: false }
          : { behavior: "deny", message: USER_CANCELLED_MESSAGE, interrupt: true };

    if (reply.behavior === "deny" && reply.interrupt && this.activeTurn) {
      this.activeTurn.isCancelRequested = true;
    }
    this.writeLine(session, {
      type: "control_response",
      response: { subtype: "success", request_id: requestId, response: reply },
    });
  }

  private async askHuman(request: JsonObject): Promise<ApprovalDecision> {
    const turn = this.activeTurn;
    if (!turn) return "decline";
    try {
      return await turn.requestApproval(describeApproval(request));
    } catch {
      return "cancel";
    }
  }

  private writeLine(session: Session, message: JsonObject): void {
    session.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private nextRequestId(): string {
    return `cross-agent-mcp-bridge:${this.nextRequestNumber++}`;
  }
}

function describeApproval(request: JsonObject): ApprovalRequest {
  const toolName = typeof request.tool_name === "string" ? request.tool_name : "a tool";
  const input = isRecord(request.input) ? request.input : {};
  const detailLines: string[] = [];
  if (typeof request.title === "string") detailLines.push(request.title);
  if (typeof request.description === "string") detailLines.push(request.description);

  if (FILE_CHANGE_TOOLS.includes(toolName)) {
    const filePath = readFirstString(input, ["file_path", "notebook_path", "path"]);
    if (filePath) detailLines.push(`file: ${filePath}`);
    return { kind: "file-change", summary: `Claude wants to change files (${toolName})`, detailLines };
  }

  const command = typeof input.command === "string" ? input.command : undefined;
  if (command) detailLines.push(`command: ${command}`);
  else detailLines.push(`input: ${JSON.stringify(input).slice(0, DETAIL_TEXT_LIMIT)}`);
  return {
    kind: "command",
    summary: command ? `Claude wants to run: ${command}` : `Claude wants to use ${toolName}`,
    detailLines,
  };
}

function readFirstString(fields: JsonObject, names: string[]): string | undefined {
  for (const name of names) {
    const value = fields[name];
    if (typeof value === "string") return value;
  }
  return undefined;
}
