// Messages the relay and the wrapper exchange over the socket, one JSON object per line.
// Any local process of the same user can write to the socket, so parse every field.
import { isRecord } from "../../../bridge/utils/is-record.js";

const MAX_TEXT_LENGTH = 200_000;
const MAX_REQUEST_ID_LENGTH = 200;

// Relay to wrapper. The wrapper echoes `requestId` in every reply.
export type IdeClientMessage =
  | { type: "send"; requestId: string; text: string }
  | { type: "interrupt"; requestId: string };

// Valid JSON that is not a valid request. The wrapper answers it with an error.
export interface IdeInvalidMessage {
  type: "invalid";
  requestId: string | undefined;
  reason: string;
}

// Wrapper to relay. `completed.status` is completed, interrupted or failed.
export type IdeServerMessage =
  | { type: "accepted"; requestId: string }
  | { type: "delta"; requestId: string; text: string }
  | { type: "completed"; requestId: string; status: string; errorMessage: string | null }
  | { type: "error"; requestId: string; message: string };

// Returns undefined for lines that are not JSON objects.
export function parseIdeClientMessage(
  line: string,
): IdeClientMessage | IdeInvalidMessage | undefined {
  const parsed = parseObject(line);
  if (!parsed) return undefined;

  const { requestId } = parsed;
  if (typeof requestId !== "string" || requestId === "" || requestId.length > MAX_REQUEST_ID_LENGTH) {
    return { type: "invalid", requestId: undefined, reason: "requestId must be a short non-empty string" };
  }
  if (parsed.type === "interrupt") return { type: "interrupt", requestId };

  if (parsed.type === "send") {
    const { text } = parsed;
    if (typeof text !== "string" || text === "" || text.length > MAX_TEXT_LENGTH) {
      return { type: "invalid", requestId, reason: "text must be a non-empty string within the size limit" };
    }
    return { type: "send", requestId, text };
  }
  return { type: "invalid", requestId, reason: "unknown message type" };
}

// Returns undefined for anything that is not a well-formed wrapper message.
export function parseIdeServerMessage(line: string): IdeServerMessage | undefined {
  const parsed = parseObject(line);
  if (!parsed || typeof parsed.requestId !== "string") return undefined;
  const { requestId } = parsed;

  if (parsed.type === "accepted") return { type: "accepted", requestId };
  if (parsed.type === "delta" && typeof parsed.text === "string") {
    return { type: "delta", requestId, text: parsed.text };
  }
  if (parsed.type === "error" && typeof parsed.message === "string") {
    return { type: "error", requestId, message: parsed.message };
  }
  if (parsed.type === "completed" && typeof parsed.status === "string") {
    return {
      type: "completed",
      requestId,
      status: parsed.status,
      errorMessage: typeof parsed.errorMessage === "string" ? parsed.errorMessage : null,
    };
  }
  return undefined;
}

function parseObject(line: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(line);
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}
