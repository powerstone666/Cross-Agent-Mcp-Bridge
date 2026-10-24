// MCP tool that invites another agent into a shared room by waking it with a relay turn.
import { type McpServer } from "@modelcontextprotocol/server";
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
    description: `Posts an invitation in a shared room and sends the agent a relay turn asking it to join, because room messages alone never wake an agent. Optionally creates an assigned task first. Returns the agent's reply, membership, and task ID when supplied. Available agents: ${agentNames || "none"}.`,
    inputSchema: z.object({
      roomId: z.string().min(1),
      agent: z.string().min(1).describe(`Agent name without @. Available: ${agentNames || "none"}.`),
      note: z.string().min(1).optional().describe("Optional context for the agent, such as what the room is for."),
      task: z.string().min(1).optional().describe("Optional task to create and assign to the invited agent before waking it."),
    }),
  }, async ({ roomId, agent, note, task }, context) => {
    if (!agentRegistry.adapters.has(agent)) return errorResult(`Unknown agent "${agent}". Available: ${agentNames || "none"}.`);
    let taskId: string | undefined;
    try {
      await roomManager.getRoomContext(roomId);
      if (task) taskId = (await roomManager.createTask(roomId, task, { assignedTo: agent })).taskId;
      await roomManager.sendRoomMessage(roomId, `@${agent} you are invited to this room. Call join_room with roomId "${roomId}" and participantId "${agent}", then get_room_onboarding.${taskId ? ` Work task ${taskId}: ${task}. Set its status to in_progress, update_task with progress, then set_task_status to review or done. Use publish_knowledge and publish_decision for anything worth keeping.` : ""}${note ? ` ${note}` : ""}`);
    } catch (error) {
      return errorResult(error instanceof Error ? error.message : String(error));
    }
    const reply = await runAgentTurn({
      agent,
      bridgeService,
      signal: context.mcpReq.signal,
      message: `You are invited to the shared room "${roomId}". Using the cross-agent-mcp-bridge MCP tools, call join_room with roomId "${roomId}" and participantId "${agent}", then call get_room_onboarding and send_room_message with a short hello.${taskId ? ` Work task ${taskId}: ${task}. Call set_task_status with in_progress when you start, update_task with progress, then set_task_status with review or done. Use publish_knowledge and publish_decision for anything worth keeping.` : ""}${note ? ` Context: ${note}` : ""}`,
    });
    if (reply.isError) {
      if (!taskId) return reply;
      return errorResult(JSON.stringify({ roomId, agent, taskId, error: reply.content.map((part) => ("text" in part ? part.text : "")).join("") }));
    }
    const members = await roomManager.listRoomMembers(roomId);
    const joined = members.some((member) => member.participantId === agent && member.status === "joined");
    return textResult({ roomId, agent, joined, ...(taskId ? { taskId } : {}), reply: reply.content.map((part) => ("text" in part ? part.text : "")).join("") });
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
