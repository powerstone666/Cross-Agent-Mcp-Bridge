// What one event in the log looks like.
// Keep it neutral: it names no agent, only `from` and `to` text fields.

// The agent-side kinds match `AgentEventKind`. The rest record the human side.
export type RelayEventKind =
  | "user_message"
  | "reply_delta"
  | "reply_complete"
  | "approval_requested"
  | "approval_decided"
  | "error"
  | "cancelled";

// One log line. `serverSequence` orders events in a conversation, `requestToken` is shared
// by one turn, and `from` and `to` are "human" or an agent name.
export interface RelayEvent {
  serverSequence: number;
  timestamp: string;
  conversationId: string;
  requestToken: string;
  kind: RelayEventKind;
  from: string;
  to: string;
  text: string;
}

// An event as passed to `append`. The log adds `serverSequence` and `timestamp`.
export type RelayEventInput = Omit<RelayEvent, "serverSequence" | "timestamp">;
