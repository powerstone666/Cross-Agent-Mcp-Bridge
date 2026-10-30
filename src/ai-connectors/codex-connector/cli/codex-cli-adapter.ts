// Sends relay turns to Codex through its own app-server child process and its own thread.
// Approval requests from Codex are passed to the configured prompt.
import type {
  AgentAdapter,
  AgentEvent,
  AgentStatus,
  AgentTurnRequest,
  ApprovalDecision,
  ApprovalRequest,
} from "../../../bridge/types/agent-adapter.js";
import { CLIENT_NAME, CLIENT_VERSION } from "../../../bridge/bridge-config.js";
import {
} from "../codex-config.js";
import { createAsyncQueue } from "../../../bridge/utils/create-async-queue.js";
import { isRecord } from "../../../bridge/utils/is-record.js";
import { CodexRpcClient } from "./codex-rpc-client.js";

// Server requests where Codex asks the human. We answer with {decision}. We handle no others.
const COMMAND_APPROVAL_METHOD = "item/commandExecution/requestApproval";
const FILE_CHANGE_APPROVAL_METHOD = "item/fileChange/requestApproval";

export interface CodexCliAdapterOptions {
  command: string;
  commandArguments: string[];
  environment: NodeJS.ProcessEnv;
  // null means "use the Codex default" from the user's own settings.
  approvalPolicy: string | null;
  sandboxMode: string | null;
}

// One app-server process and its thread, reused so Codex keeps the conversation context.
interface ThreadSession {
  client: CodexRpcClient;
  threadId: string;
  workingDirectory: string;
}

// Its thread is not the one shown in the IDE. Approval requests that Codex sends
// during a turn go to the prompt. Requests outside a turn are declined.
export class CodexCliAdapter implements AgentAdapter {
  private session: ThreadSession | undefined;
  private requestApproval:
    | ((request: ApprovalRequest) => Promise<ApprovalDecision>)
    | undefined;

  constructor(private readonly options: CodexCliAdapterOptions) {}

  // The stream ends after exactly one final event: reply_complete, cancelled or error.
  async *run(request: AgentTurnRequest): AsyncGenerator<AgentEvent> {
    const { client, threadId } = await this.ensureSession(
      request.workingDirectory,
    );
    const events = createAsyncQueue<AgentEvent>();
    let turnId: string | undefined;
    let isInterruptRequested = false;

    // The user can cancel before turn/start answers, and a turn cannot be interrupted
    // without its id, so remember the request and send it once the id arrives.
    const interruptTurn = () => {
      if (!turnId) {
        isInterruptRequested = true;
        return;
      }
      client.request("turn/interrupt", { threadId, turnId }).catch(() => {
        // the turn may already be over
      });
    };

    // Added before turn/start so no early delta or turn/completed is lost.
    // The thread check keeps other threads' messages out of this reply.
    const stopListening = client.onNotification(({ method, params }) => {
      if (!isRecord(params) || params.threadId !== threadId) return;
      if (method === "item/agentMessage/delta") {
        if (typeof params.delta === "string") {
          events.push({ kind: "reply_delta", text: params.delta });
        }
      } else if (method === "turn/completed") {
        events.push(toTerminalEvent(params.turn));
        events.end();
      }
    });
    // If the server stops mid-turn, end with an error instead of waiting forever.
    const stopWatchingExit = client.onExit((error) => {
      events.push({ kind: "error", text: error.message });
      events.end();
    });

    // Approval requests do not carry our turn, so keep the ask-human function in a field.
    this.requestApproval = request.requestApproval;
    request.signal.addEventListener("abort", interruptTurn, { once: true });

    try {
      const response = await client.request("turn/start", {
        threadId,
        input: [{ type: "text", text: request.messageText, text_elements: [] }],
      });
      turnId = readTurnId(response);
      // Send the interrupt requested before the turn id was known.
      if (isInterruptRequested || request.signal.aborted) interruptTurn();

      for await (const event of events) yield event;
    } finally {
      stopListening();
      stopWatchingExit();
      request.signal.removeEventListener("abort", interruptTurn);
      this.requestApproval = undefined;
    }
  }

  async readStatus(): Promise<AgentStatus> {
    return { mode: "cli", isSessionOpen: this.session !== undefined };
  }

  close(): void {
    this.session?.client.close();
    this.session = undefined;
  }

