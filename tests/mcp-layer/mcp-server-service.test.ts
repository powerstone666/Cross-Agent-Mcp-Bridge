// Proves the MCP tools work for any agent, using fake agents and an in-memory transport.
// A wrong agent name must fail with the list of valid names and never reach an adapter.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { createAgentRegistry } from "../../src/bridge/agent-registry.js";
import { EventLogService } from "../../src/bridge/event-log-service.js";
import { McpServerService } from "../../src/mcp-layer/mcp-server-service.js";
import { BridgeService } from "../../src/bridge/bridge-service.js";
import { AgentRoomManager } from "../../src/bridge/agent-room-manager.js";
import type { AgentAdapter } from "../../src/bridge/types/agent-adapter.js";
import {
  createFakeAgentModule,
  createReplyingAdapter,
} from "../fixtures/create-fake-agent-module.js";

// Real MCP server and client over an in-memory transport; agent "gamma" fails to start on purpose.
async function withClient(run: (client: Client, directory: string) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), "cross-agent-mcp-bridge-mcp-"));
  const replyingAdapter = createReplyingAdapter("alpha says");
  const alphaAdapter: AgentAdapter = {
    ...replyingAdapter,
    async *run(request) {
      if (request.messageText === "needs-approval") {
        const decision = await request.requestApproval({ kind: "command", summary: "Run a command", detailLines: ["echo hello"] });
        yield { kind: "reply_delta", text: `decision: ${decision}` };
        yield { kind: "reply_complete", text: "" };
        return;
      }
      if (request.messageText.startsWith("You are invited")) yield { kind: "reply_delta", text: `[cwd ${request.workingDirectory}] ` };
      yield* replyingAdapter.run(request);
    },
  };
  const agentRegistry = createAgentRegistry({
    modules: [
      createFakeAgentModule({ agentName: "alpha", adapter: alphaAdapter }),
      createFakeAgentModule({ agentName: "beta", adapter: createReplyingAdapter("beta says") }),
      createFakeAgentModule({ agentName: "gamma", failureMessage: "gamma is not installed" }),
    ],
    environment: {},
    targetRepositoryPath: directory,
    humanApprovalChannel: "agent-ui",
  });
  // The test has no dashboard, so its approval callback declines explicitly.
  const bridgeService = new BridgeService({
    adapters: agentRegistry.adapters,
    eventLog: new EventLogService({ logDirectoryPath: join(directory, "log") }),
    approvalPrompter: { requestApproval: async () => "decline" },
    conversationId: "c-mcp",
    workingDirectory: directory,
  });
  const service = new McpServerService({
    bridgeService,
    agentRegistry,
    relayInfo: { targetRepository: directory },
    roomManager: new AgentRoomManager({ targetRepositoryPath: directory, sessionId: "c-mcp", participantId: "test-agent", coordinatorId: "alpha" }),
  });

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-agent", version: "1" });
  await Promise.all([service.server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    await run(client, directory);
  } finally {
    await client.close();
    await service.close();
    await rm(directory, { recursive: true, force: true });
  }
}

function textOf(result: unknown): string {
  const content = (result as { content: Array<{ type: string; text: string }> }).content;
  return content.map((part) => part.text).join("");
}

test("exposes agent-neutral tools", async () => {
  await withClient(async (client) => {
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map((tool) => tool.name).sort(), ["assign_task", "create_room", "create_task", "get_room_context", "get_room_onboarding", "get_room_setup", "get_skill", "invite_to_room", "join_room", "leave_room", "list_agents", "list_invitable_agents", "list_room_decisions", "list_room_members", "list_room_tasks", "list_rooms", "list_skills", "publish_decision", "publish_knowledge", "relay_status", "search_knowledge", "send_room_message", "send_to_agent", "set_task_status", "update_task"]);
  });
});

