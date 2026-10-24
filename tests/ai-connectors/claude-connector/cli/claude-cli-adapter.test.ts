// Proves the CLI adapter speaks stream-json (fake claude): streams replies, maps approval
// decisions without ever widening permissions, interrupts, and reports errors and crashes.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentEvent, ApprovalDecision, ApprovalRequest } from "../../../../src/bridge/types/agent-adapter.js";
import { ClaudeCliAdapter } from "../../../../src/ai-connectors/claude-connector/cli/claude-cli-adapter.js";
import { CLAUDE_CLI_ARGUMENTS } from "../../../../src/ai-connectors/claude-connector/claude-config.js";

const FAKE_CLAUDE_PATH = new URL("../../../fixtures/fake-claude-cli.mjs", import.meta.url).pathname;

function createAdapter() {
  return new ClaudeCliAdapter({
    command: process.execPath,
    commandArguments: [FAKE_CLAUDE_PATH, ...CLAUDE_CLI_ARGUMENTS],
    environment: {},
  });
}

async function runTurn({
  adapter,
  messageText,
  decision = "decline",
  signal = new AbortController().signal,
  approvalDelayMs = 0,
  onApproval,
}: {
  adapter: ClaudeCliAdapter;
  messageText: string;
  decision?: ApprovalDecision;
  signal?: AbortSignal;
  approvalDelayMs?: number;
  onApproval?: (request: ApprovalRequest) => void;
}): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  const turn = adapter.run({
    messageText,
    workingDirectory: "/tmp",
    signal,
    requestApproval: async (request) => {
      onApproval?.(request);
      await new Promise((resolve) => setTimeout(resolve, approvalDelayMs));
      return decision;
    },
  });
  for await (const event of turn) events.push(event);
  return events;
}

const replyText = (events: AgentEvent[]) =>
  events.filter((event) => event.kind === "reply_delta").map((event) => event.text).join("");

test("streams the reply from text deltas and keeps the conversation process", async () => {
  const adapter = createAdapter();
  try {
    const first = await runTurn({ adapter, messageText: "hello" });
    assert.equal(replyText(first), "echo: hello");
    assert.equal(first.at(-1)?.kind, "reply_complete");
    assert.ok(first.filter((event) => event.kind === "reply_delta").length >= 2, "more than one delta");

    const second = await runTurn({ adapter, messageText: "again" });
    assert.equal(replyText(second), "echo: again");
    assert.deepEqual(await adapter.readStatus(), { mode: "cli", isSessionOpen: true });
  } finally {
    adapter.close();
  }
});

test("falls back to the assistant message when there are no deltas", async () => {
  const adapter = createAdapter();
  try {
    const events = await runTurn({ adapter, messageText: "no-deltas" });
    assert.equal(replyText(events), "only assistant text");
  } finally {
    adapter.close();
  }
});

test("starts claude in the requested folder and routes approvals through stdio", async () => {
  const adapter = createAdapter();
  try {
    const text = replyText(await runTurn({ adapter, messageText: "show-args" }));
    assert.match(text, /cwd=(\/private)?\/tmp /);
    assert.doesNotMatch(text, /--permission-mode/);
    assert.match(text, /--permission-prompt-tool stdio/);
    assert.doesNotMatch(text, /dangerously/);
  } finally {
    adapter.close();
  }
});

test("accept allows with the original input and no updatedPermissions", async () => {
  const adapter = createAdapter();
  try {
    const requests: ApprovalRequest[] = [];
    const events = await runTurn({ adapter, messageText: "needs-approval", decision: "accept", onApproval: (request) => requests.push(request) });
    const reply = JSON.parse(replyText(events));
    assert.equal(reply.behavior, "allow");
    assert.equal(reply.updatedInputMatches, true);
    assert.equal(reply.hasUpdatedPermissions, false);

    assert.equal(requests[0]?.kind, "command");
    assert.match(requests[0]?.summary ?? "", /rm -rf build/);
    assert.ok(requests[0]?.detailLines.includes("Run command"));
  } finally {
    adapter.close();
  }
});

