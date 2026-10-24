// Proves the log keeps events in order, survives a half-written last line, and is owner-only
// (it may hold sensitive messages).
import assert from "node:assert/strict";
import { appendFile, mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { EventLogService } from "../../src/bridge/event-log-service.js";

const baseInput = {
  conversationId: "c-1",
  requestToken: "r-1",
  from: "human",
  to: "echo",
} as const;

// Uses a temporary log folder, deleted afterward.
async function withLogDirectory(run: (logDirectoryPath: string) => Promise<void>) {
  const logDirectoryPath = await mkdtemp(join(tmpdir(), "cross-agent-mcp-bridge-log-"));
  try {
    await run(join(logDirectoryPath, "log"));
  } finally {
    await rm(logDirectoryPath, { recursive: true, force: true });
  }
}

test("appends events in order with increasing serverSequence", async () => {
  await withLogDirectory(async (logDirectoryPath) => {
    const eventLog = new EventLogService({ logDirectoryPath });
    // Started together on purpose; sequence numbers must still be 1, 2, 3.
    await Promise.all([
      eventLog.append({ ...baseInput, kind: "user_message", text: "first" }),
      eventLog.append({ ...baseInput, kind: "reply_delta", text: "second" }),
      eventLog.append({ ...baseInput, kind: "reply_complete", text: "third" }),
    ]);

    const events = await eventLog.readConversation("c-1");
    assert.deepEqual(events.map((event) => event.serverSequence), [1, 2, 3]);
    assert.deepEqual(events.map((event) => event.text), ["first", "second", "third"]);
  });
});

test("skips a truncated last line when reading back", async () => {
  await withLogDirectory(async (logDirectoryPath) => {
    const eventLog = new EventLogService({ logDirectoryPath });
    await eventLog.append({ ...baseInput, kind: "user_message", text: "kept" });
    const [fileName] = await readdir(logDirectoryPath);
    // Simulates a crash mid-write: the JSON line stops halfway.
    await appendFile(join(logDirectoryPath, fileName ?? ""), '{"serverSequence":2,"tex');

    const events = await eventLog.readConversation("c-1");
    assert.deepEqual(events.map((event) => event.text), ["kept"]);
  });
});

test("log files are owner-only", async () => {
  await withLogDirectory(async (logDirectoryPath) => {
    const eventLog = new EventLogService({ logDirectoryPath });
    await eventLog.append({ ...baseInput, kind: "user_message", text: "x" });
    const [fileName] = await readdir(logDirectoryPath);
    const fileStat = await stat(join(logDirectoryPath, fileName ?? ""));
    // 0o077 covers group and other permission bits; none may be set.
    assert.equal(fileStat.mode & 0o077, 0);
  });
});