test("serves skill guides to the model", async () => {
  await withClient(async (client) => {
    const { skills } = JSON.parse(textOf(await client.callTool({ name: "list_skills", arguments: {} }))) as { skills: Array<{ name: string }> };
    assert.deepEqual(skills.map((skill) => skill.name), ["guide", "rooms", "tools"]);
    assert.match(textOf(await client.callTool({ name: "get_skill", arguments: { name: "rooms" } })), /^# Rooms and shared project work/);
    const missing = await client.callTool({ name: "get_skill", arguments: { name: "../package" } });
    assert.equal(missing.isError, true);
    assert.match(textOf(missing), /Available: guide, rooms, tools/);
  });
});

test("room setup points agents to explicit creation when no room exists", async () => {
  await withClient(async (client, directory) => {
    const setup = JSON.parse(textOf(await client.callTool({ name: "get_room_setup", arguments: { targetRepositoryPath: directory } }))) as {
      rooms: unknown[]; roomsDirectoryPath: string; suggestedRoomId: string; suggestedRoomPath: string; nextStep: string;
    };
    assert.deepEqual(setup.rooms, []);
    assert.match(setup.roomsDirectoryPath, /\.agent-room[/\\]rooms$/);
    assert.equal(setup.suggestedRoomId, "backend");
    assert.match(setup.suggestedRoomPath, /\.agent-room[/\\]rooms[/\\]backend$/);
    assert.match(setup.nextStep, /create_room/);
    const created = JSON.parse(textOf(await client.callTool({ name: "create_room", arguments: { name: setup.suggestedRoomId, targetRepositoryPath: directory } }))) as { path: string; joined: boolean; roomId: string };
    assert.equal(created.path, setup.suggestedRoomPath);
    assert.equal(created.joined, false);
    assert.deepEqual(JSON.parse(textOf(await client.callTool({ name: "list_room_members", arguments: { roomId: created.roomId } }))), []);
    const context = JSON.parse(textOf(await client.callTool({ name: "get_room_context", arguments: { roomId: created.roomId } }))) as { room: string };
    assert.match(context.room, /^- Coordinator: alpha$/m);
  });
});

test("create_room joins an optional creator and records the normalized coordinator", async () => {
  await withClient(async (client, directory) => {
    const created = JSON.parse(textOf(await client.callTool({ name: "create_room", arguments: { name: "backend", targetRepositoryPath: directory, participantId: "  Lead Agent  " } }))) as { roomId: string; path: string; joined: boolean };
    assert.equal(created.joined, true);
    const members = JSON.parse(textOf(await client.callTool({ name: "list_room_members", arguments: { roomId: created.roomId } }))) as Array<{ participantId: string; role: string; connectionStatus: string }>;
    assert.equal(members.length, 1);
    assert.deepEqual([members[0]?.participantId, members[0]?.role, members[0]?.connectionStatus], ["lead-agent", "coordinator", "connected"]);
    const onboarding = JSON.parse(textOf(await client.callTool({ name: "get_room_onboarding", arguments: { roomId: created.roomId, participantId: "Lead Agent" } }))) as { room: string; role: string };
    assert.equal(onboarding.role, "coordinator");
    assert.match(onboarding.room, /^- Coordinator: lead-agent$/m);
  });
});

test("room tools manage shared context, tasks, knowledge, and messages", async () => {
  await withClient(async (client, directory) => {
    const created = JSON.parse(textOf(await client.callTool({ name: "create_room", arguments: { name: "Backend", targetRepositoryPath: directory } })));
    assert.match(created.roomId, /^backend$/);
    const task = JSON.parse(textOf(await client.callTool({ name: "create_task", arguments: { roomId: "backend", task: "Add auth" } })));
    const listed = JSON.parse(textOf(await client.callTool({ name: "list_room_tasks", arguments: { roomId: "backend" } })));
    assert.equal(listed[0].taskId, task.taskId);
    await client.callTool({ name: "assign_task", arguments: { roomId: "backend", taskId: task.taskId, assignedTo: "alpha" } });
    await client.callTool({ name: "set_task_status", arguments: { roomId: "backend", taskId: task.taskId, status: "in_progress" } });
    await client.callTool({ name: "update_task", arguments: { roomId: "backend", taskId: task.taskId, update: "Started" } });
    await client.callTool({ name: "publish_knowledge", arguments: { roomId: "backend", content: "Use JWT" } });
    const hits = JSON.parse(textOf(await client.callTool({ name: "search_knowledge", arguments: { roomId: "backend", query: "jwt" } })));
    assert.equal(hits.length, 1);
    await client.callTool({ name: "publish_decision", arguments: { roomId: "backend", title: "Auth tokens", content: "Use short-lived JWTs." } });
    const decisions = JSON.parse(textOf(await client.callTool({ name: "list_room_decisions", arguments: { roomId: "backend" } })));
    assert.equal(decisions.length, 1);
    await client.callTool({ name: "join_room", arguments: { roomId: "backend", participantId: "alpha" } });
    const onboarding = JSON.parse(textOf(await client.callTool({ name: "get_room_onboarding", arguments: { roomId: "backend", participantId: "alpha" } })));
    assert.equal(onboarding.assignedTasks[0].taskId, task.taskId);
    assert.equal(onboarding.decisions.length, 1);
    await client.callTool({ name: "send_room_message", arguments: { roomId: "backend", message: "hello" } });
    const context = JSON.parse(textOf(await client.callTool({ name: "get_room_context", arguments: { roomId: "backend" } })));
    assert.equal(context.recentMessages.at(-1).message, "hello");
    const resource = await client.readResource({ uri: "cross-agent-mcp-bridge://rooms/events" });
    const firstContent = resource.contents[0];
    assert.ok(firstContent && "text" in firstContent);
    assert.match(firstContent.text, /room.task.created/);
  });
});

test("send_to_agent routes to whichever agent is named", async () => {
  await withClient(async (client) => {
    const toAlpha = await client.callTool({ name: "send_to_agent", arguments: { agent: "alpha", message: "hi" } });
    const toBeta = await client.callTool({ name: "send_to_agent", arguments: { agent: "beta", message: "hi" } });
    assert.equal(textOf(toAlpha), "alpha says: hi");
    assert.equal(textOf(toBeta), "beta says: hi");
  });
});

test("send_to_agent automatically accepts downstream actions by default", async () => {
  await withClient(async (client) => {
    const result = await client.callTool({ name: "send_to_agent", arguments: { agent: "alpha", message: "needs-approval" } });
    assert.equal(textOf(result), "decision: accept");
  });
});

test("send_to_agent can explicitly request human review", async () => {
  await withClient(async (client) => {
    const result = await client.callTool({ name: "send_to_agent", arguments: { agent: "alpha", message: "needs-approval", requireHumanApproval: true } });
    assert.equal(textOf(result), "decision: decline");
  });
});

test("send_to_agent refuses unknown or unavailable agents and lists the available ones", async () => {
  await withClient(async (client) => {
    // "nobody" was never registered; "gamma" failed to start. Both must be refused.
    for (const agent of ["nobody", "gamma"]) {
      const result = await client.callTool({ name: "send_to_agent", arguments: { agent, message: "hi" } });
      assert.equal(result.isError, true);
      assert.match(textOf(result), /Available: alpha, beta/);
    }
  });
});

test("list_agents and relay_status report every agent, including unavailable ones", async () => {
  await withClient(async (client) => {
    const listed = JSON.parse(textOf(await client.callTool({ name: "list_agents", arguments: {} })));
    assert.deepEqual(listed.agents.map((agent: { agentName: string }) => agent.agentName), ["alpha", "beta"]);
    assert.deepEqual(listed.agents.map((agent: { role: string; coordinator: string | null }) => [agent.role, agent.coordinator]), [["coordinator", null], ["worker", "alpha"]]);
    assert.deepEqual(listed.unavailableAgents, [{ agentName: "gamma", reason: "gamma is not installed" }]);

    const status = JSON.parse(textOf(await client.callTool({ name: "relay_status", arguments: {} })));
    assert.deepEqual(status.agents.map((agent: { status: unknown }) => agent.status), [{ prefix: "alpha says" }, { prefix: "beta says" }]);
  });
});

async function waitForRoomMessage(client: Client, roomId: string, pattern: RegExp) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const context = JSON.parse(textOf(await client.callTool({ name: "get_room_context", arguments: { roomId } }))) as { recentMessages: Array<{ participantId: string; message: string }> };
    const found = context.recentMessages.find((message) => pattern.test(message.message));
    if (found) return found;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`no room message matched ${pattern}`);
}

