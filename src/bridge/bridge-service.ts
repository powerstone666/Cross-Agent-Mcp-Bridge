// The bridge: sends an "@agent message" to that agent's adapter, logs every step and
// passes the events back. Never name a specific agent here.

import type {
  AgentAdapter,
  AgentEvent,
  ApprovalDecision,
  ApprovalPrompter,
  ApprovalRequest,
} from "./types/agent-adapter.js";
import type { RelayEventKind } from "./types/relay-event.js";
import { CLIENT_NAME, HUMAN_NAME } from "./bridge-config.js";
import { createRequestToken } from "./utils/create-request-token.js";
import { parseMention } from "./utils/parse-mention.js";
import type { EventLogService } from "./event-log-service.js";

interface RelayEventSink {
  append?(event: import("./types/relay-event.js").RelayEvent): Promise<void>;
  appendRelayEvent?(event: import("./types/relay-event.js").RelayEvent): Promise<void>;
}

// Passed in so tests can use fakes.
export interface BridgeServiceOptions {
  adapters: ReadonlyMap<string, AgentAdapter>;
  eventLog: EventLogService;
  approvalPrompter: ApprovalPrompter;
  // All log lines of one conversation go to one file.
  conversationId: string;
  workingDirectory: string;
  agentRoom?: RelayEventSink;
}

// One event to log. `record` below adds the conversation id and request token.
interface LoggedEvent {
  kind: RelayEventKind;
  from: string;
  to: string;
  text: string;
}

interface HandleUserInputRequest {
  inputText: string;
  signal: AbortSignal;
  requireHumanApproval?: boolean;
  // Called once the message is handed to the agent, after any earlier turn of that agent ends.
  onStarted?: () => void;
  // The repository the agent works in, such as a room's target repository. Defaults to the relay's.
  workingDirectory?: string;
}

type ActivityPhase = "idle" | "working" | "waiting_approval";

// `agentName` and `phase` describe the most recently started turn; `agents` lists every running one.
export interface LiveActivity {
  agentName: string | null;
  phase: ActivityPhase;
  agents: Record<string, ActivityPhase>;
}

// Runs one turn per agent at a time and never resends a message after a failure. Different agents
// run in parallel. An agent failure becomes an `error` event, not a throw. The caller cancels
// through `signal`.
export class BridgeService {
  // Keep concurrent sends to one agent in arrival order so its turns cannot mix their replies.
  private readonly turnQueueByAgent = new Map<string, Promise<void>>();
  private readonly phaseByAgent = new Map<string, ActivityPhase>();
  private readonly activityListeners = new Set<(activity: LiveActivity) => void>();

  constructor(private readonly options: BridgeServiceOptions) {}

  getLiveActivity(): LiveActivity {
    const agentName = [...this.phaseByAgent.keys()].at(-1) ?? null;
    return {
      agentName,
      phase: (agentName && this.phaseByAgent.get(agentName)) || "idle",
      agents: Object.fromEntries(this.phaseByAgent),
    };
  }

  subscribeActivity(listener: (activity: LiveActivity) => void): () => void {
    this.activityListeners.add(listener);
    return () => this.activityListeners.delete(listener);
  }

