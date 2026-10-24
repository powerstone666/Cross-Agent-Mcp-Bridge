// Proves the wrapper passes normal traffic through, shows relay turns in the IDE, and does no
// harm when the relay fails (the IDE must keep working). Uses a fake server.
import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { createInterface } from "node:readline";
import { test } from "node:test";
import { parseIdeClientMessage } from "../../../../src/ai-connectors/codex-connector/ide/codex-ide-protocol.js";
import type { AgentEvent } from "../../../../src/bridge/types/agent-adapter.js";
import { CodexIdeAdapter } from "../../../../src/ai-connectors/codex-connector/ide/codex-ide-adapter.js";
import { CodexIdeWrapperService, isAppServerInvocation } from "../../../../src/ai-connectors/codex-connector/ide/codex-ide-wrapper-service.js";

const FAKE_SERVER_PATH = new URL("../../../fixtures/fake-codex-app-server.mjs", import.meta.url).pathname;
const NEW_THREAD_PARAMS = { cwd: "/tmp", preferIdeWorkspace: false, approvalPolicy: "untrusted", approvalsReviewer: "user", sandbox: "workspace-write" } as const;
// The relay sends no policy or sandbox when the user chose none, so Codex uses its own defaults.
const USER_DEFAULT_PARAMS = { cwd: "/tmp", preferIdeWorkspace: false, approvalsReviewer: "user" } as const;
// Polls every few milliseconds, with a time limit so a stuck test cannot hang.
const WAIT_STEP_MS = 10;
const WAIT_LIMIT_MS = 3000;

