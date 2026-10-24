// Reads the stream-json lines Claude prints. Every field is checked, because it is untrusted.
import { isRecord } from "../../bridge/utils/is-record.js";

export type JsonObject = Record<string, unknown>;

export function parseJsonLine(line: string): JsonObject | undefined {
  try {
    const parsed: unknown = JSON.parse(line);
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

// Messages from a sub-agent carry a parent id. They are not part of the main reply.
function isMainThreadMessage(message: JsonObject): boolean {
  return typeof message.parent_tool_use_id !== "string";
}

export function readTextDelta(message: JsonObject): string | undefined {
  if (message.type !== "stream_event" || !isMainThreadMessage(message)) return undefined;
  const { event } = message;
  if (!isRecord(event) || event.type !== "content_block_delta" || !isRecord(event.delta)) {
    return undefined;
  }
  const { delta } = event;
  return delta.type === "text_delta" && typeof delta.text === "string" ? delta.text : undefined;
}

export function readAssistantText(message: JsonObject): string | undefined {
  if (message.type !== "assistant" || !isMainThreadMessage(message)) return undefined;
  const content = isRecord(message.message) ? message.message.content : undefined;
  if (!Array.isArray(content)) return undefined;
  return content
    .filter((block) => isRecord(block) && block.type === "text" && typeof block.text === "string")
    .map((block) => (block as { text: string }).text)
    .join("");
}

export interface ResultOutcome {
  isFailure: boolean;
  text: string;
}

// Failure means is_error or any subtype other than success. `text` is the result or the subtype.
export function readResult(message: JsonObject): ResultOutcome | undefined {
  if (message.type !== "result") return undefined;
  const subtype = typeof message.subtype === "string" ? message.subtype : "unknown";
  const resultText = typeof message.result === "string" ? message.result : "";
  const isFailure = message.is_error === true || subtype !== "success";
  return { isFailure, text: resultText || (isFailure ? `Claude turn failed (${subtype})` : "") };
}

export function buildUserLine(text: string): string {
  return JSON.stringify({
    type: "user",
    message: { role: "user", content: [{ type: "text", text }] },
  });
}
