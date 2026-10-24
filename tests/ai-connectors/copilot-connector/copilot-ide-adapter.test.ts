// Proves the Copilot adapter works against a fake agent host: reply streaming, rejections,
// dropped connections, approvals left to the human, version choice and token secrecy.
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import type { AgentEvent } from "../../../src/bridge/types/agent-adapter.js";
import { CopilotIdeAdapter } from "../../../src/ai-connectors/copilot-connector/ide/copilot-ide-adapter.js";
import {
  FAKE_TOKEN,
  startFakeAhpServer,
  type FakeAhpOptions,
  type FakeAhpServer,
} from "../../fixtures/fake-ahp-server.js";

const servers: FakeAhpServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.stop()));
});

async function setUp(options: FakeAhpOptions = {}, pinnedSessionId: string | null = null) {
  const server = await startFakeAhpServer(options);
  servers.push(server);
  const adapter = new CopilotIdeAdapter({
    endpointDirectories: [server.registryDirectory],
    pinnedSessionId,
    ackTimeoutMs: 300,
  });
  return { server, adapter };
}

async function runTurn(adapter: CopilotIdeAdapter, messageText = "hi"): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  const turn = adapter.run({
    messageText,
    workingDirectory: "/tmp",
    signal: new AbortController().signal,
    requestApproval: async () => {
      throw new Error("requestApproval must never be called");
    },
  });
  for await (const event of turn) events.push(event);
  return events;
}

const methodsOf = (server: FakeAhpServer) => server.received.map((message) => message.method);

test("sends the message and streams the reply", async () => {
  const { server, adapter } = await setUp();
  const events = await runTurn(adapter, "hello copilot");
  assert.equal(events.filter((event) => event.kind === "reply_delta").map((event) => event.text).join(""), "Hello world");
  assert.equal(events.at(-1)?.kind, "reply_complete");

  const dispatch = server.received.find((message) => message.method === "dispatchAction");
  assert.equal(dispatch?.id, undefined);
  const action = (dispatch?.params as { action: { message: { text: string }; turnId: string } }).action;
  assert.equal(action.message.text, "hello copilot");
  assert.match(action.turnId, /^relay-[0-9a-f]+$/);
});

