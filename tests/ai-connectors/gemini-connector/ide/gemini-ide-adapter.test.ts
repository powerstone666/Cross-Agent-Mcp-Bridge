// Proves the IDE adapter drives a fake Antigravity hub: reply, follow-ups, approvals left to the
// human, abort, timeout, errors, and no resend after a lost connection.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentEvent } from "../../../../src/bridge/types/agent-adapter.js";
import { GeminiIdeAdapter } from "../../../../src/ai-connectors/gemini-connector/ide/gemini-ide-adapter.js";
import { startFakeHub, type FakeHub, type FakeHubOptions } from "../../../fixtures/fake-antigravity-hub.js";

const FOLDER = "/work/app";
const psLine = ({ port, token }: { port: number; token: string }) =>
  `42 agy --hub --hub-port=${port} --app_data_dir=antigravity --csrf_token=${token} --add-dir=${FOLDER}`;

async function withHub(
  hubOptions: FakeHubOptions,
  body: (input: { hub: FakeHub; adapter: GeminiIdeAdapter }) => Promise<void>,
  adapterOptions: { timeoutMs?: number; csrfToken?: string } = {},
) {
  const hub = await startFakeHub(hubOptions);
  const adapter = new GeminiIdeAdapter({
    listProcesses: async () => psLine({ port: hub.port, token: adapterOptions.csrfToken ?? hub.token }),
    pollIntervalMs: 5,
    ...(adapterOptions.timeoutMs === undefined ? {} : { timeoutMs: adapterOptions.timeoutMs }),
  });
  try {
    await body({ hub, adapter });
  } finally {
    adapter.close();
    await hub.close();
  }
}

async function runTurn(adapter: GeminiIdeAdapter, messageText: string, signal = new AbortController().signal) {
  const events: AgentEvent[] = [];
  const turn = adapter.run({
    messageText,
    workingDirectory: FOLDER,
    signal,
    requestApproval: async () => assert.fail("requestApproval must never be called"),
  });
  for await (const event of turn) events.push(event);
  return events;
}

const textOf = (events: AgentEvent[]) => events.map((event) => event.text).join("|");

test("happy path returns the trimmed reply and the chosen model", async () => {
  await withHub({}, async ({ hub, adapter }) => {
    const events = await runTurn(adapter, "hello");
    assert.deepEqual(events.map((event) => event.kind), ["reply_delta", "reply_complete"]);
    assert.equal(events[0]?.text, "reply to: hello");
    const sent = hub.callsOf("SendUserCascadeMessage")[0]!;
    assert.equal(sent.cascadeConfig.plannerConfig.planModel, "MODEL_FAKE_1");
    assert.equal(sent.cascadeConfig.toolConfig, undefined);
  });
});

test("sends no model when the model list is unavailable", async () => {
  await withHub({ modelConfigsFail: true }, async ({ hub, adapter }) => {
    await runTurn(adapter, "hi");
    // With no model list the relay sends no model at all, so the hub uses its own default.
    assert.equal("planModel" in hub.callsOf("SendUserCascadeMessage")[0]!.cascadeConfig.plannerConfig, false);
  });
});

test("a follow-up turn reuses the cascade and reads only the new reply", async () => {
  await withHub({}, async ({ hub, adapter }) => {
    await runTurn(adapter, "one");
    const events = await runTurn(adapter, "two");
    assert.equal(events[0]?.text, "reply to: two");
    assert.equal(hub.callsOf("StartCascade").length, 1);
    const [first, second] = hub.callsOf("SendUserCascadeMessage");
    assert.equal(first!.cascadeId, second!.cascadeId);
  });
});

test("waiting for approval is shown once and the relay never answers it", async () => {
  await withHub({ waitsForApproval: true, runningPolls: 4 }, async ({ hub, adapter }) => {
    const events = await runTurn(adapter, "do it");
    const waiting = events.filter((event) => event.text === "[waiting for your approval in Antigravity]");
    assert.equal(waiting.length, 1);
    assert.equal(events.at(-1)?.kind, "reply_complete");
    assert.equal(hub.callsOf("HandleCascadeUserInteraction").length, 0);
  });
});

test("abort cancels the cascade and ends with cancelled", async () => {
  await withHub({ neverFinishes: true }, async ({ hub, adapter }) => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 30);
    const events = await runTurn(adapter, "long", controller.signal);
    assert.equal(events.at(-1)?.kind, "cancelled");
    assert.equal(hub.callsOf("CancelCascadeInvocation").length, 1);
  });
});

test("timeout ends with an error and does not resend", async () => {
  await withHub({ neverFinishes: true }, async ({ hub, adapter }) => {
    const events = await runTurn(adapter, "slow");
    assert.deepEqual(events, [{ kind: "error", text: "Antigravity did not finish in time" }]);
    assert.equal(hub.callsOf("SendUserCascadeMessage").length, 1);
  }, { timeoutMs: 60 });
});

test("a non-zero grpc status throws its message", async () => {
  await withHub({ grpcErrorOnMethod: "StartCascade" }, async ({ adapter }) => {
    await assert.rejects(runTurn(adapter, "x"), /boom happened/);
  });
});

test("a failed step becomes an error event with the IDE's message", async () => {
  await withHub({ errorStepInsteadOfReply: true }, async ({ adapter }) => {
    assert.deepEqual(await runTurn(adapter, "x"), [
      { kind: "error", text: "Agent execution terminated due to error.: unknown model key: model not found" },
    ]);
  });
});

test("a wrong token fails without leaking either token", async () => {
  const wrongToken = "99999999-9999-4999-8999-999999999999";
  await withHub({}, async ({ hub, adapter }) => {
    await assert.rejects(runTurn(adapter, "x"), (error: Error) => {
      assert.match(error.message, /HTTP 403/);
      assert.ok(!error.message.includes(wrongToken) && !error.message.includes(hub.token));
      return true;
    });
  }, { csrfToken: wrongToken });
});

test("a lost connection on send reports uncertain delivery and never resends", async () => {
  await withHub({ dropConnectionOnSend: true }, async ({ hub, adapter }) => {
    const events = await runTurn(adapter, "x");
    assert.match(textOf(events), /may or may not have arrived/);
    assert.equal(hub.callsOf("SendUserCascadeMessage").length, 1);
  });
});

test("readStatus counts healthy hubs and exposes no port or token", async () => {
  await withHub({}, async ({ hub, adapter }) => {
    const status = await adapter.readStatus();
    assert.deepEqual(status, { mode: "ide", hubRunning: true, hubCount: 1 });
    assert.ok(!JSON.stringify(status).includes(hub.token));
  });
});