test("decline denies without interrupting, and the turn still completes", async () => {
  const adapter = createAdapter();
  try {
    const events = await runTurn({ adapter, messageText: "needs-approval", decision: "decline" });
    const reply = JSON.parse(replyText(events));
    assert.deepEqual([reply.behavior, reply.message, reply.interrupt], ["deny", "User declined", false]);
    assert.equal(reply.hasUpdatedPermissions, false);
    assert.equal(events.at(-1)?.kind, "reply_complete");
  } finally {
    adapter.close();
  }
});

test("cancel denies with interrupt and ends the turn as cancelled", async () => {
  const adapter = createAdapter();
  try {
    const events = await runTurn({ adapter, messageText: "needs-approval", decision: "cancel" });
    assert.equal(events.at(-1)?.kind, "cancelled");
    assert.equal(replyText(events).includes('"interrupt":true'), true);
  } finally {
    adapter.close();
  }
});

test("treats file edits as file-change approvals", async () => {
  const adapter = createAdapter();
  try {
    const requests: ApprovalRequest[] = [];
    await runTurn({ adapter, messageText: "needs-edit", onApproval: (request) => requests.push(request) });
    assert.equal(requests[0]?.kind, "file-change");
    assert.ok(requests[0]?.detailLines.includes("file: /tmp/a.txt"));
  } finally {
    adapter.close();
  }
});

test("a request the CLI withdrew is never allowed, even if the human accepts late", async () => {
  const adapter = createAdapter();
  try {
    const events = await runTurn({ adapter, messageText: "cancelled-approval", decision: "accept", approvalDelayMs: 150 });
    const reply = JSON.parse(replyText(events));
    assert.deepEqual([reply.behavior, reply.interrupt], ["deny", true]);
  } finally {
    adapter.close();
  }
});

test("answers a user-dialog request with an error instead of leaving Claude waiting", async () => {
  const adapter = createAdapter();
  try {
    const events = await runTurn({ adapter, messageText: "dialog" });
    assert.equal(replyText(events), "dialog=error");
  } finally {
    adapter.close();
  }
});

test("an abort sends an interrupt and the turn ends as cancelled", async () => {
  const adapter = createAdapter();
  try {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 100);
    const events = await runTurn({ adapter, messageText: "hang", signal: controller.signal });
    assert.equal(events.at(-1)?.kind, "cancelled");
  } finally {
    adapter.close();
  }
});

test("an already aborted signal cancels without starting claude", async () => {
  const adapter = createAdapter();
  const controller = new AbortController();
  controller.abort();
  const events = await runTurn({ adapter, messageText: "hello", signal: controller.signal });
  assert.deepEqual(events.map((event) => event.kind), ["cancelled"]);
  assert.deepEqual(await adapter.readStatus(), { mode: "cli", isSessionOpen: false });
});

test("an error result becomes an error event", async () => {
  const adapter = createAdapter();
  try {
    const events = await runTurn({ adapter, messageText: "fail" });
    assert.deepEqual(events.at(-1), { kind: "error", text: "model exploded" });
  } finally {
    adapter.close();
  }
});

test("a crash mid-turn becomes an error with the last stderr lines, and the next turn restarts", async () => {
  const adapter = createAdapter();
  try {
    const events = await runTurn({ adapter, messageText: "crash" });
    assert.equal(events.at(-1)?.kind, "error");
    assert.match(events.at(-1)?.text ?? "", /exited \(3\).*fatal: fake crash/s);

    const next = await runTurn({ adapter, messageText: "hello" });
    assert.equal(replyText(next), "echo: hello");
  } finally {
    adapter.close();
  }
});

test("reports an error when the program cannot start", async () => {
  const adapter = new ClaudeCliAdapter({ command: "/nonexistent/claude", commandArguments: CLAUDE_CLI_ARGUMENTS, environment: {} });
  const events = await runTurn({ adapter, messageText: "hello" });
  assert.equal(events.at(-1)?.kind, "error");
});
