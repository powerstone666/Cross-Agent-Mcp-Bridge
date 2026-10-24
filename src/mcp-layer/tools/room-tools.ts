// MCP tools for shared room context, tasks, knowledge, and messages.
import { type CallToolResult, type McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { AgentRoomManager } from "../../bridge/agent-room-manager.js";

export function registerRoomTools(server: McpServer, roomManager: AgentRoomManager, onParticipantJoin?: (input: { roomId: string; participantId: string; sessionId?: string }) => void, onParticipantLeave?: (input: { roomId: string; participantId: string; sessionId?: string }) => void): void {
  server.registerTool("get_room_setup", { title: "Check shared room setup", description: "Inspect rooms under the repository path supplied by the agent. If none exist, return the exact rooms directory and suggested room path; then call create_room with the chosen name and same repository path.", inputSchema: z.object({ targetRepositoryPath: z.string().min(1) }) }, async ({ targetRepositoryPath }) => roomResult(async () => {
    const rooms = await roomManager.listRooms(targetRepositoryPath);
    return {
      targetRepositoryPath,
      rooms,
      roomsDirectoryPath: roomManager.roomsDirectoryPathFor(targetRepositoryPath),
      suggestedRoomId: roomManager.defaultRoomId,
      suggestedRoomPath: roomManager.roomDirectoryPath(roomManager.defaultRoomId, targetRepositoryPath),
      nextStep: rooms.length ? "Join an existing room with join_room." : "Call create_room to create a room before joining it.",
    };
  }));
  server.registerTool("create_room", { title: "Create agent room", description: "Explicitly create a shared room inside the repository path supplied by the agent. Use get_room_setup first when no room is known. Pass participantId to join the creator in this MCP session and record them as coordinator.", inputSchema: z.object({ name: z.string().min(1), targetRepositoryPath: z.string().min(1), participantId: z.string().min(1).optional() }) }, async ({ name, targetRepositoryPath, participantId }, context) => roomResult(async () => {
    const summary = await roomManager.createRoom(name, targetRepositoryPath, participantId);
    if (!participantId) return { ...summary, joined: false };
    await roomManager.joinRoom(summary.roomId, participantId, context.sessionId);
    onParticipantJoin?.({ roomId: summary.roomId, participantId, ...(context.sessionId ? { sessionId: context.sessionId } : {}) });
    return { ...summary, joined: true };
  }));
  server.registerTool("join_room", { title: "Join agent room", description: "Join an existing shared room and bind this participant to the current MCP session.", inputSchema: z.object({ roomId: z.string().min(1), participantId: z.string().min(1).optional() }) }, async ({ roomId, participantId }, context) => roomResult(async () => {
    const memberId = participantId ?? roomManager.defaultParticipantId;
    const summary = await roomManager.joinRoom(roomId, memberId, context.sessionId);
    onParticipantJoin?.({ roomId, participantId: memberId, ...(context.sessionId ? { sessionId: context.sessionId } : {}) });
    return summary;
  }));
  server.registerTool("leave_room", { title: "Leave agent room", description: "Record that a participant has left the room session.", inputSchema: z.object({ roomId: z.string().min(1), participantId: z.string().min(1).optional() }) }, async ({ roomId, participantId }, context) => roomResult(async () => {
    const memberId = participantId ?? roomManager.defaultParticipantId;
    await roomManager.leaveRoom(roomId, memberId, context.sessionId);
    onParticipantLeave?.({ roomId, participantId: memberId, ...(context.sessionId ? { sessionId: context.sessionId } : {}) });
    return { roomId, left: true };
  }));
  server.registerTool("list_room_members", { title: "List room members", description: "Show joined, disconnected, and interrupted participant sessions.", inputSchema: z.object({ roomId: z.string().min(1) }) }, async ({ roomId }) => roomResult(() => roomManager.listRoomMembers(roomId)));
  server.registerTool("get_room_onboarding", { title: "Load room onboarding context", description: "After joining, read ROOM.md, shared knowledge, and tasks assigned to this participant before starting work.", inputSchema: z.object({ roomId: z.string().min(1), participantId: z.string().min(1).optional() }) }, async ({ roomId, participantId }) => roomResult(() => roomManager.getRoomOnboarding(roomId, participantId)));
  server.registerTool("list_rooms", { title: "List agent rooms", description: "List existing rooms under the repository path supplied by the agent. Use get_room_setup for the setup path and next step when this list is empty.", inputSchema: z.object({ targetRepositoryPath: z.string().min(1) }) }, async ({ targetRepositoryPath }) => roomResult(() => roomManager.listRooms(targetRepositoryPath)));
  server.registerTool("get_room_context", { title: "Get room context", description: "Read room metadata, task index, and recent messages.", inputSchema: z.object({ roomId: z.string().min(1) }) }, async ({ roomId }) => roomResult(() => roomManager.getRoomContext(roomId)));
  server.registerTool("list_room_tasks", { title: "List room tasks", description: "List task files in a shared room.", inputSchema: z.object({ roomId: z.string().min(1) }) }, async ({ roomId }) => roomResult(() => roomManager.listRoomTasks(roomId)));
  server.registerTool("create_task", { title: "Create room task", description: "Create a task with optional agent assignment and repository-relative file list.", inputSchema: z.object({ roomId: z.string().min(1), task: z.string().min(1), assignedTo: z.string().min(1).optional(), files: z.array(z.string().min(1)).optional() }) }, async ({ roomId, task, assignedTo, files }) => roomResult(() => roomManager.createTask(roomId, task, { ...(assignedTo ? { assignedTo } : {}), ...(files ? { files } : {}) })));
  server.registerTool("update_task", { title: "Update room task", description: "Append an update to a room task.", inputSchema: z.object({ roomId: z.string().min(1), taskId: z.string().min(1), update: z.string().min(1) }) }, async ({ roomId, taskId, update }) => roomResult(() => roomManager.updateTask(roomId, taskId, update)));
  server.registerTool("set_task_status", { title: "Set task status", description: "Move a room task through open, in progress, review, and done.", inputSchema: z.object({ roomId: z.string().min(1), taskId: z.string().min(1), status: z.enum(["open", "in_progress", "review", "done"]) }) }, async ({ roomId, taskId, status }) => roomResult(() => roomManager.setTaskStatus(roomId, taskId, status)));
  server.registerTool("assign_task", { title: "Assign room task", description: "Assign a room task to an agent participant.", inputSchema: z.object({ roomId: z.string().min(1), taskId: z.string().min(1), assignedTo: z.string().min(1) }) }, async ({ roomId, taskId, assignedTo }) => roomResult(() => roomManager.assignTask(roomId, taskId, assignedTo)));
  server.registerTool("publish_knowledge", { title: "Publish room knowledge", description: "Publish a Markdown note to a shared room.", inputSchema: z.object({ roomId: z.string().min(1), content: z.string().min(1) }) }, async ({ roomId, content }) => roomResult(() => roomManager.publishKnowledge(roomId, content)));
  server.registerTool("search_knowledge", { title: "Search room knowledge", description: "Search knowledge notes in a shared room.", inputSchema: z.object({ roomId: z.string().min(1), query: z.string().min(1) }) }, async ({ roomId, query }) => roomResult(() => roomManager.searchKnowledge(roomId, query)));
  server.registerTool("publish_decision", { title: "Record a shared decision", description: "Write an architecture or implementation decision into the room decisions folder.", inputSchema: z.object({ roomId: z.string().min(1), title: z.string().min(1), content: z.string().min(1) }) }, async ({ roomId, title, content }) => roomResult(() => roomManager.publishDecision(roomId, title, content)));
  server.registerTool("list_room_decisions", { title: "List shared decisions", description: "Read recorded decisions for a room.", inputSchema: z.object({ roomId: z.string().min(1) }) }, async ({ roomId }) => roomResult(() => roomManager.listDecisions(roomId)));
  server.registerTool("send_room_message", { title: "Send room message", description: "Append a Slack-like message to a shared room.", inputSchema: z.object({ roomId: z.string().min(1), message: z.string().min(1) }) }, async ({ roomId, message }) => roomResult(async () => {
    await roomManager.sendRoomMessage(roomId, message);
    return { roomId, sent: true };
  }));
}

// Return room manager errors as MCP tool errors so callers can report them.
async function roomResult(operation: () => Promise<unknown>): Promise<CallToolResult> {
  try {
    const value = await operation();
    return { content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }] };
  } catch (error) {
    return { content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }], isError: true };
  }
}