test("invite_to_room returns once the agent starts and posts its reply in the room", async () => {
  await withClient(async (client, directory) => {
    await client.callTool({ name: "create_room", arguments: { name: "backend", targetRepositoryPath: directory } });
    const invited = JSON.parse(textOf(await client.callTool({ name: "invite_to_room", arguments: { roomId: "backend", agent: "alpha" } }))) as { joined: boolean; status: string; next: string; reply?: string; taskId?: string };
    // The relay records membership on invite, so the agent is a member even though the fake agent cannot call join_room.
    assert.equal(invited.joined, true);
    assert.equal(invited.taskId, undefined);
    assert.equal(invited.status, "started");
    assert.equal(invited.reply, undefined);
    assert.match(invited.next, /get_room_context/);
    assert.deepEqual(JSON.parse(textOf(await client.callTool({ name: "list_room_tasks", arguments: { roomId: "backend" } }))), []);
    await waitForRoomMessage(client, "backend", /@alpha you are invited/);
    const finished = await waitForRoomMessage(client, "backend", /^Finished: .*alpha says/);
    assert.equal(finished.participantId, "alpha");
    const unknown = await client.callTool({ name: "invite_to_room", arguments: { roomId: "backend", agent: "nobody" } });
    assert.equal(unknown.isError, true);
  });
});

