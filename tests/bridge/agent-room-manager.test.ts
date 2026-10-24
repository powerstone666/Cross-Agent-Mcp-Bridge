import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { AgentRoomManager } from "../../src/bridge/agent-room-manager.js";

test("room discovery does not create room files and missing-room errors give the creation path", async () => {
  const repositoryPath = await mkdtemp(join(tmpdir(), "relay-room-discovery-"));
  try {
    const manager = new AgentRoomManager({ targetRepositoryPath: repositoryPath, sessionId: "session-one", roomName: "backend" });
    assert.deepEqual(await manager.listRooms(), []);
    await assert.rejects(stat(join(repositoryPath, ".agent-room")), { code: "ENOENT" });
    await assert.rejects(manager.getRoomContext("backend"), /create_room.*\.agent-room[/\\]rooms[/\\]backend/);
    assert.deepEqual(await manager.listRooms(), []);
    await assert.rejects(stat(join(repositoryPath, ".agent-room")), { code: "ENOENT" });
  } finally {
    await rm(repositoryPath, { recursive: true, force: true });
  }
});

test("onboarding returns room guidance, knowledge, decisions, and assigned tasks", async () => {
  const repositoryPath = await mkdtemp(join(tmpdir(), "relay-room-onboarding-"));
  try {
    const manager = new AgentRoomManager({ targetRepositoryPath: repositoryPath, sessionId: "session-one", participantId: "cross-agent-mcp-bridge", roomName: "backend" });
    await manager.createRoom("backend");
    await manager.joinRoom("backend", "claude");
    await manager.publishKnowledge("backend", "Authentication uses short-lived access tokens.");
    await manager.publishDecision("backend", "JWT strategy", "Use rotating refresh tokens.");
    const task = await manager.createTask("backend", "Implement authentication", { assignedTo: "claude", files: ["src/auth.ts"] });
    const onboarding = await manager.getRoomOnboarding("backend", "claude") as { room: string; knowledge: unknown[]; decisions: unknown[]; assignedTasks: Array<{ taskId: string; files: string[] }> };
    assert.match(onboarding.room, /Agent room: backend/);
    assert.equal(onboarding.knowledge.length, 1);
    assert.equal(onboarding.decisions.length, 1);
    assert.equal(onboarding.assignedTasks[0]?.taskId, task.taskId);
    assert.deepEqual(onboarding.assignedTasks[0]?.files, ["src/auth.ts"]);
    assert.equal((await manager.listRoomMembers("backend")).find((member) => member.participantId === "claude")?.connectionStatus, "connected");
  } finally {
    await rm(repositoryPath, { recursive: true, force: true });
  }
});

test("room persists one coordinator and identifies its workers", async () => {
  const repositoryPath = await mkdtemp(join(tmpdir(), "relay-room-coordinator-"));
  try {
    const manager = new AgentRoomManager({ targetRepositoryPath: repositoryPath, sessionId: "session-one", coordinatorId: "codex" });
    await manager.createRoom("backend");
    await manager.joinRoom("backend", "codex");
    await manager.joinRoom("backend", "claude");
    const members = await manager.listRoomMembers("backend");
    assert.equal(members.find((member) => member.participantId === "codex")?.role, "coordinator");
    assert.equal(members.find((member) => member.participantId === "claude")?.coordinator, "codex");
    const onboarding = await manager.getRoomOnboarding("backend", "claude") as { role: string; coordinator: string; room: string };
    assert.equal(onboarding.role, "worker");
    assert.equal(onboarding.coordinator, "codex");
    assert.match(onboarding.room, /- Coordinator: codex/);
  } finally {
    await rm(repositoryPath, { recursive: true, force: true });
  }
});

test("creating a room records the relay coordinator once and preserves it on later creates", async () => {
  const repositoryPath = await mkdtemp(join(tmpdir(), "relay-room-coordinator-once-"));
  try {
    const manager = new AgentRoomManager({ targetRepositoryPath: repositoryPath, sessionId: "session-one", coordinatorId: "alpha" });
    await manager.createRoom("backend");
    const restarted = new AgentRoomManager({ targetRepositoryPath: repositoryPath, sessionId: "session-two", coordinatorId: "beta" });
    await restarted.createRoom("backend", repositoryPath, "beta");
    const room = await readFile(join(repositoryPath, ".agent-room/rooms/backend/ROOM.md"), "utf8");
    assert.deepEqual(room.match(/^- Coordinator: .+$/gm), ["- Coordinator: alpha"]);
  } finally {
    await rm(repositoryPath, { recursive: true, force: true });
  }
});