  // Yields each event as it arrives. Problems found before the agent starts are `error` events.
  async *handleUserInput({
    inputText,
    signal,
    requireHumanApproval = false,
    onStarted,
    workingDirectory = this.options.workingDirectory,
  }: HandleUserInputRequest): AsyncGenerator<AgentEvent> {
    const mention = parseMention({ inputText });
    if (!mention) {
      // First registered agent as the example, so this file names none.
      const exampleAgent = [...this.options.adapters.keys()][0] ?? "agent";
      yield errorEvent(`Start your message with an agent mention, e.g. @${exampleAgent} hello`);
      return;
    }

    const adapter = this.options.adapters.get(mention.agentName);
    if (!adapter) {
      const availableAgents = [...this.options.adapters.keys()].map((name) => `@${name}`).join(", ");
      yield errorEvent(`Unknown agent @${mention.agentName}. Available: ${availableAgents}`);
      return;
    }

    const agentName = mention.agentName;
    let releaseQueue!: () => void;
    const previousTurn = this.turnQueueByAgent.get(agentName) ?? Promise.resolve();
    const thisTurn = new Promise<void>((resolve) => { releaseQueue = resolve; });
    this.turnQueueByAgent.set(agentName, thisTurn);
    const releaseTurn = () => {
      if (this.turnQueueByAgent.get(agentName) === thisTurn) this.turnQueueByAgent.delete(agentName);
      releaseQueue();
    };
    await previousTurn;
    if (signal.aborted) {
      releaseTurn();
      yield { kind: "cancelled", text: "Turn cancelled before delivery" };
      return;
    }

    // Same token on every log line of this turn, so the lines can be found together.
    const requestToken = createRequestToken();
    this.setPhase(agentName, "working");
    const record = async (event: LoggedEvent) => {
      const storedEvent = await this.options.eventLog.append({
        conversationId: this.options.conversationId,
        requestToken,
        ...event,
      });
      if (this.options.agentRoom?.appendRelayEvent) await this.options.agentRoom.appendRelayEvent(storedEvent);
      else await this.options.agentRoom?.append?.(storedEvent);
    };

    try {
      // Logged before the agent sees it, so a crash still leaves what was sent.
      await record({
        kind: "user_message",
        from: HUMAN_NAME,
        to: agentName,
        text: mention.messageText,
      });
      onStarted?.();

      const turn = adapter.run({
        messageText: mention.messageText,
        workingDirectory,
        signal,
        // Logs both the request and the answer, so the log shows who allowed what.
        requestApproval: async (approvalRequest) => {
          await record({
            kind: "approval_requested",
            from: agentName,
            to: requireHumanApproval ? HUMAN_NAME : CLIENT_NAME,
            text: summarize(approvalRequest),
          });
          let decision: ApprovalDecision;
          if (signal.aborted) decision = "cancel";
          else if (requireHumanApproval) {
            this.setPhase(agentName, "waiting_approval");
            decision = await this.askHuman({ approvalRequest, signal });
            this.setPhase(agentName, "working");
          } else decision = "accept";
          await record({
            kind: "approval_decided",
            from: requireHumanApproval ? HUMAN_NAME : CLIENT_NAME,
            to: agentName,
            text: decision,
          });
          return decision;
        },
      });

      // Log before yield, so the record exists even if the caller stops reading.
      for await (const event of turn) {
        await record({
          kind: event.kind,
          from: agentName,
          to: HUMAN_NAME,
          text: event.text,
        });
        yield event;
      }
    } catch (error) {
      // Never resend: the agent may already have acted on the message.
      const text = error instanceof Error ? error.message : String(error);
      await record({ kind: "error", from: agentName, to: HUMAN_NAME, text });
      yield errorEvent(text);
    } finally {
      this.setPhase(agentName, "idle");
      releaseTurn();
    }
  }

  private setPhase(agentName: string, phase: ActivityPhase): void {
    if (phase === "idle") this.phaseByAgent.delete(agentName);
    else this.phaseByAgent.set(agentName, phase);
    this.publishActivity();
  }

  private publishActivity(): void {
    const activity = this.getLiveActivity();
    for (const listener of this.activityListeners) {
      try { listener(activity); } catch { /* Status listeners cannot interrupt an agent turn. */ }
    }
  }

  private async askHuman({
    approvalRequest,
    signal,
  }: {
    approvalRequest: ApprovalRequest;
    signal: AbortSignal;
  }): Promise<ApprovalDecision> {
    try {
      return await this.options.approvalPrompter.requestApproval(
        approvalRequest,
        signal,
      );
    } catch (error) {
      // Aborted means the human walked away: cancel, never accept. When in doubt, stop.
      if (signal.aborted) return "cancel";
      throw error;
    }
  }
}

function errorEvent(text: string): AgentEvent {
  return { kind: "error", text };
}

// Approval request as log text: the summary, then the detail lines.
function summarize(approvalRequest: ApprovalRequest): string {
  return [approvalRequest.summary, ...approvalRequest.detailLines].join("\n");
}