test("invite_to_room creates an assigned task before waking the agent", async () => {
  await withClient(async (client, directory) => {
    await client.callTool({ name: "create_room", arguments: { name: "backend", targetRepositoryPath: directory } });
    const invited = JSON.parse(textOf(await client.callTool({ name: "invite_to_room", arguments: { roomId: "backend", agent: "alpha", task: "Review the API", note: "Check error handling.", waitForReply: true } }))) as { taskId: string; reply: string; joined: boolean };
    assert.match(invited.taskId, /^task-/);
    assert.equal(invited.joined, true);
    const tasks = JSON.parse(textOf(await client.callTool({ name: "list_room_tasks", arguments: { roomId: "backend" } }))) as Array<{ taskId: string; assignedTo: string; status: string; content: string }>;
    assert.equal(tasks.length, 1);
    assert.deepEqual([tasks[0]?.taskId, tasks[0]?.assignedTo, tasks[0]?.status], [invited.taskId, "alpha", "open"]);
    assert.match(tasks[0]?.content ?? "", /Review the API/);
    const context = JSON.parse(textOf(await client.callTool({ name: "get_room_context", arguments: { roomId: "backend" } }))) as { recentMessages: Array<{ message: string }> };
    const invitation = context.recentMessages.find((message) => message.message.includes("you are invited"))?.message ?? "";
    for (const text of [invitation, invited.reply]) {
      assert.match(text, new RegExp(invited.taskId));
      for (const tool of ["get_room_onboarding", "set_task_status", "update_task", "publish_knowledge", "publish_decision"]) assert.match(text, new RegExp(tool));
      assert.match(text, /in_progress/);
      assert.match(text, /review or done/);
    }
  });
});

test("invite_to_room runs the agent in the room's own repository", async () => {
  await withClient(async (client, directory) => {
    const otherRepository = await mkdtemp(join(tmpdir(), "cross-agent-mcp-bridge-other-"));
    try {
      const room = JSON.parse(textOf(await client.callTool({ name: "create_room", arguments: { name: "frontend", targetRepositoryPath: otherRepository } }))) as { roomId: string };
      assert.notEqual(otherRepository, directory);
      const invited = JSON.parse(textOf(await client.callTool({ name: "invite_to_room", arguments: { roomId: room.roomId, agent: "alpha", waitForReply: true } }))) as { reply: string };
      assert.ok(invited.reply.includes(`[cwd ${otherRepository}]`), invited.reply);
    } finally {
      await rm(otherRepository, { recursive: true, force: true });
    }
  });
});

test("list_invitable_agents reports room membership status and invitable flag", async () => {
  await withClient(async (client, directory) => {
    await client.callTool({ name: "create_room", arguments: { name: "backend", targetRepositoryPath: directory } });

    // 1. Initial state: neither alpha nor beta has joined
    const initial = JSON.parse(textOf(await client.callTool({ name: "list_invitable_agents", arguments: { roomId: "backend" } }))) as Array<{
      agent: string;
      status: string;
      invitable: boolean;
    }>;
    assert.deepEqual(initial, [
      { agent: "alpha", status: "not_in_room", invitable: true },
      { agent: "beta", status: "not_in_room", invitable: true },
    ]);

    // 2. Alpha joins the room -> in_room and not invitable
    await client.callTool({ name: "join_room", arguments: { roomId: "backend", participantId: "alpha" } });
    const afterJoin = JSON.parse(textOf(await client.callTool({ name: "list_invitable_agents", arguments: { roomId: "backend" } }))) as Array<{
      agent: string;
      status: string;
      invitable: boolean;
    }>;
    assert.deepEqual(afterJoin, [
      { agent: "alpha", status: "in_room", invitable: false },
      { agent: "beta", status: "not_in_room", invitable: true },
    ]);

    // 3. Alpha leaves the room -> disconnected and invitable
    await client.callTool({ name: "leave_room", arguments: { roomId: "backend", participantId: "alpha" } });
    const afterLeave = JSON.parse(textOf(await client.callTool({ name: "list_invitable_agents", arguments: { roomId: "backend" } }))) as Array<{
      agent: string;
      status: string;
      invitable: boolean;
    }>;
    assert.deepEqual(afterLeave, [
      { agent: "alpha", status: "disconnected", invitable: true },
      { agent: "beta", status: "not_in_room", invitable: true },
    ]);

    // 4. Unknown room returns error
    const unknown = await client.callTool({ name: "list_invitable_agents", arguments: { roomId: "non-existent-room" } });
    assert.equal(unknown.isError, true);
  });
});
