// Sends relay turns to Gemini through `gemini --experimental-acp` and one ACP session.
// Never auto-approve and never pick an allow_always or reject_always option.
import type {
  AgentAdapter,
  AgentEvent,
  AgentStatus,
  AgentTurnRequest,
  ApprovalDecision,
  ApprovalRequest,
} from "../../../bridge/types/agent-adapter.js";
import { CLIENT_NAME, CLIENT_VERSION } from "../../../bridge/bridge-config.js";
import { createAsyncQueue } from "../../../bridge/utils/create-async-queue.js";
import { isRecord } from "../../../bridge/utils/is-record.js";
import {
  AcpMethodNotFoundError,
  GeminiAcpClient,
  type AcpMessage,
} from "./gemini-acp-client.js";

const ACP_PROTOCOL_VERSION = 1;
const PERMISSION_METHOD = "session/request_permission";
const PREFERRED_AUTH_METHOD_ID = "oauth-personal";
const FILE_CHANGE_TOOL_KINDS = ["edit", "delete", "move"];

export interface GeminiCliAdapterOptions {
  command: string;
  commandArguments: string[];
  environment: NodeJS.ProcessEnv;
}

interface AcpSession {
  client: GeminiAcpClient;
  sessionId: string;
}

interface PermissionOption {
  optionId: string;
  kind: string;
}

// If Gemini asks while no turn is running, the answer is "cancelled": there is no human to ask.
export class GeminiCliAdapter implements AgentAdapter {
  private session: AcpSession | undefined;
  private requestApproval:
    | ((request: ApprovalRequest) => Promise<ApprovalDecision>)
    | undefined;

  constructor(private readonly options: GeminiCliAdapterOptions) {}

  // The stream ends after exactly one final event: reply_complete, cancelled or error.
  async *run(request: AgentTurnRequest): AsyncGenerator<AgentEvent> {
    const { client, sessionId } = await this.ensureSession(
      request.workingDirectory,
    );
    const events = createAsyncQueue<AgentEvent>();
    const cancelTurn = () => client.notify("session/cancel", { sessionId });

    const stopListening = client.onNotification((message) => {
      const text = readReplyText({ message, sessionId });
      if (text) events.push({ kind: "reply_delta", text });
    });
    // If Gemini stops mid-turn, end with an error instead of waiting forever.
    const stopWatchingExit = client.onExit((error) => {
      events.push({ kind: "error", text: error.message });
      events.end();
    });

    this.requestApproval = async (approvalRequest) => {
      const decision = await request.requestApproval(approvalRequest);
      if (decision === "cancel") cancelTurn();
      return decision;
    };
    request.signal.addEventListener("abort", cancelTurn, { once: true });

    try {
      client
        .request("session/prompt", {
          sessionId,
          prompt: [{ type: "text", text: request.messageText }],
        })
        .then(
          (response) => {
            events.push(toTerminalEvent(response));
            events.end();
          },
          (error: Error) => {
            events.push({ kind: "error", text: error.message });
            events.end();
          },
        );
      // The prompt is already written, so Gemini sees the cancel after it.
      if (request.signal.aborted) cancelTurn();

      for await (const event of events) yield event;
    } finally {
      stopListening();
      stopWatchingExit();
      request.signal.removeEventListener("abort", cancelTurn);
      this.requestApproval = undefined;
    }
  }

  // The binary check is the module's job, so a running adapter always has one.
  async readStatus(): Promise<AgentStatus> {
    return {
      mode: "cli",
      binaryFound: true,
      isSessionOpen: this.session !== undefined,
    };
  }

  close(): void {
    this.session?.client.close();
    this.session = undefined;
  }

  // Started on the first turn and kept, so Gemini keeps the conversation context.
  private async ensureSession(workingDirectory: string): Promise<AcpSession> {
    if (this.session) return this.session;

    const client = new GeminiAcpClient({ ...this.options, workingDirectory });
    client.setAgentRequestHandler((agentRequest) =>
      this.answerAgentRequest(agentRequest),
    );
    // Forget a stopped session so the next turn starts a new process.
    client.onExit(() => {
      if (this.session?.client === client) this.session = undefined;
    });
    client.start();

    try {
      const initializeResult = await client.request("initialize", {
        protocolVersion: ACP_PROTOCOL_VERSION,
        clientCapabilities: {
          fs: { readTextFile: false, writeTextFile: false },
          terminal: false,
        },
        clientInfo: { name: CLIENT_NAME, version: CLIENT_VERSION },
      });
      await authenticateIfNeeded({ client, initializeResult });
      const sessionResult = await client.request("session/new", {
        cwd: workingDirectory,
        mcpServers: [],
      });
      this.session = { client, sessionId: readSessionId(sessionResult) };
      return this.session;
    } catch (error) {
      client.close();
      throw error;
    }
  }

  private async answerAgentRequest({
    method,
    params,
  }: AcpMessage): Promise<unknown> {
    // fs/* and terminal/* are not offered in our capabilities.
    if (method !== PERMISSION_METHOD) throw new AcpMethodNotFoundError(method);
    if (!this.requestApproval) return CANCELLED_OUTCOME;

    const fields = isRecord(params) ? params : {};
    const decision = await this.requestApproval(describeApproval(fields));
    return toPermissionOutcome({ decision, options: readOptions(fields.options) });
  }
}

