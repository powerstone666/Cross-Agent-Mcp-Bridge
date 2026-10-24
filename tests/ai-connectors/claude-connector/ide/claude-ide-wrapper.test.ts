// Proves the wrapper passes traffic through unchanged, injects relay turns only when idle,
// refuses while busy, and never breaks the IDE when its socket fails (fake claude).
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import type { AgentEvent } from "../../../../src/bridge/types/agent-adapter.js";
import { ClaudeIdeAdapter } from "../../../../src/ai-connectors/claude-connector/ide/claude-ide-adapter.js";
import { parseIdeClientMessage, parseIdeServerMessage } from "../../../../src/ai-connectors/claude-connector/ide/claude-ide-protocol.js";
import { ClaudeIdeWrapperService, isStreamJsonInvocation } from "../../../../src/ai-connectors/claude-connector/ide/claude-ide-wrapper-service.js";

const FAKE_CLAUDE_PATH = new URL("../../../fixtures/fake-claude-cli.mjs", import.meta.url).pathname;
const WAIT_STEP_MS = 10;
const WAIT_LIMIT_MS = 3000;

interface WrapperContext {
  directory: string;
  wrapper: ClaudeIdeWrapperService;
  extensionInput: PassThrough;
  extensionLines: string[];
}

// In-memory streams stand in for VS Code. The socket path must stay short (length limit).
async function withWrapper(
  run: (context: WrapperContext) => Promise<void>,
  { command = process.execPath, commandArguments = [FAKE_CLAUDE_PATH], socketSubpath = "1.sock" } = {},
) {
  const directory = await mkdtemp(join(tmpdir(), "cross-agent-mcp-bridge-cw-"));
  const extensionInput = new PassThrough();
  const extensionOutput = new PassThrough();
  const extensionLines: string[] = [];
  createInterface({ input: extensionOutput }).on("line", (line) => extensionLines.push(line));

  const wrapper = new ClaudeIdeWrapperService({
    command,
    commandArguments,
    environment: {},
    socketPath: join(directory, socketSubpath),
    extensionInput,
    extensionOutput,
  });
  await wrapper.start();
  try {
    await run({ directory, wrapper, extensionInput, extensionLines });
  } finally {
    await wrapper.stop();
    await rm(directory, { recursive: true, force: true });
  }
}

async function waitFor(condition: () => boolean) {
  for (let waited = 0; waited < WAIT_LIMIT_MS; waited += WAIT_STEP_MS) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, WAIT_STEP_MS));
  }
  throw new Error("timed out waiting for the wrapper");
}

const userLine = (text: string) => ({ type: "user", message: { role: "user", content: [{ type: "text", text }] } });
const sendFromExtension = (input: PassThrough, message: object) => input.write(`${JSON.stringify(message)}\n`);
const countResults = (lines: string[]) => lines.filter((line) => line.includes('"type":"result"')).length;

