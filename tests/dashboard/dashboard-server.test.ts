import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AgentRoomManager } from "../../src/bridge/agent-room-manager.js";
import { ApprovalQueue } from "../../src/bridge/approval-queue.js";
import { CoordinationService } from "../../src/bridge/coordination-service.js";
import { DashboardServer } from "../../src/dashboard/dashboard-server.js";

test("dashboard serves the project snapshot and approval decisions", async () => {
  const targetRepositoryPath = await mkdtemp(join(tmpdir(), "relay-dashboard-"));
  const roomManager = new AgentRoomManager({ targetRepositoryPath, sessionId: "session-current", roomName: "backend" });
  await roomManager.createRoom("backend");
  await roomManager.joinRoom("backend", "claude");
  await roomManager.createTask("backend", "Implement authentication", { assignedTo: "claude" });
  const approvalQueue = new ApprovalQueue();
  const approval = approvalQueue.requestApproval({ kind: "command", summary: "Run the project tests", detailLines: ["npm test"] }, new AbortController().signal);
  const dashboard = new DashboardServer({
    targetRepositoryPath,
    roomId: "backend",
    mcpUrl: "http://127.0.0.1:38765/mcp",
    agentRegistry: { agentInfos: [], adapters: new Map(), unavailableAgents: [] } as never,
    bridgeService: { getLiveActivity: () => ({ agentName: null, phase: "idle" }), subscribeActivity: () => () => undefined } as never,
    approvalQueue,
    roomManager,
    coordinationService: new CoordinationService({ targetRepositoryPath }),
    port: 0,
  });

  try {
    await dashboard.listen();
    const snapshot = await fetch(`${dashboard.url}/api/dashboard`);
    const data = await snapshot.json() as { diagnostics: { dashboardUrl: string }; tasks: Array<{ assignedTo: string }> ; approvals: Array<{ approvalId: string }> };
    const baseUrl = data.diagnostics.dashboardUrl;
    const page = await fetch(baseUrl);
    assert.match(await page.text(), /Cross-Agent-Mcp-Bridge/);
    const response = await fetch(`${baseUrl}/api/dashboard`);
    const refreshed = await response.json() as typeof data;
    assert.equal(refreshed.tasks[0]?.assignedTo, "claude");
    assert.equal(refreshed.approvals[0]?.approvalId, data.approvals[0]?.approvalId);

    const stream = await fetch(`${baseUrl}/api/events`);
    const reader = stream.body!.getReader();
    const decoder = new TextDecoder();
    assert.match(decoder.decode((await reader.read()).value), /dashboard\.invalidate/);
    await roomManager.sendRoomMessage("backend", "Architecture notes are updated.");
    assert.match(decoder.decode((await reader.read()).value), /room\.message\.received/);
    await reader.cancel();

    const decision = await fetch(`${baseUrl}/api/approvals/${refreshed.approvals[0]!.approvalId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ decision: "accept" }),
    });
    assert.equal(decision.status, 200);
    assert.equal(await approval, "accept");

    // Test creating a task via POST /api/tasks
    const createTaskRes = await fetch(`${baseUrl}/api/tasks`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Refactor database migrations", assignedTo: "claude" }),
    });
    assert.equal(createTaskRes.status, 200);
    const createdData = await createTaskRes.json() as { success: boolean; task: { taskId: string } };
    assert.equal(createdData.success, true);
    assert.ok(createdData.task.taskId);

    // Test updating task status via PATCH /api/tasks/:taskId
    const updateTaskRes = await fetch(`${baseUrl}/api/tasks/${createdData.task.taskId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "in_progress" }),
    });
    assert.equal(updateTaskRes.status, 200);

    // Test sending a room note via POST /api/messages
    const sendMsgRes = await fetch(`${baseUrl}/api/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "Task is now in progress" }),
    });
    assert.equal(sendMsgRes.status, 200);
  } finally {
    await dashboard.close();
    await rm(targetRepositoryPath, { recursive: true, force: true });
  }
});

test("dashboard reports an uninitialized room without creating it", async () => {
  const targetRepositoryPath = await mkdtemp(join(tmpdir(), "relay-dashboard-empty-"));
  const roomManager = new AgentRoomManager({ targetRepositoryPath, sessionId: "session-current", roomName: "backend" });
  const dashboard = new DashboardServer({
    targetRepositoryPath,
    roomId: "backend",
    mcpUrl: "http://127.0.0.1:38765/mcp",
    agentRegistry: { agentInfos: [], adapters: new Map(), unavailableAgents: [] } as never,
    bridgeService: { getLiveActivity: () => ({ agentName: null, phase: "idle" }), subscribeActivity: () => () => undefined } as never,
    approvalQueue: new ApprovalQueue(),
    roomManager,
    coordinationService: new CoordinationService({ targetRepositoryPath }),
    port: 0,
  });

  try {
    await dashboard.listen();
    const response = await fetch(`${dashboard.url}/api/dashboard`);
    const data = await response.json() as { roomId?: string; tasks: unknown[]; diagnostics: { roomExists: boolean; roomPath: string } };
    assert.equal(data.roomId, undefined);
    assert.deepEqual(data.tasks, []);
    assert.equal(data.diagnostics.roomExists, false);
    assert.match(data.diagnostics.roomPath, /\.agent-room[/\\]rooms[/\\]backend$/);
    await assert.rejects(stat(join(targetRepositoryPath, ".agent-room")), { code: "ENOENT" });
  } finally {
    await dashboard.close();
    await rm(targetRepositoryPath, { recursive: true, force: true });
  }
});

test("dashboard refuses cross-site and non-JSON writes", async () => {
  const targetRepositoryPath = await mkdtemp(join(tmpdir(), "relay-dashboard-guard-"));
  const roomManager = new AgentRoomManager({ targetRepositoryPath, sessionId: "session-guard", roomName: "backend" });
  let dispatched = false;
  const dashboard = new DashboardServer({
    targetRepositoryPath,
    roomId: "backend",
    mcpUrl: "http://127.0.0.1:38765/mcp",
    agentRegistry: { agentInfos: [], adapters: new Map(), unavailableAgents: [] } as never,
    bridgeService: { getLiveActivity: () => ({ agentName: null, phase: "idle" }), subscribeActivity: () => () => undefined, async *handleUserInput() { dispatched = true; } } as never,
    approvalQueue: new ApprovalQueue(),
    roomManager,
    coordinationService: new CoordinationService({ targetRepositoryPath }),
    port: 0,
  });
  try {
    await dashboard.listen();
    const body = JSON.stringify({ text: "@codex hello" });
    const crossSite = await fetch(`${dashboard.url}/api/dispatch`, { method: "POST", headers: { "Content-Type": "application/json", Origin: "https://evil.example" }, body });
    assert.equal(crossSite.status, 403);
    const plainText = await fetch(`${dashboard.url}/api/dispatch`, { method: "POST", headers: { "Content-Type": "text/plain" }, body });
    assert.equal(plainText.status, 415);
    assert.equal(dispatched, false);
    assert.equal((await fetch(`${dashboard.url}/api/dashboard`, { headers: { Origin: dashboard.url } })).status, 200);
  } finally {
    await dashboard.close();
    await rm(targetRepositoryPath, { recursive: true, force: true });
  }
});
