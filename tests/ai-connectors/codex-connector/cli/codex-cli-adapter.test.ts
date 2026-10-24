// Proves the CLI adapter speaks the `app-server` protocol (fake server): streams replies, passes
// approvals to the human, passes chosen settings, and can interrupt a turn.
import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  AgentEvent,
  ApprovalDecision,
  ApprovalRequest,
} from "../../../../src/bridge/types/agent-adapter.js";
import { CodexCliAdapter } from "../../../../src/ai-connectors/codex-connector/cli/codex-cli-adapter.js";

// The fake server is a plain script run with the current Node, so no real Codex is needed.
const FAKE_SERVER_PATH = new URL("../../../fixtures/fake-codex-app-server.mjs", import.meta.url).pathname;

function createAdapter(options: { approvalPolicy?: string | null; sandboxMode?: string | null; environment?: NodeJS.ProcessEnv } = {}) {
  return new CodexCliAdapter({
    command: process.execPath,
    commandArguments: [FAKE_SERVER_PATH, "app-server"],
    environment: options.environment ?? {},
    approvalPolicy: options.approvalPolicy === undefined ? "untrusted" : options.approvalPolicy,
    sandboxMode: options.sandboxMode === undefined ? "workspace-write" : options.sandboxMode,
  });
}

async function runTurn({
  adapter,
  messageText,
  decision = "decline",
  signal = new AbortController().signal,
  onApproval,
}: {
  adapter: CodexCliAdapter;
  messageText: string;
  decision?: ApprovalDecision;
  signal?: AbortSignal;
  onApproval?: (request: ApprovalRequest) => void;
}): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  const turn = adapter.run({
    messageText,
    workingDirectory: "/tmp",
    signal,
    requestApproval: async (request) => {
      onApproval?.(request);
      return decision;
    },
  });
  for await (const event of turn) events.push(event);
  return events;
}

test("transports a message to Codex and streams the reply", async () => {
  const adapter = createAdapter();
  try {
    const events = await runTurn({ adapter, messageText: "hello" });
    const replyText = events.filter((event) => event.kind === "reply_delta").map((event) => event.text).join("");
    assert.equal(replyText, "echo: hello");
    assert.equal(events.at(-1)?.kind, "reply_complete");
  } finally {
    adapter.close();
  }
});

test("passes the chosen approval policy and sandbox to Codex", async () => {
  const adapter = createAdapter();
  try {
    const events = await runTurn({ adapter, messageText: "show-config" });
    assert.deepEqual(JSON.parse(events[0]?.text ?? "{}"), {
      threadId: "thread-1",
      cwd: "/tmp",
      approvalPolicy: "untrusted",
      sandbox: "workspace-write",
    });
  } finally {
    adapter.close();
  }
});

test("passes the human's decision back to Codex", async () => {
  const adapter = createAdapter();
  try {
    const requests: ApprovalRequest[] = [];
    const accepted = await runTurn({ adapter, messageText: "needs-approval", decision: "accept", onApproval: (request) => requests.push(request) });
    assert.equal(accepted[0]?.text, "decision=accept");
    assert.equal(requests[0]?.kind, "command");
    assert.match(requests[0]?.summary ?? "", /rm -rf build/);

    const declined = await runTurn({ adapter, messageText: "needs-approval", decision: "decline" });
    assert.equal(declined[0]?.text, "decision=decline");

    const cancelled = await runTurn({ adapter, messageText: "needs-approval", decision: "cancel" });
    assert.equal(cancelled.at(-1)?.kind, "cancelled");
  } finally {
    adapter.close();
  }
});

test("a cancelled turn is interrupted even if the cancel comes before the server answers", async () => {
  const adapter = createAdapter();
  try {
    const controller = new AbortController();
    // "hang" never finishes, so only an interrupt ends it. Aborting before the run starts
    // is deterministic and covers an early cancel.
    controller.abort();
    const events = await runTurn({ adapter, messageText: "hang", signal: controller.signal });
    assert.equal(events.at(-1)?.kind, "cancelled");
  } finally {
    adapter.close();
  }
});

test("reports a clear error when the app-server cannot start", async () => {
  const adapter = new CodexCliAdapter({
    command: "/nonexistent/codex",
    commandArguments: ["app-server"],
    environment: {},
    approvalPolicy: "untrusted",
    sandboxMode: "workspace-write",
  });
  await assert.rejects(runTurn({ adapter, messageText: "hello" }), /ENOENT|not running|exited/);
});

test("sends only the settings the user chose, so Codex uses its own defaults", async () => {
  const adapter = createAdapter({ approvalPolicy: null, sandboxMode: null });
  try {
    const events = await runTurn({ adapter, messageText: "show-config" });
    assert.deepEqual(JSON.parse(events[0]?.text ?? "{}"), { threadId: "thread-1", cwd: "/tmp" });
  } finally {
    adapter.close();
  }
});

test("uses the user's Codex defaults without rejecting the turn", async () => {
  const adapter = createAdapter({ approvalPolicy: null, sandboxMode: null, environment: { FAKE_CODEX_DEFAULT_POLICY: "never" } });
  try {
    const events = await runTurn({ adapter, messageText: "hello" });
    assert.equal(events.at(-1)?.kind, "reply_complete");
  } finally {
    adapter.close();
  }
});

test("passes through a chosen no-approval policy and full-access sandbox", async () => {
  const adapter = createAdapter({ approvalPolicy: "never", sandboxMode: "danger-full-access" });
  try {
    const events = await runTurn({ adapter, messageText: "show-config" });
    assert.deepEqual(JSON.parse(events[0]?.text ?? "{}"), {
      threadId: "thread-1",
      cwd: "/tmp",
      approvalPolicy: "never",
      sandbox: "danger-full-access",
    });
  } finally {
    adapter.close();
  }
});