const CANCELLED_OUTCOME = { outcome: { outcome: "cancelled" } };

// Maps the human's decision to a once-only option. No match means cancelled, never a guess.
function toPermissionOutcome({
  decision,
  options,
}: {
  decision: ApprovalDecision;
  options: PermissionOption[];
}) {
  const wantedKind = { accept: "allow_once", decline: "reject_once" }[
    decision as "accept" | "decline"
  ];
  const option = options.find((candidate) => candidate.kind === wantedKind);
  if (!option) return CANCELLED_OUTCOME;
  return { outcome: { outcome: "selected", optionId: option.optionId } };
}

function readOptions(value: unknown): PermissionOption[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((option) =>
    isRecord(option) &&
    typeof option.optionId === "string" &&
    typeof option.kind === "string"
      ? [{ optionId: option.optionId, kind: option.kind }]
      : [],
  );
}

// Fields may be missing or mistyped, so such fields are skipped.
function describeApproval(params: Record<string, unknown>): ApprovalRequest {
  const toolCall = isRecord(params.toolCall) ? params.toolCall : {};
  const title =
    typeof toolCall.title === "string" ? toolCall.title : "an action";
  const detailLines: string[] = [];
  if (Array.isArray(toolCall.locations)) {
    for (const location of toolCall.locations) {
      if (isRecord(location) && typeof location.path === "string") {
        detailLines.push(`path: ${location.path}`);
      }
    }
  }

  detailLines.push(...describeContent(toolCall.content));

  const isFileChange =
    typeof toolCall.kind === "string" &&
    FILE_CHANGE_TOOL_KINDS.includes(toolCall.kind);
  return {
    kind: isFileChange ? "file-change" : "command",
    summary: `Gemini wants to: ${title}`,
    detailLines,
  };
}

function readReplyText({
  message,
  sessionId,
}: {
  message: AcpMessage;
  sessionId: string;
}): string | undefined {
  const { method, params } = message;
  if (method !== "session/update" || !isRecord(params)) return undefined;
  if (params.sessionId !== sessionId || !isRecord(params.update)) return undefined;

  const { sessionUpdate, content } = params.update;
  if (sessionUpdate !== "agent_message_chunk" || !isRecord(content)) return undefined;
  return content.type === "text" && typeof content.text === "string"
    ? content.text
    : undefined;
}

function toTerminalEvent(response: unknown): AgentEvent {
  const stopReason = isRecord(response) ? response.stopReason : undefined;
  if (stopReason === "cancelled") {
    return { kind: "cancelled", text: "Turn cancelled" };
  }
  if (stopReason === "refusal") {
    return { kind: "error", text: "Gemini refused to answer" };
  }
  if (stopReason === "max_tokens" || stopReason === "max_turn_requests") {
    return { kind: "reply_complete", text: `Stopped early: ${stopReason}` };
  }
  return { kind: "reply_complete", text: "" };
}

// Uses a cached login only. API-key methods would need a secret we do not pass on.
async function authenticateIfNeeded({
  client,
  initializeResult,
}: {
  client: GeminiAcpClient;
  initializeResult: unknown;
}): Promise<void> {
  const methodIds = readAuthMethodIds(initializeResult);
  const methodId = methodIds.includes(PREFERRED_AUTH_METHOD_ID)
    ? PREFERRED_AUTH_METHOD_ID
    : methodIds.find((id) => !/key/i.test(id));
  if (!methodId) return;

  try {
    await client.request("authenticate", { methodId });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Gemini login failed (${detail}). Log in with the Gemini CLI first: run \`gemini\` once.`,
    );
  }
}

function readAuthMethodIds(initializeResult: unknown): string[] {
  if (!isRecord(initializeResult) || !Array.isArray(initializeResult.authMethods)) {
    return [];
  }
  return initializeResult.authMethods.flatMap((method) =>
    isRecord(method) && typeof method.id === "string" ? [method.id] : [],
  );
}

function readSessionId(response: unknown): string {
  if (isRecord(response) && typeof response.sessionId === "string") {
    return response.sessionId;
  }
  throw new Error("Gemini session/new response had no session id");
}

const MAX_DETAIL_LINES = 6;
const MAX_DETAIL_CHARACTERS = 200;

// Shows what the tool will do (command text or the new file text) so the human can judge.
function describeContent(content: unknown): string[] {
  if (!Array.isArray(content)) return [];
  const lines: string[] = [];
  for (const item of content) {
    if (!isRecord(item)) continue;
    const text =
      item.type === "diff" && typeof item.newText === "string"
        ? `new text for ${String(item.path ?? "a file")}: ${item.newText}`
        : isRecord(item.content) && typeof item.content.text === "string"
          ? item.content.text
          : undefined;
    if (text) lines.push(text.replace(/\s+/g, " ").slice(0, MAX_DETAIL_CHARACTERS));
  }
  return lines.slice(0, MAX_DETAIL_LINES);
}