  // Started on the first turn and kept, so the thread lasts across turns.
  // A turn for another repository starts a new thread there.
  private async ensureSession(workingDirectory: string): Promise<ThreadSession> {
    if (this.session?.workingDirectory === workingDirectory) return this.session;
    this.close();

    const client = new CodexRpcClient({
      command: this.options.command,
      commandArguments: this.options.commandArguments,
      environment: this.options.environment,
    });
    client.setServerRequestHandler((serverRequest) =>
      this.answerServerRequest(serverRequest),
    );
    // Forget a stopped session so the next turn starts a new server.
    client.onExit(() => {
      if (this.session?.client === client) this.session = undefined;
    });
    client.start();

    // Required order: initialize, then the `initialized` notification, then other requests.
    try {
      await client.request("initialize", {
        clientInfo: { name: CLIENT_NAME, version: CLIENT_VERSION },
      });
      client.notify("initialized");
      // Only settings the user chose are sent; the rest comes from the user's own Codex defaults.
      const threadResponse = await client.request("thread/start", {
        cwd: workingDirectory,
        ...(this.options.approvalPolicy && { approvalPolicy: this.options.approvalPolicy }),
        ...(this.options.sandboxMode && { sandbox: this.options.sandboxMode }),
        serviceName: CLIENT_NAME,
      });
      this.session = { client, threadId: readThreadId(threadResponse), workingDirectory };
      return this.session;
    } catch (error) {
      // Do not leave a half-started server running.
      client.close();
      throw error;
    }
  }

  // Only the two approval requests are supported.
  private async answerServerRequest({
    method,
    params,
  }: {
    method: string;
    params: unknown;
  }): Promise<unknown> {
    if (
      method !== COMMAND_APPROVAL_METHOD &&
      method !== FILE_CHANGE_APPROVAL_METHOD
    ) {
      // The client turns this into an error reply, so Codex does not wait forever.
      throw new Error(`Unsupported server request: ${method}`);
    }

    // No turn can ask the human, so decline. Accepting here would be an automatic approval.
    if (!this.requestApproval) return { decision: "decline" };

    // `acceptForSession` is never offered, so one approval never covers later actions.
    const decision = await this.requestApproval(
      describeApproval({ method, params }),
    );
    return { decision };
  }
}

// Server parameters may be missing or mistyped, so such fields are skipped.
function describeApproval({
  method,
  params,
}: {
  method: string;
  params: unknown;
}): ApprovalRequest {
  const fields = isRecord(params) ? params : {};
  const detailLines: string[] = [];
  if (typeof fields.reason === "string") {
    detailLines.push(`reason: ${fields.reason}`);
  }

  if (method === COMMAND_APPROVAL_METHOD) {
    if (typeof fields.cwd === "string") detailLines.push(`cwd: ${fields.cwd}`);
    const command =
      typeof fields.command === "string" ? fields.command : "(unknown command)";
    return {
      kind: "command",
      summary: `Codex wants to run: ${command}`,
      detailLines,
    };
  }

  if (typeof fields.grantRoot === "string") {
    detailLines.push(`write access to: ${fields.grantRoot}`);
  }
  return {
    kind: "file-change",
    summary: "Codex wants to change files",
    detailLines,
  };
}

// Any status other than interrupted or failed counts as completed.
function toTerminalEvent(turn: unknown): AgentEvent {
  const fields = isRecord(turn) ? turn : {};
  if (fields.status === "interrupted") {
    return { kind: "cancelled", text: "Turn interrupted" };
  }
  if (fields.status === "failed") {
    const errorMessage =
      isRecord(fields.error) && typeof fields.error.message === "string"
        ? fields.error.message
        : "Codex turn failed";
    return { kind: "error", text: errorMessage };
  }
  return { kind: "reply_complete", text: "" };
}

function readThreadId(response: unknown): string {
  if (isRecord(response) && isRecord(response.thread)) {
    const { id } = response.thread;
    if (typeof id === "string") return id;
  }
  throw new Error("Codex thread/start response had no thread id");
}

function readTurnId(response: unknown): string {
  if (isRecord(response) && isRecord(response.turn)) {
    const { id } = response.turn;
    if (typeof id === "string") return id;
  }
  throw new Error("Codex turn/start response had no turn id");
}
