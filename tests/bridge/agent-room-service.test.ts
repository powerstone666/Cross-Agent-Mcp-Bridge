import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { AgentRoomService } from "../../src/bridge/agent-room-service.js";
import type { RelayEvent } from "../../src/bridge/types/relay-event.js";

const event = (overrides: Partial<RelayEvent> = {}): RelayEvent => ({
  serverSequence: 1,
  timestamp: "2026-10-23T12:00:00.000Z",
  conversationId: "relay-session-1",
  requestToken: "request-1",
  kind: "user_message",
  from: "human",
  to: "claude",
  text: "hello\nfrom the room",
  ...overrides,
});

test("creates the configured room layout and session identities", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cross-agent-mcp-bridge-room-"));
  try {
    const room = new AgentRoomService({
      targetRepositoryPath: directory,
      roomName: "backend",
      sessionId: "relay-session-1",
      participants: ["human", "claude", "codex"],
      startedAt: "2026-10-23T12:00:00.000Z",
    });
    await room.initialize();
    await room.append(event());
    await room.append(event({ serverSequence: 2, kind: "reply_delta", from: "claude", to: "human", text: "Hi there" }));

    const paths = room.pathsForRoom;
    assert.match(await readFile(paths.configPath, "utf8"), /default_room: backend/);
    const roomMarkdown = await readFile(paths.roomMarkdownPath, "utf8");
    assert.match(roomMarkdown, /Relay session ID: `relay-session-1`/);
    assert.match(roomMarkdown, /claude — session `relay-session-1`/);
    const messages = (await readFile(paths.messagesPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
    assert.equal(messages.length, 2);
    assert.equal(messages[0]?.room, "backend");
    assert.equal(messages[1]?.kind, "reply_delta");
    assert.match(await readFile(join(paths.participantsDirectoryPath, "claude.md"), "utf8"), /Hi there/);
    assert.deepEqual((await readdir(paths.roomDirectoryPath)).sort(), ["ROOM.md", "TASKS.md", "decisions", "events.jsonl", "knowledge", "members.jsonl", "messages.jsonl", "participants", "tasks"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("keeps room files private", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cross-agent-mcp-bridge-room-mode-"));
  try {
    const room = new AgentRoomService({ targetRepositoryPath: directory, sessionId: "session" });
    await room.append(event());
    const messageStat = await stat(room.pathsForRoom.messagesPath);
    assert.equal(messageStat.mode & 0o077, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("adds later relay sessions to the same room metadata", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cross-agent-mcp-bridge-room-sessions-"));
  try {
    const first = new AgentRoomService({ targetRepositoryPath: directory, roomName: "backend", sessionId: "session-one", participants: ["human"] });
    const second = new AgentRoomService({ targetRepositoryPath: directory, roomName: "backend", sessionId: "session-two", participants: ["human"] });
    await first.initialize();
    await second.initialize();
    assert.match(await readFile(second.pathsForRoom.configPath, "utf8"), /- backend/);
    const room = await readFile(second.pathsForRoom.roomMarkdownPath, "utf8");
    const human = await readFile(join(second.pathsForRoom.participantsDirectoryPath, "human.md"), "utf8");
    assert.match(room, /session-one/);
    assert.match(room, /session-two/);
    assert.match(human, /session-one/);
    assert.match(human, /session-two/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