test("creates a provider session in the requested workspace when none exists", async () => {
  const { server, adapter } = await setUp({ sessions: [] });
  const events = await runTurn(adapter, "start in a new session");
  assert.equal(events.at(-1)?.kind, "reply_complete");
  const creation = server.received.find((message) => message.method === "createSession");
  assert.ok(creation);
  const params = creation.params as { channel: string; provider: string; workingDirectories: string[] };
  assert.match(params.channel, /^ahp-session:\//);
  assert.equal(params.provider, "copilot");
  assert.equal(params.workingDirectories[0], "file:///tmp");
});

test("creates Claude sessions through the same Agent Host flow", async () => {
  const server = await startFakeAhpServer({ sessions: [] });
  servers.push(server);
  const adapter = new CopilotIdeAdapter({
    endpointDirectories: [server.registryDirectory],
    pinnedSessionId: null,
    provider: "claude",
    ackTimeoutMs: 300,
  });
  const events = await runTurn(adapter, "start Claude in this workspace");
  assert.equal(events.at(-1)?.kind, "reply_complete");
  const params = server.received.find((message) => message.method === "createSession")?.params as { provider: string };
  assert.equal(params.provider, "claude");
});

test("reports a busy rejection", async () => {
  const { adapter } = await setUp({ behavior: "busy" });
  const events = await runTurn(adapter);
  assert.equal(events[0]?.kind, "error");
  assert.match(events[0]?.text ?? "", /busy/);
});

test("reports a chat error", async () => {
  const { adapter } = await setUp({ behavior: "error" });
  const events = await runTurn(adapter);
  assert.deepEqual(events.at(-1), { kind: "error", text: "model failed" });
});

test("a dropped connection is reported and the message is not resent", async () => {
  const { server, adapter } = await setUp({ behavior: "drop" });
  const events = await runTurn(adapter);
  assert.match(events[0]?.text ?? "", /not resent/);
  assert.equal(methodsOf(server).filter((method) => method === "dispatchAction").length, 1);
});

test("no acknowledgement ends with an uncertain-delivery error and no resend", async () => {
  const { server, adapter } = await setUp({ behavior: "silent" });
  const events = await runTurn(adapter);
  assert.match(events[0]?.text ?? "", /may or may not have arrived/);
  assert.equal(methodsOf(server).filter((method) => method === "dispatchAction").length, 1);
});

test("a tool call waiting for approval shows one notice and sends no confirmation", async () => {
  const { server, adapter } = await setUp({ behavior: "pending-confirmation" });
  const events = await runTurn(adapter);
  const notices = events.filter((event) => event.text.includes("waiting for your approval in VS Code"));
  assert.equal(notices.length, 1);
  assert.equal(events.at(-1)?.kind, "reply_complete");
  assert.ok(!JSON.stringify(server.received).includes("toolCallConfirmed"));
  assert.deepEqual(methodsOf(server).filter((method) => method === "dispatchAction"), ["dispatchAction"]);
});

test("refuses a chat that is busy, read-only or not ready, without sending", async () => {
  for (const [options, pattern] of [
    [{ chatHasActiveTurn: true }, /busy/],
    [{ chatInteractivity: "read-only" }, /does not accept/],
    [{ lifecycle: "failed" }, /not ready/],
  ] as const) {
    const { server, adapter } = await setUp(options);
    await assert.rejects(runTurn(adapter), pattern);
    assert.ok(!methodsOf(server).includes("dispatchAction"));
  }
});

test("rejects an empty message before connecting", async () => {
  const { server, adapter } = await setUp();
  await assert.rejects(runTurn(adapter, "   "), /empty/);
  assert.equal(server.received.length, 0);
});

test("accepts any offered protocol version and fails clearly on others", async () => {
  const accepted = await setUp({ protocolVersion: "0.10.0" });
  assert.equal((await runTurn(accepted.adapter)).at(-1)?.kind, "reply_complete");

  const refused = await setUp({ protocolVersion: "9.9.9" });
  await assert.rejects(runTurn(refused.adapter), /speaks protocol 9\.9\.9/);
});

test("picks the most recently updated session, or the pinned one", async () => {
  const sessions = [
    { resource: "copilot:/old", modifiedAt: "2026-01-01T00:00:00Z" },
    { resource: "copilot:/new", modifiedAt: "2026-02-01T00:00:00Z" },
  ];
  const newest = await setUp({ sessions });
  await runTurn(newest.adapter);
  assert.ok(newest.server.received.some((message) => JSON.stringify(message.params).includes("copilot:/new")));

  const pinned = await setUp({ sessions }, "old");
  await runTurn(pinned.adapter);
  assert.ok(pinned.server.received.some((message) => JSON.stringify(message.params).includes("copilot:/old")));
});

test("asks the human to choose when two windows are live", async () => {
  const first = await startFakeAhpServer();
  const second = await startFakeAhpServer();
  servers.push(first, second);
  const adapter = new CopilotIdeAdapter({
    endpointDirectories: [first.registryDirectory, second.registryDirectory],
    pinnedSessionId: null,
  });
  await assert.rejects(runTurn(adapter), /RELAY_COPILOT_SESSION_ID/);
});

test("never puts the token in an error or status", async () => {
  const { server, adapter } = await setUp({ token: "right-token" });
  // Same file, wrong token, so the host answers 401 and the error must stay clean.
  const { readFile, writeFile } = await import("node:fs/promises");
  const entry = JSON.parse(await readFile(server.entryFilePath, "utf8"));
  await writeFile(server.entryFilePath, JSON.stringify({ ...entry, connectionToken: FAKE_TOKEN }));
  const failure = await runTurn(adapter).catch((error: Error) => error);
  assert.ok(failure instanceof Error);
  assert.ok(!failure.message.includes(FAKE_TOKEN));

  assert.ok(!JSON.stringify(await adapter.readStatus()).includes(FAKE_TOKEN));
});

test("readStatus reports whether a host is running", async () => {
  const { adapter } = await setUp();
  assert.deepEqual(await adapter.readStatus(), { mode: "ide", hostRunning: true });
  const empty = new CopilotIdeAdapter({ endpointDirectories: ["/nonexistent-dir"], pinnedSessionId: null });
  assert.deepEqual(await empty.readStatus(), { mode: "ide", hostRunning: false });
});
