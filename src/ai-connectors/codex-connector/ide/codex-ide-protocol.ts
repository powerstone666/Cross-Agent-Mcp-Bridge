// Messages the relay and wrapper exchange over the socket, one JSON object per line.

import { isRecord } from "../../../bridge/utils/is-record.js";

// Settings for a thread the wrapper starts when the IDE has none open.
export interface NewThreadParams {
  cwd: string;
  // Use the IDE's own workspace folder instead of `cwd` when the wrapper has seen one.
  preferIdeWorkspace: boolean;
  // Left out when the user has not chosen one, so Codex applies the user's own default.
  approvalPolicy?: string;
  approvalsReviewer?: string;
  sandbox?: string;
}

// Relay to wrapper: "send" starts a turn, "interrupt" stops it. The wrapper echoes `requestId`.
export type IdeClientMessage =
  | {
      type: "send";
      requestId: string;
      text: string;
      newThreadParams?: NewThreadParams;
    }
  | { type: "interrupt"; requestId: string };

// Valid JSON that is not a valid request. The wrapper answers it with an error.
export interface IdeInvalidMessage {
  type: "invalid";
  requestId: string | undefined;
  reason: string;
}

// Wrapper to relay. `completed.status` is completed, interrupted or failed.
export type IdeServerMessage =
  | { type: "accepted"; requestId: string; threadId: string; turnId: string }
  | { type: "delta"; requestId: string; text: string }
  | {
      type: "completed";
      requestId: string;
      status: string;
      errorMessage: string | null;
    }
  | { type: "error"; requestId: string; message: string };

// Any local process of the same user can write to the socket, so every field is checked here.
export function parseIdeClientMessage(
  line: string,
): IdeClientMessage | IdeInvalidMessage | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (!isRecord(parsed)) return undefined;

  const requestId = typeof parsed.requestId === "string" ? parsed.requestId : undefined;
  if (requestId === undefined) {
    return { type: "invalid", requestId, reason: "requestId must be a string" };
  }

  if (parsed.type === "interrupt") return { type: "interrupt", requestId };

  if (parsed.type === "send") {
    if (typeof parsed.text !== "string" || parsed.text === "") {
      return { type: "invalid", requestId, reason: "text must be a non-empty string" };
    }
    if (parsed.newThreadParams === undefined) {
      return { type: "send", requestId, text: parsed.text };
    }
    const newThreadParams = parseNewThreadParams(parsed.newThreadParams);
    if (!newThreadParams) {
      return { type: "invalid", requestId, reason: "newThreadParams has an invalid value" };
    }
    return { type: "send", requestId, text: parsed.text, newThreadParams };
  }

  return { type: "invalid", requestId, reason: "unknown message type" };
}

// Returns undefined when settings have the wrong shape.
function parseNewThreadParams(value: unknown): NewThreadParams | undefined {
  if (!isRecord(value)) return undefined;
  if (
    typeof value.cwd !== "string" ||
    (value.approvalPolicy !== undefined && typeof value.approvalPolicy !== "string") ||
    (value.sandbox !== undefined && typeof value.sandbox !== "string") ||
    (value.approvalsReviewer !== undefined && typeof value.approvalsReviewer !== "string")
  ) {
    return undefined;
  }
  return {
    cwd: value.cwd,
    preferIdeWorkspace: value.preferIdeWorkspace === true,
    ...(value.approvalPolicy !== undefined && { approvalPolicy: value.approvalPolicy as string }),
    ...(value.approvalsReviewer !== undefined && { approvalsReviewer: value.approvalsReviewer as string }),
    ...(value.sandbox !== undefined && { sandbox: value.sandbox as string }),
  };
}
