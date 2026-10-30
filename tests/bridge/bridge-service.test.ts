// Proves the bridge sends messages in order and records automatic or requested human approvals.
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type {
  AgentAdapter,
  AgentEvent,
  ApprovalDecision,
  ApprovalPrompter,
} from "../../src/bridge/types/agent-adapter.js";
import { EchoAdapter } from "../fixtures/echo-adapter.js";
import { EventLogService } from "../../src/bridge/event-log-service.js";
import { BridgeService } from "../../src/bridge/bridge-service.js";
import { AgentRoomService } from "../../src/bridge/agent-room-service.js";

const CONVERSATION_ID = "c-test";

// The prompter always returns one decision, decline by default, so tests must ask for accept.
async function withBridgeService(
  options: { decision?: ApprovalDecision; adapter?: AgentAdapter },
  run: (context: {
    bridgeService: BridgeService;
    eventLog: EventLogService;
  }) => Promise<void>,
) {
  const directory = await mkdtemp(join(tmpdir(), "cross-agent-mcp-bridge-orch-"));
  const eventLog = new EventLogService({ logDirectoryPath: join(directory, "log") });
  const approvalPrompter: ApprovalPrompter = {
    requestApproval: async () => options.decision ?? "decline",
  };
  const bridgeService = new BridgeService({
    adapters: new Map([["echo", options.adapter ?? new EchoAdapter()]]),
    eventLog,
    approvalPrompter,
    conversationId: CONVERSATION_ID,
    workingDirectory: directory,
  });
  try {
    await run({ bridgeService, eventLog });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function collect(stream: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

const signal = new AbortController().signal;

test("routes @echo to the adapter and logs the whole exchange", async () => {
  await withBridgeService({}, async ({ bridgeService, eventLog }) => {
    const activity: string[] = [];
    bridgeService.subscribeActivity(({ phase }) => activity.push(phase));
    const events = await collect(
      bridgeService.handleUserInput({ inputText: "@echo hello", signal }),
    );
    assert.deepEqual(events.map((event) => event.text), ["echo: hello", ""]);
    assert.deepEqual(activity, ["working", "idle"]);

    const logged = await eventLog.readConversation(CONVERSATION_ID);
    assert.deepEqual(logged.map((event) => event.kind), [
      "user_message",
      "reply_delta",
      "reply_complete",
    ]);
    assert.equal(logged[0]?.from, "human");
    assert.equal(logged[0]?.to, "echo");
  });
});

test("rejects input without a mention and unknown agents without calling an adapter", async () => {
  await withBridgeService({}, async ({ bridgeService, eventLog }) => {
    const noMention = await collect(bridgeService.handleUserInput({ inputText: "hello", signal }));
    const unknown = await collect(bridgeService.handleUserInput({ inputText: "@claude hi", signal }));
    assert.equal(noMention[0]?.kind, "error");
    assert.match(unknown[0]?.text ?? "", /Unknown agent @claude/);
    assert.deepEqual(await eventLog.readConversation(CONVERSATION_ID), []);
  });
});

test("queues a second message while one turn is running", async () => {
  const delivered: string[] = [];
  const slowAdapter: AgentAdapter = {
    async *run({ messageText }) {
      delivered.push(messageText);
      await new Promise((resolve) => setTimeout(resolve, 50));
      yield { kind: "reply_delta", text: messageText };
      yield { kind: "reply_complete", text: "" };
    },
    async readStatus() {
      return {};
    },
    close() {},
  };
  await withBridgeService({ adapter: slowAdapter }, async ({ bridgeService }) => {
    const first = collect(bridgeService.handleUserInput({ inputText: "@echo one", signal }));
    const second = collect(bridgeService.handleUserInput({ inputText: "@echo two", signal }));
    assert.deepEqual((await first).map((event) => event.text), ["one", ""]);
    assert.deepEqual((await second).map((event) => event.text), ["two", ""]);
    assert.deepEqual(delivered, ["one", "two"]);
  });
});

test("different agents run in parallel, each in the requested folder, and report when they start", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cross-agent-mcp-bridge-parallel-"));
  let releaseSlow!: () => void;
  const slowGate = new Promise<void>((resolve) => { releaseSlow = resolve; });
  const workingDirectories: string[] = [];
  const adapterThat = (wait: () => Promise<void>): AgentAdapter => ({
    async *run({ messageText, workingDirectory }) {
      workingDirectories.push(workingDirectory);
      await wait();
      yield { kind: "reply_delta", text: messageText };
      yield { kind: "reply_complete", text: "" };
    },
    async readStatus() { return {}; },
    close() {},
  });
  const bridgeService = new BridgeService({
    adapters: new Map([["slow", adapterThat(() => slowGate)], ["fast", adapterThat(async () => {})]]),
    eventLog: new EventLogService({ logDirectoryPath: join(directory, "log") }),
    approvalPrompter: { requestApproval: async () => "decline" },
    conversationId: CONVERSATION_ID,
    workingDirectory: directory,
  });
  try {
    const started: string[] = [];
    const slow = collect(bridgeService.handleUserInput({ inputText: "@slow one", signal, onStarted: () => started.push("slow") }));
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(bridgeService.getLiveActivity().agents, { slow: "working" });
    // The fast agent finishes while the slow one is still busy.
    const fast = await collect(bridgeService.handleUserInput({ inputText: "@fast two", signal, workingDirectory: "/rooms/repo", onStarted: () => started.push("fast") }));
    assert.deepEqual(fast.map((event) => event.text), ["two", ""]);
    assert.deepEqual(started, ["slow", "fast"]);
    releaseSlow();
    assert.deepEqual((await slow).map((event) => event.text), ["one", ""]);
    assert.deepEqual(workingDirectories, [directory, "/rooms/repo"]);
    assert.deepEqual(bridgeService.getLiveActivity(), { agentName: null, phase: "idle", agents: {} });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("explicit review sends approval requests to the human", async () => {
  await withBridgeService({ decision: "accept" }, async ({ bridgeService, eventLog }) => {
    const activity: string[] = [];
    bridgeService.subscribeActivity(({ phase }) => activity.push(phase));
    const events = await collect(
      bridgeService.handleUserInput({ inputText: "@echo ask-approval please", signal, requireHumanApproval: true }),
    );
    assert.equal(events[0]?.text, "decision: accept");

    const logged = await eventLog.readConversation(CONVERSATION_ID);
    const decided = logged.find((event) => event.kind === "approval_decided");
    assert.equal(decided?.text, "accept");
    assert.ok(logged.some((event) => event.kind === "approval_requested"));
    assert.ok(activity.includes("waiting_approval"));
  });
});

test("approves agent actions automatically by default without calling the human", async () => {
  await withBridgeService({ decision: "decline" }, async ({ bridgeService, eventLog }) => {
    const activity: string[] = [];
    bridgeService.subscribeActivity(({ phase }) => activity.push(phase));
    const events = await collect(bridgeService.handleUserInput({ inputText: "@echo ask-approval", signal }));
    assert.equal(events[0]?.text, "decision: accept");
    assert.deepEqual(activity, ["working", "idle"]);
    const decided = (await eventLog.readConversation(CONVERSATION_ID)).find((event) => event.kind === "approval_decided");
    assert.equal(decided?.from, "cross-agent-mcp-bridge");
  });
});

test("an aborted turn is a cancel, never an accept", async () => {
  // Aborts then throws, like Ctrl+C during a question. The only safe result is "cancel".
  const controller = new AbortController();
  const abortingPrompter: ApprovalPrompter = {
    requestApproval: async () => {
      controller.abort();
      throw new Error("aborted");
    },
  };
  const directory = await mkdtemp(join(tmpdir(), "cross-agent-mcp-bridge-abort-"));
  try {
    const bridgeService = new BridgeService({
      adapters: new Map([["echo", new EchoAdapter()]]),
      eventLog: new EventLogService({ logDirectoryPath: join(directory, "log") }),
      approvalPrompter: abortingPrompter,
      conversationId: CONVERSATION_ID,
      workingDirectory: directory,
    });
    const events = await collect(
      bridgeService.handleUserInput({ inputText: "@echo ask-approval", signal: controller.signal, requireHumanApproval: true }),
    );
    assert.equal(events[0]?.text, "decision: cancel");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("mirrors relay communication into the shared agent room", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cross-agent-mcp-bridge-room-bridge-"));
  try {
    const agentRoom = new AgentRoomService({ targetRepositoryPath: directory, sessionId: CONVERSATION_ID });
    await agentRoom.initialize();
    const bridgeService = new BridgeService({
      adapters: new Map([["echo", new EchoAdapter()]]),
      eventLog: new EventLogService({ logDirectoryPath: join(directory, "log") }),
      approvalPrompter: { requestApproval: async () => "decline" },
      conversationId: CONVERSATION_ID,
      workingDirectory: directory,
      agentRoom,
    });
    await collect(bridgeService.handleUserInput({ inputText: "@echo hello room", signal }));
    const messages = (await readFile(agentRoom.pathsForRoom.messagesPath, "utf8")).trim();
    assert.match(messages, /"kind":"user_message"/);
    assert.match(messages, /"kind":"reply_delta"/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
