// Types shared by the bridge and every adapter, including approvals.
// Never add agent-specific fields here. That is why `AgentStatus` has no fixed shape.

export type ApprovalKind = "command" | "file-change";

// "cancel" denies the request and also stops the whole turn.
export type ApprovalDecision = "accept" | "decline" | "cancel";

// What the human sees: a one-line summary and detail lines, such as the command to run.
export interface ApprovalRequest {
  kind: ApprovalKind;
  summary: string;
  detailLines: string[];
}

// `reply_delta` is one piece of the answer. `reply_complete` means it is finished.
export type AgentEventKind =
  | "reply_delta"
  | "reply_complete"
  | "error"
  | "cancelled";

export interface AgentEvent {
  kind: AgentEventKind;
  text: string;
}

// An adapter must stop when `signal` aborts, and must call `requestApproval` before any
// command or file change.
export interface AgentTurnRequest {
  messageText: string;
  workingDirectory: string;
  signal: AbortSignal;
  requestApproval(request: ApprovalRequest): Promise<ApprovalDecision>;
}

// Facts shown by `relay_status`. The shape is free because each agent has different facts.
export type AgentStatus = Record<string, unknown>;

// `run` reports failures as `error` events or thrown errors. `close` releases processes
// and sockets.
export interface AgentAdapter {
  run(request: AgentTurnRequest): AsyncIterable<AgentEvent>;
  readStatus(): Promise<AgentStatus>;
  close(): void;
}

// Must reject when `signal` aborts. The bridge then treats it as "cancel".
export interface ApprovalPrompter {
  requestApproval(
    request: ApprovalRequest,
    signal: AbortSignal,
  ): Promise<ApprovalDecision>;
}