async function collect(stream: AsyncIterable<AgentEvent>) {
  const events: AgentEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

const relayRequest = (messageText: string) => ({
  messageText,
  workingDirectory: "/tmp",
  signal: new AbortController().signal,
  requestApproval: async () => {
    throw new Error("the relay must never answer an approval");
  },
});

test("forwards lines unchanged in both directions, including ones it cannot parse", async () => {
  const echoScript = "process.stdin.pipe(process.stdout)";
  await withWrapper(
    async ({ extensionInput, extensionLines }) => {
      const lines = ['{"b":1,  "a":2}', "not json at all", '{"type":"user","extra":[1,2]}'];
      for (const line of lines) extensionInput.write(`${line}\n`);
      await waitFor(() => extensionLines.length === lines.length);
      assert.deepEqual(extensionLines, lines);
    },
    { commandArguments: ["-e", echoScript] },
  );
});

test("injects a relay turn when idle, and the IDE sees the same output", async () => {
  await withWrapper(async ({ directory, wrapper, extensionInput, extensionLines }) => {
    sendFromExtension(extensionInput, userLine("from the IDE"));
    await waitFor(() => countResults(extensionLines) === 1);
    assert.deepEqual(wrapper.readState(), { sessionId: "session-1", isTurnActive: false, pendingApprovalCount: 0 });

    const adapter = new ClaudeIdeAdapter({ socketDirectoryPath: directory });
    const events = await collect(adapter.run(relayRequest("from the relay")));
    const replyText = events.filter((event) => event.kind === "reply_delta").map((event) => event.text).join("");
    assert.equal(replyText, "echo: from the relay");
    assert.equal(events.at(-1)?.kind, "reply_complete");
    assert.ok(extensionLines.some((line) => line.includes("echo: ") && line.includes("text_delta")), "IDE sees the deltas");
    assert.equal(countResults(extensionLines), 2);
  });
});

test("injects before the IDE has sent anything", async () => {
  await withWrapper(async ({ directory }) => {
    const adapter = new ClaudeIdeAdapter({ socketDirectoryPath: directory });
    const events = await collect(adapter.run(relayRequest("hello")));
    assert.equal(events.at(-1)?.kind, "reply_complete");
  });
});

test("refuses injection while an IDE turn is running", async () => {
  await withWrapper(async ({ directory, wrapper, extensionInput, extensionLines }) => {
    sendFromExtension(extensionInput, userLine("hang"));
    await waitFor(() => wrapper.readState().isTurnActive);

    const adapter = new ClaudeIdeAdapter({ socketDirectoryPath: directory });
    const events = await collect(adapter.run(relayRequest("hello")));
    assert.deepEqual(events.map((event) => event.kind), ["error"]);
    assert.match(events[0]?.text ?? "", /in progress/);

    sendFromExtension(extensionInput, { type: "control_request", request_id: "ext-1", request: { subtype: "interrupt" } });
    await waitFor(() => countResults(extensionLines) === 1);
  });
});

test("refuses injection while an approval waits, and the relay never answers it", async () => {
  await withWrapper(async ({ directory, wrapper, extensionInput, extensionLines }) => {
    sendFromExtension(extensionInput, userLine("needs-approval"));
    await waitFor(() => wrapper.readState().pendingApprovalCount === 1);

    const adapter = new ClaudeIdeAdapter({ socketDirectoryPath: directory });
    const events = await collect(adapter.run(relayRequest("hello")));
    assert.match(events[0]?.text ?? "", /approval is waiting/);
    assert.equal(countResults(extensionLines), 0, "the blocked turn is untouched");

    // The human answers in the IDE.
    sendFromExtension(extensionInput, { type: "control_response", response: { subtype: "success", request_id: "req-1", response: { behavior: "deny", message: "no", interrupt: false } } });
    await waitFor(() => countResults(extensionLines) === 1);
    assert.equal(wrapper.readState().pendingApprovalCount, 0);
  });
});

test("an interrupt from the relay ends the injected turn as cancelled", async () => {
  await withWrapper(async ({ directory, extensionLines }) => {
    const adapter = new ClaudeIdeAdapter({ socketDirectoryPath: directory });
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 150);
    const events = await collect(adapter.run({ ...relayRequest("hang"), signal: controller.signal }));
    assert.equal(events.at(-1)?.kind, "cancelled");
    assert.ok(!extensionLines.some((line) => line.includes("cross-agent-mcp-bridge:")), "IDE never sees relay-only replies");
  });
});

test("a failed relay turn becomes an error event", async () => {
  await withWrapper(async ({ directory }) => {
    const adapter = new ClaudeIdeAdapter({ socketDirectoryPath: directory });
    const events = await collect(adapter.run(relayRequest("fail")));
    assert.deepEqual(events.at(-1), { kind: "error", text: "model exploded" });
  });
});

test("keeps passing traffic through when the relay socket cannot start", async () => {
  await withWrapper(
    async ({ wrapper, extensionInput, extensionLines }) => {
      sendFromExtension(extensionInput, userLine("hello"));
      await waitFor(() => countResults(extensionLines) === 1);
      assert.equal(wrapper.readState().sessionId, "session-1");
    },
    // Path too long for a socket, so the relay socket cannot start. The IDE must still work.
    { socketSubpath: join("x".repeat(200), "1.sock") },
  );
});

