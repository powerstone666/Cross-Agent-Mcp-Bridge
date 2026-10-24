// Exposes explicit file-claim and worktree operations through the shared MCP server.
import { type CallToolResult, type McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { CoordinationService } from "../../bridge/coordination-service.js";

export function registerCoordinationTools(server: McpServer, coordination: CoordinationService): void {
  server.registerTool("claim_task_file", {
    title: "Claim a project file",
    description: "Record a cooperative task-level file claim. Other relay users can still edit the file outside this coordination service.",
    inputSchema: z.object({ roomId: z.string().min(1), taskId: z.string().min(1), filePath: z.string().min(1), participantId: z.string().min(1) }),
  }, async (input) => result(() => coordination.claimFile(input)));

  server.registerTool("release_task_file", {
    title: "Release a project file claim",
    description: "Release a file claim owned by this participant for this task.",
    inputSchema: z.object({ roomId: z.string().min(1), taskId: z.string().min(1), filePath: z.string().min(1), participantId: z.string().min(1) }),
  }, async (input) => result(() => coordination.releaseFileClaim(input)));

  server.registerTool("list_task_file_claims", {
    title: "List project file claims",
    description: "List active cooperative file claims, optionally for one room.",
    inputSchema: z.object({ roomId: z.string().min(1).optional() }),
  }, async ({ roomId }) => result(() => coordination.listFileClaims(roomId)));

  server.registerTool("create_task_worktree", {
    title: "Create task worktree",
    description: "Create a Git worktree under a sibling agent-worktrees folder for isolated edits. This creates a branch and worktree in the target repository.",
    inputSchema: z.object({ roomId: z.string().min(1), taskId: z.string().min(1) }),
  }, async (input) => result(() => coordination.createTaskWorktree(input)));

  server.registerTool("list_task_worktrees", {
    title: "List task worktrees",
    description: "List Git worktrees whose branch follows agent-room/<room>/<task>.",
  }, async () => result(() => coordination.listTaskWorktrees()));

  server.registerTool("remove_task_worktree", {
    title: "Remove task worktree",
    description: "Remove a task worktree. Git refuses removal when it contains uncommitted changes.",
    inputSchema: z.object({ roomId: z.string().min(1), taskId: z.string().min(1) }),
  }, async (input) => result(() => coordination.removeTaskWorktree(input)));
}

async function result(operation: () => Promise<unknown>): Promise<CallToolResult> {
  try {
    return { content: [{ type: "text", text: JSON.stringify(await operation(), null, 2) }] };
  } catch (error) {
    return { content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }], isError: true };
  }
}
