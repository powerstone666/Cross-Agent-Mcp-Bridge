// Turns the host's action notifications for one relay turn into relay events.
// Never answer a tool confirmation or an input request. Only the human does that in VS Code.
import type { AgentEvent } from "../../../bridge/types/agent-adapter.js";
import { isRecord } from "../../../bridge/utils/is-record.js";

export const APPROVAL_NOTICE = "[waiting for your approval in VS Code]\n";
export const INPUT_NOTICE = "[waiting for your answer in VS Code]\n";
const BUSY_REJECTION_PATTERN = /busy/i;
const PART_SEPARATOR = "\n\n";

export interface TurnReaderInput {
  clientId: string;
  clientSeq: number;
  turnId: string;
}

export interface TurnStep {
  events: AgentEvent[];
  isAccepted: boolean;
  isFinished: boolean;
}

export interface TurnReader {
  // `notificationParams` is the params object of one `action` notification.
  read(notificationParams: unknown): TurnStep;
}

export function createTurnReader({ clientId, clientSeq, turnId }: TurnReaderInput): TurnReader {
  let isAccepted = false;
  let hasEmittedText = false;
  let isAfterBoundary = false;
  let hasShownApprovalNotice = false;
  let hasShownInputNotice = false;
  const markdownPartIds = new Set<string>();

  const step = (events: AgentEvent[] = [], isFinished = false): TurnStep => ({
    events,
    isAccepted,
    isFinished,
  });
  const text = (content: string): AgentEvent => {
    const separator = hasEmittedText && isAfterBoundary ? PART_SEPARATOR : "";
    hasEmittedText = true;
    isAfterBoundary = false;
    return { kind: "reply_delta", text: separator + content };
  };

  return {
    read(params) {
      if (!isRecord(params) || !isRecord(params.action)) return step();
      const { action, origin } = params;
      const type = action.type;
      const isOurs =
        isRecord(origin) && origin.clientId === clientId && origin.clientSeq === clientSeq;

      if (isOurs && typeof params.rejectionReason === "string") {
        return step([{ kind: "error", text: describeRejection(params.rejectionReason) }], true);
      }
      if (!isAccepted) {
        if (type === "chat/turnStarted" && isOurs && action.turnId === turnId) isAccepted = true;
        return step();
      }
      if (action.turnId !== undefined && action.turnId !== turnId) return step();

      switch (type) {
        case "chat/responsePart": {
          const part = isRecord(action.part) ? action.part : {};
          if (part.kind === "markdown" && typeof part.id === "string") {
            markdownPartIds.add(part.id);
            return step(typeof part.content === "string" && part.content ? [text(part.content)] : []);
          }
          if (part.kind !== "toolCall") return step();
          isAfterBoundary = true;
          const toolCall = isRecord(part.toolCall) ? part.toolCall : {};
          return step(toolCall.status === "pending-confirmation" ? approvalNotice() : []);
        }
        case "chat/delta":
          return step(
            typeof action.partId === "string" &&
              markdownPartIds.has(action.partId) &&
              typeof action.content === "string" &&
              action.content
              ? [text(action.content)]
              : [],
          );
        case "chat/toolCallStart":
          isAfterBoundary = true;
          return step();
        // Without `confirmed` the host waits for the human.
        case "chat/toolCallReady":
          return step(action.confirmed === undefined ? approvalNotice() : []);
        case "chat/inputRequested":
          if (hasShownInputNotice) return step();
          hasShownInputNotice = true;
          return step([{ kind: "reply_delta", text: INPUT_NOTICE }]);
        case "chat/turnComplete":
          return step([{ kind: "reply_complete", text: "" }], true);
        case "chat/turnCancelled":
          return step([{ kind: "cancelled", text: "Turn cancelled in VS Code" }], true);
        case "chat/error":
          return step([{ kind: "error", text: readErrorMessage(action) }], true);
        default:
          return step();
      }
    },
  };

  function approvalNotice(): AgentEvent[] {
    if (hasShownApprovalNotice) return [];
    hasShownApprovalNotice = true;
    return [{ kind: "reply_delta", text: APPROVAL_NOTICE }];
  }
}

function describeRejection(reason: string): string {
  return BUSY_REJECTION_PATTERN.test(reason)
    ? "The Copilot chat is busy with another turn. Try again when it finishes."
    : `VS Code rejected the message: ${reason}`;
}

function readErrorMessage(action: Record<string, unknown>): string {
  const part = isRecord(action.part) ? action.part : {};
  const error = isRecord(part.error) ? part.error : {};
  return typeof error.message === "string" ? error.message : "Copilot turn failed";
}