test("reports a clear error when no wrapper is running, and ignores stale socket files", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cross-agent-mcp-bridge-cnowrap-"));
  try {
    const adapter = new ClaudeIdeAdapter({ socketDirectoryPath: directory });
    await assert.rejects(collect(adapter.run(relayRequest("hello"))), /No Claude IDE wrapper/);
    await writeFile(join(directory, "123.sock"), "");
    assert.deepEqual(await adapter.readStatus(), { mode: "ide", ideWrapperRunning: false, liveWrapperCount: 0 });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("counts only live sockets in the status", async () => {
  await withWrapper(async ({ directory }) => {
    await writeFile(join(directory, "stale.sock"), "");
    const adapter = new ClaudeIdeAdapter({ socketDirectoryPath: directory });
    assert.deepEqual(await adapter.readStatus(), { mode: "ide", ideWrapperRunning: true, liveWrapperCount: 1 });
  });
});

test("answers an invalid socket message with an error and does nothing else", async () => {
  await withWrapper(async ({ directory, wrapper }) => {
    const socket = connect(join(directory, "1.sock"));
    const lines: string[] = [];
    createInterface({ input: socket }).on("line", (line) => lines.push(line));
    socket.write(`${JSON.stringify({ type: "send", requestId: "r1", text: "" })}\n`);
    socket.write(`${JSON.stringify({ type: "shell", requestId: "r2" })}\n`);
    socket.write("garbage\n");
    await waitFor(() => lines.length === 2);
    socket.destroy();
    assert.ok(lines.every((line) => line.includes('"type":"error"')));
    assert.equal(wrapper.readState().isTurnActive, false);
  });
});

test("validates client and server socket messages", () => {
  assert.deepEqual(parseIdeClientMessage('{"type":"send","requestId":"a","text":"hi"}'), { type: "send", requestId: "a", text: "hi" });
  assert.deepEqual(parseIdeClientMessage('{"type":"interrupt","requestId":"a"}'), { type: "interrupt", requestId: "a" });
  assert.equal(parseIdeClientMessage("not json"), undefined);
  assert.equal(parseIdeClientMessage("[1]"), undefined);
  assert.equal(parseIdeClientMessage('{"type":"send","text":"hi"}')?.type, "invalid");
  assert.equal(parseIdeClientMessage('{"type":"send","requestId":5,"text":"hi"}')?.type, "invalid");
  assert.equal(parseIdeClientMessage('{"type":"send","requestId":"a","text":7}')?.type, "invalid");
  assert.equal(parseIdeClientMessage(JSON.stringify({ type: "send", requestId: "a", text: "x".repeat(300_000) }))?.type, "invalid");
  assert.equal(parseIdeClientMessage('{"type":"other","requestId":"a"}')?.type, "invalid");

  assert.deepEqual(parseIdeServerMessage('{"type":"delta","requestId":"a","text":"x"}'), { type: "delta", requestId: "a", text: "x" });
  assert.deepEqual(parseIdeServerMessage('{"type":"completed","requestId":"a","status":"failed"}'), { type: "completed", requestId: "a", status: "failed", errorMessage: null });
  assert.equal(parseIdeServerMessage('{"type":"delta","requestId":"a"}'), undefined);
  assert.equal(parseIdeServerMessage('{"type":"delta","text":"x"}'), undefined);
  assert.equal(parseIdeServerMessage("{"), undefined);
});

test("only wraps stream-json sessions", () => {
  assert.equal(isStreamJsonInvocation({ commandArguments: ["--output-format", "stream-json", "--input-format", "stream-json"] }), true);
  assert.equal(isStreamJsonInvocation({ commandArguments: ["--input-format=stream-json"] }), true);
  assert.equal(isStreamJsonInvocation({ commandArguments: ["--version"] }), false);
  assert.equal(isStreamJsonInvocation({ commandArguments: ["--output-format", "stream-json"] }), false);
});