// In-memory streams stand in for VS Code. The socket path must stay short (length limit).
async function withWrapper(
  run: (context: {
    directory: string;
    extensionInput: PassThrough;
    extensionLines: string[];
  }) => Promise<void>,
  childEnvironment: NodeJS.ProcessEnv = {},
) {
  const directory = await mkdtemp(join(tmpdir(), "cross-agent-mcp-bridge-wrap-"));
  const extensionInput = new PassThrough();
  const extensionOutput = new PassThrough();
  const extensionLines: string[] = [];
  createInterface({ input: extensionOutput }).on("line", (line) => extensionLines.push(line));

  const wrapper = new CodexIdeWrapperService({
    command: process.execPath,
    commandArguments: [FAKE_SERVER_PATH, "app-server"],
    environment: childEnvironment,
    socketPath: join(directory, "1.sock"),
    extensionInput,
    extensionOutput,
  });
  await wrapper.start();
  try {
    await run({ directory, extensionInput, extensionLines });
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

function sendFromExtension(extensionInput: PassThrough, message: object) {
  extensionInput.write(`${JSON.stringify(message)}\n`);
}

async function collect(stream: AsyncIterable<AgentEvent>) {
  const events: AgentEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

const adapterRequest = (messageText: string) => ({
  messageText,
  workingDirectory: "/tmp",
  signal: new AbortController().signal,
  requestApproval: async () => "decline" as const,
});

test("passes extension traffic through and injects a turn the IDE can see", async () => {
  await withWrapper(async ({ directory, extensionInput, extensionLines }) => {
    sendFromExtension(extensionInput, { id: 1, method: "initialize", params: { clientInfo: { name: "ext", version: "1" } } });
    sendFromExtension(extensionInput, { id: 2, method: "thread/start", params: {} });
    await waitFor(() => extensionLines.some((line) => line.includes("thread-1")));
    sendFromExtension(extensionInput, { id: 3, method: "turn/start", params: { threadId: "thread-1", input: [{ type: "text", text: "from the IDE" }] } });
    await waitFor(() => extensionLines.some((line) => line.includes("turn/completed")));
    const linesBeforeRelay = extensionLines.length;

    const adapter = new CodexIdeAdapter({ socketDirectoryPath: directory, newThreadParams: NEW_THREAD_PARAMS });
    const events = await collect(adapter.run(adapterRequest("from the relay")));

    const replyText = events.filter((event) => event.kind === "reply_delta").map((event) => event.text).join("");
    assert.equal(replyText, "echo: from the relay");
    assert.equal(events.at(-1)?.kind, "reply_complete");

    const linesAfterRelay = extensionLines.slice(linesBeforeRelay);
    assert.ok(linesAfterRelay.some((line) => line.includes("echo: ") && line.includes("item/agentMessage/delta")), "IDE sees the deltas");
    // Replies meant for the relay's socket client would confuse the IDE, so it must not see them.
    assert.ok(!extensionLines.some((line) => line.includes("cross-agent-mcp-bridge:")), "IDE never sees relay-only responses");
  });
});

// The IDE has not opened a thread yet, so the wrapper must start one first.
test("starts a thread itself when the IDE has none", async () => {
  await withWrapper(async ({ directory, extensionLines }) => {
    const adapter = new CodexIdeAdapter({ socketDirectoryPath: directory, newThreadParams: NEW_THREAD_PARAMS });
    const events = await collect(adapter.run(adapterRequest("hello")));

    const replyText = events.filter((event) => event.kind === "reply_delta").map((event) => event.text).join("");
    assert.equal(replyText, "echo: hello");
    assert.ok(extensionLines.some((line) => line.includes("item/agentMessage/delta")), "IDE sees the turn");
  });
});

test("refuses to send when there is no thread and no way to start one", async () => {
  await withWrapper(async ({ directory }) => {
    const socket = connect(join(directory, "1.sock"));
    const lines: string[] = [];
    createInterface({ input: socket }).on("line", (line) => lines.push(line));
    socket.write(`${JSON.stringify({ type: "send", requestId: "r1", text: "hello" })}\n`);
    await waitFor(() => lines.length > 0);
    socket.destroy();
    assert.match(lines[0] ?? "", /No active Codex thread/);
  });
});

test("reports a clear error when no wrapper is running", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cross-agent-mcp-bridge-nowrap-"));
  try {
    const adapter = new CodexIdeAdapter({ socketDirectoryPath: directory, newThreadParams: NEW_THREAD_PARAMS });
    await assert.rejects(collect(adapter.run(adapterRequest("hello"))), /No Codex IDE wrapper/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("keeps passing traffic through when the relay socket cannot start", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cross-agent-mcp-bridge-badsock-"));
  const extensionInput = new PassThrough();
  const extensionOutput = new PassThrough();
  const extensionLines: string[] = [];
  createInterface({ input: extensionOutput }).on("line", (line) => extensionLines.push(line));

  const wrapper = new CodexIdeWrapperService({
    command: process.execPath,
    commandArguments: [FAKE_SERVER_PATH, "app-server"],
    environment: {},
    // Path too long for a socket, so the relay socket cannot start. The IDE must still work.
    socketPath: join(directory, "x".repeat(200), "1.sock"),
    extensionInput,
    extensionOutput,
  });
  try {
    await wrapper.start();
    sendFromExtension(extensionInput, { id: 1, method: "initialize", params: { clientInfo: { name: "ext", version: "1" } } });
    await waitFor(() => extensionLines.some((line) => line.includes("userAgent")));
  } finally {
    await wrapper.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

test("passes chosen approval and sandbox settings to a new thread", async () => {
  await withWrapper(async ({ directory }) => {
    const adapter = new CodexIdeAdapter({ socketDirectoryPath: directory, newThreadParams: { ...NEW_THREAD_PARAMS, approvalPolicy: "never", sandbox: "danger-full-access", approvalsReviewer: "auto_review" } });
    const events = await collect(adapter.run(adapterRequest("show-config")));
    assert.deepEqual(JSON.parse(events[0]?.text ?? "{}"), { threadId: "thread-1", cwd: "/tmp", approvalPolicy: "never", approvalsReviewer: "auto_review", sandbox: "danger-full-access" });
  });
});

test("a cancelled turn is interrupted even if the cancel comes before the turn id is known", async () => {
  await withWrapper(async ({ directory }) => {
    const adapter = new CodexIdeAdapter({ socketDirectoryPath: directory, newThreadParams: NEW_THREAD_PARAMS });
    const controller = new AbortController();
    controller.abort();
    // "hang" never ends by itself, so only an interrupt can finish this turn.
    const events = await collect(adapter.run({ ...adapterRequest("hang"), signal: controller.signal }));
    assert.equal(events.at(-1)?.kind, "cancelled");
  });
});

test("reports a wrapper as not running when only a stale socket file is left", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cross-agent-mcp-bridge-stale-"));
  try {
    // A plain file stands in for the socket file a stopped wrapper leaves behind.
    await writeFile(join(directory, "123.sock"), "");
    const adapter = new CodexIdeAdapter({ socketDirectoryPath: directory, newThreadParams: NEW_THREAD_PARAMS });
    assert.deepEqual(await adapter.readStatus(), { mode: "ide", ideWrapperRunning: false });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("matches the way VS Code starts the server", () => {
  assert.equal(
    isAppServerInvocation({
      commandArguments: ["-c", "features.code_mode_host=true", "app-server", "--analytics-default-enabled"],
    }),
    true,
  );
  assert.equal(isAppServerInvocation({ commandArguments: ["app-server"] }), true);
});

test("does not match other commands or app-server subcommands", () => {
  assert.equal(isAppServerInvocation({ commandArguments: ["exec", "hello"] }), false);
  assert.equal(isAppServerInvocation({ commandArguments: ["app-server", "daemon", "start"] }), false);
  assert.equal(isAppServerInvocation({ commandArguments: [] }), false);
});

test("starts the new thread with only the settings the user chose", async () => {
  await withWrapper(async ({ directory }) => {
    const adapter = new CodexIdeAdapter({ socketDirectoryPath: directory, newThreadParams: USER_DEFAULT_PARAMS });
    const events = await collect(adapter.run(adapterRequest("show-config")));
    // No approvalPolicy or sandbox keys, so Codex applies the user's own defaults.
    assert.deepEqual(JSON.parse(events[0]?.text ?? "{}"), { threadId: "thread-1", cwd: "/tmp", approvalsReviewer: "user" });
  });
});

test("opens the new thread in the IDE's workspace folder when asked", async () => {
  await withWrapper(async ({ directory, extensionInput, extensionLines }) => {
    // Any request that carries a cwd tells the wrapper which project the IDE has open.
    sendFromExtension(extensionInput, { id: 1, method: "initialize", params: { clientInfo: { name: "ext", version: "1" }, cwd: "/work/ide-project" } });
    await waitFor(() => extensionLines.some((line) => line.includes("userAgent")));

    const preferIde = new CodexIdeAdapter({ socketDirectoryPath: directory, newThreadParams: { ...USER_DEFAULT_PARAMS, preferIdeWorkspace: true } });
    const events = await collect(preferIde.run(adapterRequest("show-config")));
    assert.equal(JSON.parse(events[0]?.text ?? "{}").cwd, "/work/ide-project");
  });
});

test("uses Codex's own approval defaults", async () => {
  await withWrapper(async ({ directory, extensionLines }) => {
    const adapter = new CodexIdeAdapter({ socketDirectoryPath: directory, newThreadParams: USER_DEFAULT_PARAMS });
    const events = await collect(adapter.run(adapterRequest("hello")));
    assert.equal(events.at(-1)?.kind, "reply_complete");
    assert.equal(extensionLines.some((line) => line.includes("item/agentMessage/delta")), true);
  }, { FAKE_CODEX_DEFAULT_POLICY: "never" });
});

test("accepts new-thread settings without a policy and passes through a chosen one", () => {
  const parsed = parseIdeClientMessage(JSON.stringify({ type: "send", requestId: "r1", text: "hi", newThreadParams: { cwd: "/x", approvalsReviewer: "user" } }));
  assert.deepEqual(parsed, { type: "send", requestId: "r1", text: "hi", newThreadParams: { cwd: "/x", preferIdeWorkspace: false, approvalsReviewer: "user" } });

  const wrong = parseIdeClientMessage(JSON.stringify({ type: "send", requestId: "r2", text: "hi", newThreadParams: { cwd: "/x", approvalsReviewer: "user", approvalPolicy: "never" } }));
  assert.equal(wrong?.type, "send");
});

test("follow-up relay turns stay in one conversation for the same folder", async () => {
  await withWrapper(async ({ directory }) => {
    const adapter = new CodexIdeAdapter({ socketDirectoryPath: directory, newThreadParams: USER_DEFAULT_PARAMS });
    const first = JSON.parse((await collect(adapter.run(adapterRequest("show-config"))))[0]?.text ?? "{}");
    const second = JSON.parse((await collect(adapter.run(adapterRequest("show-config"))))[0]?.text ?? "{}");
    assert.equal(first.threadId, second.threadId);
  });
});

// Regression: a thread made for an earlier folder was reused as "the IDE's thread" and kept
// swallowing turns, so Codex worked in an empty folder instead of the project.
test("a relay-made thread is not the IDE's thread and is not reused for another folder", async () => {
  await withWrapper(async ({ directory, extensionInput, extensionLines }) => {
    const adapter = new CodexIdeAdapter({ socketDirectoryPath: directory, newThreadParams: { ...USER_DEFAULT_PARAMS, preferIdeWorkspace: true } });
    const first = JSON.parse((await collect(adapter.run(adapterRequest("show-config"))))[0]?.text ?? "{}");
    assert.equal(first.cwd, "/tmp");

    // The IDE now reports its real project folder.
    sendFromExtension(extensionInput, { id: 9, method: "thread/list", params: { cwd: "/work/ide-project" } });
    await waitFor(() => extensionLines.length > 0);

    const second = JSON.parse((await collect(adapter.run(adapterRequest("show-config"))))[0]?.text ?? "{}");
    assert.equal(second.cwd, "/work/ide-project");
    assert.notEqual(second.threadId, first.threadId);
  });
});

async function openIdeThread(extensionInput: PassThrough, extensionLines: string[], turnOverrides: object = {}) {
  sendFromExtension(extensionInput, { id: 1, method: "initialize", params: { clientInfo: { name: "ext", version: "1" } } });
  sendFromExtension(extensionInput, { id: 2, method: "thread/start", params: {} });
  await waitFor(() => extensionLines.some((line) => line.includes("thread-1")));
  sendFromExtension(extensionInput, { id: 3, method: "turn/start", params: { threadId: "thread-1", input: [{ type: "text", text: "hi" }], ...turnOverrides } });
  await waitFor(() => extensionLines.some((line) => line.includes("turn/completed")));
}

test("sends into an IDE thread with its own approval settings", async () => {
  await withWrapper(async ({ directory, extensionInput, extensionLines }) => {
    await openIdeThread(extensionInput, extensionLines);
    const adapter = new CodexIdeAdapter({ socketDirectoryPath: directory, newThreadParams: USER_DEFAULT_PARAMS });
    const events = await collect(adapter.run(adapterRequest("hello")));
    assert.equal(events.at(-1)?.kind, "reply_complete");
  }, { FAKE_CODEX_DEFAULT_POLICY: "never" });
});

test("uses an IDE thread after its approval mode changes", async () => {
  await withWrapper(async ({ directory, extensionInput, extensionLines }) => {
    await openIdeThread(extensionInput, extensionLines, { approvalPolicy: "never" });
    const adapter = new CodexIdeAdapter({ socketDirectoryPath: directory, newThreadParams: USER_DEFAULT_PARAMS });
    const events = await collect(adapter.run(adapterRequest("hello")));
    assert.equal(events.at(-1)?.kind, "reply_complete");
  });
});

test("uses an IDE thread even when its settings were not observed", async () => {
  await withWrapper(async ({ directory, extensionInput, extensionLines }) => {
    sendFromExtension(extensionInput, { id: 3, method: "turn/start", params: { threadId: "thread-9", input: [{ type: "text", text: "hi" }] } });
    await waitFor(() => extensionLines.some((line) => line.includes("turn/completed")));
    const adapter = new CodexIdeAdapter({ socketDirectoryPath: directory, newThreadParams: USER_DEFAULT_PARAMS });
    const events = await collect(adapter.run(adapterRequest("hello")));
    assert.equal(events.at(-1)?.kind, "reply_complete");
  });
});

test("refuses a socket folder that other people can access", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cross-agent-mcp-bridge-open-"));
  try {
    await chmod(directory, 0o755);
    const adapter = new CodexIdeAdapter({ socketDirectoryPath: directory, newThreadParams: USER_DEFAULT_PARAMS });
    await assert.rejects(collect(adapter.run(adapterRequest("hi"))), /is not private/);
    assert.equal((await adapter.readStatus()).ideWrapperRunning, false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

