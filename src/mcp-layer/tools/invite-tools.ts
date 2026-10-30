// MCP tool that invites another agent into a shared room by waking it with a relay turn.
import { type CallToolResult, type McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { AgentRegistry } from "../../bridge/agent-registry.js";
import type { AgentRoomManager } from "../../bridge/agent-room-manager.js";
import type { BridgeService } from "../../bridge/bridge-service.js";
import { errorResult, runAgentTurn, textResult } from "./agent-tools.js";

export function registerInviteTools(server: McpServer, { agentRegistry, bridgeService, roomManager }: {
  agentRegistry: AgentRegistry;
  bridgeService: BridgeService;
  roomManager?: AgentRoomManager;
}): void {
  if (!roomManager) return;
  const agentNames = agentRegistry.agentInfos.map(({ agentName }) => agentName).join(", ");
  server.registerTool("invite_to_room", {
    title: "Invite an agent to a room",
    description: `Posts an invitation in a shared room and sends the agent a relay turn asking it to join, because room messages alone never wake an agent. Optionally creates an assigned task first. Returns as soon as the agent has the message, so the caller is free for other work; the agent's final reply is posted as its room message. Pass waitForReply: true to wait for the reply instead. Available agents: ${agentNames || "none"}.`,
    inputSchema: z.object({
      roomId: z.string().min(1),
      agent: z.string().min(1).describe(`Agent name without @. Available: ${agentNames || "none"}.`),
      note: z.string().min(1).optional().describe("Optional context for the agent, such as what the room is for."),
      task: z.string().min(1).optional().describe("Optional task to create and assign to the invited agent before waking it."),
      waitForReply: z.boolean().optional().describe("Wait until the agent finishes and return its reply. Defaults to false."),
    }),
  }, async ({ roomId, agent, note, task, waitForReply = false }, context) => {
    if (!agentRegistry.adapters.has(agent)) return errorResult(`Unknown agent "${agent}". Available: ${agentNames || "none"}.`);
    let taskId: string | undefined;
    try {
      await roomManager.getRoomContext(roomId);
      // The relay records membership itself, so a client that blocks join_room still becomes a member.
      await roomManager.joinRoom(roomId, agent);
      if (task) taskId = (await roomManager.createTask(roomId, task, { assignedTo: agent })).taskId;
      await roomManager.sendRoomMessage(roomId, `@${agent} you are invited to this room. You are already a member. Call get_room_onboarding with roomId "${roomId}".${taskId ? ` Work task ${taskId}: ${task}. Set its status to in_progress, update_task with progress, then set_task_status to review or done. Use publish_knowledge and publish_decision for anything worth keeping.` : ""}${note ? ` ${note}` : ""}`);
    } catch (error) {
      return errorResult(error instanceof Error ? error.message : String(error));
    }
    // The turn outlives this call, so it gets its own signal; the caller can only cancel it before it starts.
    const turnController = new AbortController();
    const cancelBeforeStart = () => turnController.abort();
    context.mcpReq.signal.addEventListener("abort", cancelBeforeStart, { once: true });
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    const finished = runAgentTurn({
      agent,
      bridgeService,
      signal: turnController.signal,
      // Work in the room's repository, so the agent's chat opens in that project, not the relay's.
      workingDirectory: roomManager.repositoryPathForRoom(roomId),
      onStarted: () => {
        context.mcpReq.signal.removeEventListener("abort", cancelBeforeStart);
        markStarted();
      },
      message: `You are invited to the shared room "${roomId}". Using the cross-agent-mcp-bridge MCP tools, you are already a member, so call get_room_onboarding with roomId "${roomId}" (participantId "${agent}") and send_room_message with a short hello.${taskId ? ` Work task ${taskId}: ${task}. Call set_task_status with in_progress when you start, update_task with progress, then set_task_status with review or done. Use publish_knowledge and publish_decision for anything worth keeping.` : ""}${note ? ` Context: ${note}` : ""}`,
    });
    const hasStarted = await Promise.race([started.then(() => true), finished.then(() => false)]);
    if (waitForReply || !hasStarted) {
      const reply = await finished;
      if (reply.isError) {
        if (!taskId) return reply;
        return errorResult(JSON.stringify({ roomId, agent, taskId, error: textOf(reply) }));
      }
      return textResult({ roomId, agent, joined: await isJoined(roomManager, roomId, agent), ...(taskId ? { taskId } : {}), reply: textOf(reply) });
    }
    void finished.then(
      (reply) => roomManager.sendRoomMessage(roomId, `${reply.isError ? "Turn failed" : "Finished"}${taskId ? ` task ${taskId}` : ""}: ${textOf(reply)}`, agent),
    ).catch((error: unknown) => console.error(`cross-agent-mcp-bridge: could not post ${agent}'s reply to ${roomId}`, error));
    return textResult({
      roomId,
      agent,
      joined: await isJoined(roomManager, roomId, agent),
      ...(taskId ? { taskId } : {}),
      status: "started",
      next: `@${agent} is working. Its final reply will be posted in the room; check get_room_context${taskId ? ` or list_room_tasks for task ${taskId}` : ""}.`,
    });
  });

  server.registerTool("list_invitable_agents", {
    title: "List invitable agents",
    description: "Lists every registered agent and whether they can be invited to a shared room based on their current room membership status.",
    inputSchema: z.object({
      roomId: z.string().min(1),
    }),
  }, async ({ roomId }) => {
    try {
      await roomManager.getRoomContext(roomId);
    } catch (error) {
      return errorResult(error instanceof Error ? error.message : String(error));
    }
    const members = await roomManager.listRoomMembers(roomId);
    const results = agentRegistry.agentInfos.map(({ agentName }) => {
      const agentMembers = members.filter((member) => member.participantId === agentName);
      let status: "in_room" | "interrupted" | "disconnected" | "not_in_room";
      if (agentMembers.some((member) => member.connectionStatus === "connected")) {
        status = "in_room";
      } else if (agentMembers.some((member) => member.connectionStatus === "interrupted")) {
        status = "interrupted";
      } else if (agentMembers.some((member) => member.connectionStatus === "left")) {
        status = "disconnected";
      } else {
        status = "not_in_room";
      }
      return {
        agent: agentName,
        status,
        invitable: status !== "in_room",
      };
    });
    return textResult(results);
  });
}

async function isJoined(roomManager: AgentRoomManager, roomId: string, agent: string): Promise<boolean> {
  const members = await roomManager.listRoomMembers(roomId);
  return members.some((member) => member.participantId === agent && member.status === "joined");
}

function textOf(result: CallToolResult): string {
  return result.content.map((part) => ("text" in part ? part.text : "")).join("");
}