test("serializes task status and assignment updates and publishes concise room events", async () => {
  const repositoryPath = await mkdtemp(join(tmpdir(), "relay-room-events-"));
  try {
    const manager = new AgentRoomManager({ targetRepositoryPath: repositoryPath, sessionId: "session", roomName: "backend" });
    await manager.createRoom("backend");
    await manager.joinRoom("backend");
    const events: string[] = [];
    const unsubscribe = manager.subscribe((event) => events.push(event.type));
    const task = await manager.createTask("backend", "Review API", { files: ["src/api.ts"] });
    await Promise.all([
      manager.updateTask("backend", task.taskId, "Added endpoint tests"),
      manager.assignTask("backend", task.taskId, "codex"),
    ]);
    assert.match(await readFile(join(repositoryPath, ".agent-room/rooms/backend/TASKS.md"), "utf8"), /\(codex\): Review API/);
    await manager.setTaskStatus("backend", task.taskId, "review");
    unsubscribe();
    const current = (await manager.listRoomTasks("backend"))[0];
    assert.equal(current?.status, "review");
    assert.equal(current?.assignedTo, "codex");
    assert.match(current?.content ?? "", /Added endpoint tests/);
    assert.deepEqual(events, ["room.task.created", "room.task.updated", "room.task.updated", "room.task.updated"]);
    const taskIndex = await readFile(join(repositoryPath, ".agent-room/rooms/backend/TASKS.md"), "utf8");
    assert.match(taskIndex, /## Open[\s\S]*## Done/);
    assert.match(taskIndex, /task-.*\(codex\): Review API/);
    assert.match((await manager.listRoomEvents("backend")).at(-1)?.summary ?? "", /review/);
  } finally {
    await rm(repositoryPath, { recursive: true, force: true });
  }
});

test("old joined sessions are shown as interrupted and never resumed", async () => {
  const repositoryPath = await mkdtemp(join(tmpdir(), "relay-room-recovery-"));
  try {
    const previous = new AgentRoomManager({ targetRepositoryPath: repositoryPath, sessionId: "old-session", roomName: "backend" });
    await previous.createRoom("backend");
    await previous.joinRoom("backend", "codex");
    const restarted = new AgentRoomManager({ targetRepositoryPath: repositoryPath, sessionId: "new-session", roomName: "backend" });
    assert.equal((await restarted.listRoomMembers("backend")).find((member) => member.participantId === "codex")?.connectionStatus, "interrupted");
    await restarted.joinRoom("backend", "codex");
    assert.ok((await restarted.listRoomMembers("backend")).some((member) => member.participantId === "codex" && member.sessionId === "new-session" && member.connectionStatus === "connected"));
  } finally {
    await rm(repositoryPath, { recursive: true, force: true });
  }
});

test("leaving one session keeps a participant connected through another session", async () => {
  const repositoryPath = await mkdtemp(join(tmpdir(), "relay-room-multi-session-"));
  try {
    const manager = new AgentRoomManager({ targetRepositoryPath: repositoryPath, sessionId: "host-session", roomName: "backend" });
    await manager.createRoom("backend");
    await manager.joinRoom("backend", "codex", "codex-window-one");
    await manager.joinRoom("backend", "codex", "codex-window-two");
    await manager.leaveRoom("backend", "codex", "codex-window-one");
    const sessions = await manager.listRoomMembers("backend");
    assert.deepEqual(sessions.filter((member) => member.participantId === "codex").map((member) => member.connectionStatus), ["left", "connected"]);
  } finally {
    await rm(repositoryPath, { recursive: true, force: true });
  }
});

test("recent events and messages are read from the end of large logs", async () => {
  const directory = await mkdtemp(join(tmpdir(), "relay-tail-"));
  try {
    const manager = new AgentRoomManager({ targetRepositoryPath: directory, sessionId: "tail", roomName: "backend" });
    await manager.createRoom("backend");
    const { eventsPath, messagesPath } = { eventsPath: join(directory, ".agent-room/rooms/backend/events.jsonl"), messagesPath: join(directory, ".agent-room/rooms/backend/messages.jsonl") };
    // Well over one 64 KiB read chunk, so the backwards read must cross chunk borders.
    const padding = "x".repeat(200);
    const events = Array.from({ length: 2000 }, (_, index) => JSON.stringify({ id: `e${index}`, roomId: "backend", type: "room.message.received", actor: "a", summary: padding, timestamp: "t" }));
    await writeFile(eventsPath, `${events.join("\n")}\n`);
    await writeFile(messagesPath, `${Array.from({ length: 2000 }, (_, index) => JSON.stringify({ message: `m${index}${padding}` })).join("\n")}\n`);
    const recent = await manager.listRoomEvents("backend", 5);
    assert.deepEqual(recent.map((event) => event.id), ["e1995", "e1996", "e1997", "e1998", "e1999"]);
    const context = await manager.getRoomContext("backend") as { recentMessages: Array<{ message: string }> };
    assert.equal(context.recentMessages.length, 50);
    assert.match(context.recentMessages.at(-1)!.message, /^m1999/);
    assert.match(context.recentMessages[0]!.message, /^m1950/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
