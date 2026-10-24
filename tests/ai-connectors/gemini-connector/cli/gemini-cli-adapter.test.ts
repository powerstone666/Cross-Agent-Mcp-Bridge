// Proves the CLI adapter speaks ACP (fake agent): streams replies, maps human decisions to
// once-only options, reuses one session, cancels on abort, and survives crashes and bad lines.
import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  AgentEvent,
  ApprovalDecision,
  ApprovalRequest,
} from "../../../../src/bridge/types/agent-adapter.js";
import { GeminiCliAdapter } from "../../../../src/ai-connectors/gemini-connector/cli/gemini-cli-adapter.js";

const FAKE_AGENT_PATH = new URL("../../../fixtures/fake-gemini-acp.mjs", import.meta.url).pathname;
const DEFAULT_ARGUMENTS = ["--experimental-acp"];

function createAdapter(commandArguments = DEFAULT_ARGUMENTS) {
  return new GeminiCliAdapter({
    command: process.execPath,
    commandArguments: [FAKE_AGENT_PATH, ...commandArguments],
    environment: {},
  });
}

async function runTurn({
  adapter,
  messageText,
  decision = "decline",
  signal = new AbortController().signal,
  onApproval,
}: {
  adapter: GeminiCliAdapter;
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

const replyOf = (events: AgentEvent[]) =>
  events.filter((event) => event.kind === "reply_delta").map((event) => event.text).join("");

async function withAdapter(body: (adapter: GeminiCliAdapter) => Promise<void>) {
  const adapter = createAdapter();
  try {
    await body(adapter);
  } finally {
    adapter.close();
  }
}

test("streams the reply and ignores thought chunks", () =>
  withAdapter(async (adapter) => {
    const events = await runTurn({ adapter, messageText: "hello" });
    assert.equal(replyOf(events), "echo: hello");
    assert.equal(events.at(-1)?.kind, "reply_complete");
  }));

test("runs Gemini in the requested folder", () =>
  withAdapter(async (adapter) => {
    const events = await runTurn({ adapter, messageText: "show-cwd" });
    assert.match(replyOf(events), /cwd=\/tmp /);
  }));

test("accept selects the allow-once option, never allow-always", () =>
  withAdapter(async (adapter) => {
    const requests: ApprovalRequest[] = [];
    const events = await runTurn({ adapter, messageText: "needs-approval", decision: "accept", onApproval: (request) => requests.push(request) });
    assert.match(replyOf(events), /done: allowed/);
    assert.equal(events.at(-1)?.kind, "reply_complete");
    assert.equal(requests[0]?.kind, "command");
    assert.match(requests[0]?.summary ?? "", /rm -rf build/);
    assert.deepEqual(requests[0]?.detailLines, ["path: /tmp/build", "rm -rf build in /tmp"]);
  }));

test("decline selects the reject-once option and the turn ends cancelled", () =>
  withAdapter(async (adapter) => {
    const events = await runTurn({ adapter, messageText: "needs-approval", decision: "decline" });
    assert.match(replyOf(events), /not allowed: reject-once/);
    assert.equal(events.at(-1)?.kind, "cancelled");
  }));

test("cancel answers cancelled and stops the turn", () =>
  withAdapter(async (adapter) => {
    const events = await runTurn({ adapter, messageText: "needs-approval", decision: "cancel" });
    // session/cancel may reach the fake before the outcome, so only the end state is fixed.
    assert.doesNotMatch(replyOf(events), /done: allowed|allow-always/);
    assert.equal(events.at(-1)?.kind, "cancelled");
  }));

test("keeps one session and one process across turns", () =>
  withAdapter(async (adapter) => {
    const first = replyOf(await runTurn({ adapter, messageText: "show-session" }));
    const second = replyOf(await runTurn({ adapter, messageText: "show-session" }));
    assert.match(first, /prompts=1 /);
    assert.match(second, /prompts=2 /);
    assert.equal(first.split("pid=")[1], second.split("pid=")[1]);
    assert.deepEqual(await adapter.readStatus(), { mode: "cli", binaryFound: true, isSessionOpen: true });
  }));

test("an abort sends session/cancel and ends with a cancelled event", () =>
  withAdapter(async (adapter) => {
    const controller = new AbortController();
    controller.abort();
    const events = await runTurn({ adapter, messageText: "hang", signal: controller.signal });
    assert.equal(events.at(-1)?.kind, "cancelled");
  }));

test("agent requests other than permission get a method-not-found error", () =>
  withAdapter(async (adapter) => {
    const events = await runTurn({ adapter, messageText: "unknown-request" });
    assert.match(replyOf(events), /code=-32601/);
  }));

test("a crash mid-turn ends with an error that includes stderr", () =>
  withAdapter(async (adapter) => {
    const events = await runTurn({ adapter, messageText: "crash" });
    assert.equal(events.at(-1)?.kind, "error");
    assert.match(events.at(-1)?.text ?? "", /fatal: boom/);
  }));

test("ignores malformed lines", () =>
  withAdapter(async (adapter) => {
    const events = await runTurn({ adapter, messageText: "malformed" });
    assert.equal(replyOf(events), "survived");
    assert.equal(events.at(-1)?.kind, "reply_complete");
  }));

test("runs with a chosen approval mode", async () => {
  const adapter = createAdapter(["--experimental-acp", "--approval-mode", "yolo"]);
  try {
    const events = await runTurn({ adapter, messageText: "hello" });
    assert.equal(events.at(-1)?.kind, "reply_complete");
  } finally {
    adapter.close();
  }
});

test("reports a clear error when the binary cannot start", async () => {
  const adapter = new GeminiCliAdapter({ command: "/nonexistent/gemini", commandArguments: [], environment: {} });
  await assert.rejects(runTurn({ adapter, messageText: "hello" }), /ENOENT|not running|exited/);
});
