import { readdir, readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentRegistry } from "../bridge/agent-registry.js";
import type { ApprovalQueue } from "../bridge/approval-queue.js";
import type { BridgeService } from "../bridge/bridge-service.js";
import type { CoordinationService } from "../bridge/coordination-service.js";
import type { AgentRoomManager } from "../bridge/agent-room-manager.js";
import { isJsonContentType, rejectNonLocalRequest } from "../bridge/utils/local-request-guard.js";

const DASHBOARD_HOST = "127.0.0.1";
export const DASHBOARD_PORT = 8000;
const MAX_DECISION_BODY_BYTES = 4096;
const ASSET_DIRECTORY = join(dirname(fileURLToPath(import.meta.url)), "assets");

export interface DashboardServerOptions {
  targetRepositoryPath: string;
  roomId: string;
  mcpUrl: string;
  agentRegistry: AgentRegistry;
  bridgeService: BridgeService;
  approvalQueue: ApprovalQueue;
  roomManager: AgentRoomManager;
  coordinationService: CoordinationService;
  /** Override the default port in tests; normal runs use localhost:8000. */
  port?: number;
}

// Serves the dashboard and pushes room/approval updates without replacing agent IDE chats.
export class DashboardServer {
  private readonly server = createServer((request, response) => {
    void this.handle(request, response).catch((error: unknown) => {
      if (response.headersSent) return response.destroy();
      response.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" }).end(error instanceof Error ? error.message : String(error));
    });
  });
  private readonly disposeRoomSubscription: () => void;
  private readonly disposeApprovalSubscription: () => void;
  private readonly disposeCoordinationSubscription: () => void;
  private readonly disposeBridgeActivitySubscription: () => void;
  private readonly activityResponses = new Set<ServerResponse>();
  private listeningPort = DASHBOARD_PORT;

  constructor(private readonly options: DashboardServerOptions) {
    this.disposeRoomSubscription = options.roomManager.subscribe((event) => this.broadcast("room.activity", event));
    this.disposeApprovalSubscription = options.approvalQueue.subscribe(() => this.broadcast("approvals.changed", options.approvalQueue.listPending()));
    this.disposeCoordinationSubscription = options.coordinationService.subscribe((event) => this.broadcast("room.activity", event));
    this.disposeBridgeActivitySubscription = options.bridgeService.subscribeActivity((activity) => this.broadcast("agent.activity", activity));
  }

  get url(): string { return `http://${DASHBOARD_HOST}:${this.listeningPort}`; }

  async listen(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(this.options.port ?? DASHBOARD_PORT, DASHBOARD_HOST, () => {
        this.server.off("error", reject);
        const address = this.server.address();
        if (address && typeof address !== "string") this.listeningPort = address.port;
        resolve();
      });
    });
  }

  async close(): Promise<void> {
    this.disposeRoomSubscription();
    this.disposeApprovalSubscription();
    this.disposeCoordinationSubscription();
    this.disposeBridgeActivitySubscription();
    for (const response of this.activityResponses) response.end();
    this.activityResponses.clear();
    const closed = new Promise<void>((resolve, reject) => this.server.close((error) => error ? reject(error) : resolve()));
    // Idle keep-alive sockets would otherwise hold close() open.
    this.server.closeAllConnections();
    await closed;
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const refusal = rejectNonLocalRequest(request.headers);
    if (refusal) return this.sendJson(response, { error: refusal }, 403);
    if (request.method !== "GET" && request.method !== "HEAD" && !isJsonContentType(request.headers["content-type"])) {
      return this.sendJson(response, { error: "Content-Type must be application/json" }, 415);
    }
    const url = new URL(request.url ?? "/", `http://${DASHBOARD_HOST}:${DASHBOARD_PORT}`);
    if (request.method === "GET" && url.pathname === "/") return this.serveAsset("index.html", "text/html; charset=utf-8", response);
    if (request.method === "GET" && url.pathname === "/dashboard.css") return this.serveAsset("dashboard.css", "text/css; charset=utf-8", response);
    if (request.method === "GET" && url.pathname === "/dashboard.js") return this.serveAsset("dashboard.js", "text/javascript; charset=utf-8", response);
    if (request.method === "GET" && url.pathname === "/api/dashboard") return this.sendJson(response, await this.readDashboardData());
    if (request.method === "GET" && url.pathname === "/api/events") return this.streamEvents(response);
    const approvalId = url.pathname.match(/^\/api\/approvals\/([a-f0-9-]+)$/i)?.[1];
    if (request.method === "POST" && approvalId) return this.decideApproval(request, response, approvalId);
    if (request.method === "POST" && url.pathname === "/api/tasks") return this.handleCreateTask(request, response);
    const taskMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)$/);
    if (request.method === "PATCH" && taskMatch) return this.handleUpdateTask(request, response, taskMatch[1]!);
    if (request.method === "POST" && url.pathname === "/api/dispatch") return this.handleDispatch(request, response);
    if (request.method === "POST" && url.pathname === "/api/messages") return this.handleSendMessage(request, response);
    if (request.method === "POST" && url.pathname === "/api/claims") return this.handleClaimFile(request, response);
    if (request.method === "POST" && url.pathname === "/api/claims/release") return this.handleReleaseClaim(request, response);
    response.writeHead(404).end("Not found");
  }

  private async readDashboardData(): Promise<Record<string, unknown>> {
    const rooms = await this.options.roomManager.listRooms();
    const room = rooms.find((candidate) => candidate.roomId === this.options.roomId) ?? rooms[0] ?? null;
    const roomId = room?.roomId;
    const [agents, tasks, events, fileClaims, worktrees, members] = await Promise.all([
      Promise.all(this.options.agentRegistry.agentInfos.map(async (info) => ({
        ...info,
        connection: await this.readConnectionStatus(info.agentName),
      }))),
      roomId ? this.options.roomManager.listRoomTasks(roomId) : Promise.resolve([]),
      roomId ? this.options.roomManager.listRoomEvents(roomId, 50) : Promise.resolve([]),
      roomId ? this.options.coordinationService.listFileClaims(roomId) : Promise.resolve([]),
      this.options.coordinationService.listTaskWorktrees().catch(() => []),
      roomId ? this.options.roomManager.listRoomMembers(roomId) : Promise.resolve([]),
    ]);
    const liveActivity = this.options.bridgeService.getLiveActivity();
    const taskAssignments = tasks.map((task) => {
      const descPart = task.content.split(/## Description\s*\n\n?/)[1]?.trim() ?? "";
      const lines = descPart ? descPart.split("\n") : [];
      const title = lines[0]?.trim() || task.taskId;
      const description = lines.slice(1).join("\n").trim();
      return {
        ...task,
        title,
        description,
        activity: task.status === "in_progress" && task.workingSessionId !== this.options.roomManager.currentSessionId
          ? "Interrupted"
          : task.status === "review" ? "Review" : task.status === "in_progress" ? "In progress" : task.status === "done" ? "Done" : "Open",
      };
    });
    const { skills, rules } = await discoverSkillsAndRules(this.options.targetRepositoryPath);
    return {
      applicationName: "Cross-Agent-Mcp-Bridge",
      workspace: this.options.targetRepositoryPath,
      roomId,
      currentSessionId: this.options.roomManager.currentSessionId,
      connected: true,
      agents: agents.map((agent) => ({
        ...agent,
        connection: this.memberConnection(agent.agentName, members) ?? agent.connection,
        activity: liveActivity.agentName === agent.agentName
          ? liveActivity.phase === "waiting_approval" ? "Waiting approval" : "Working"
          : this.memberConnection(agent.agentName, members) === "Interrupted" ? "Interrupted"
          : taskAssignments.some((task) => task.assignedTo === agent.agentName && task.status === "review") ? "Reviewing"
          : taskAssignments.some((task) => task.assignedTo === agent.agentName && task.status === "in_progress") ? "In progress" : "Idle",
      })),
      members,
      unavailableAgents: this.options.agentRegistry.unavailableAgents,
      tasks: taskAssignments,
      events,
      approvals: this.options.approvalQueue.listPending(),
      fileClaims,
      worktrees,
      skills,
      rules,
      diagnostics: {
        dashboardUrl: `http://${DASHBOARD_HOST}:${this.listeningPort}`,
        mcpUrl: this.options.mcpUrl,
        roomPath: room?.path ?? this.options.roomManager.roomDirectoryPath(this.options.roomId),
        roomsDirectoryPath: this.options.roomManager.roomsDirectoryPath,
        roomExists: room !== null,
      },
    };
  }

  private async handleCreateTask(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      const body = await readJsonBody(request, MAX_DECISION_BODY_BYTES);
      const title = typeof body.title === "string" ? body.title.trim() : "";
      if (!title) {
        return this.sendJson(response, { error: "title is required" }, 400);
      }
      const description = typeof body.description === "string" && body.description.trim() ? `\n\n${body.description.trim()}` : "";
      const taskText = `${title}${description}`;
      const roomId = await this.requireRoomId();
      const assignedTo = typeof body.assignedTo === "string" && body.assignedTo.trim() ? body.assignedTo.trim() : undefined;
      const files = Array.isArray(body.files) ? body.files.filter((f): f is string => typeof f === "string" && f.trim().length > 0) : undefined;
      const taskOptions: { assignedTo?: string; files?: string[] } = {};
      if (assignedTo) taskOptions.assignedTo = assignedTo;
      if (files) taskOptions.files = files;
      const task = await this.options.roomManager.createTask(roomId, taskText, taskOptions);
      this.sendJson(response, { success: true, task });
    } catch (error) {
      this.sendJson(response, { error: error instanceof Error ? error.message : String(error) }, 500);
    }
  }

  private async handleUpdateTask(request: IncomingMessage, response: ServerResponse, taskId: string): Promise<void> {
    try {
      const roomId = await this.requireRoomId();
      const body = await readJsonBody(request, MAX_DECISION_BODY_BYTES);
      if (typeof body.status === "string" && ["open", "in_progress", "review", "done"].includes(body.status)) {
        await this.options.roomManager.setTaskStatus(roomId, taskId, body.status as "open" | "in_progress" | "review" | "done");
      }
      if (typeof body.assignedTo === "string" && body.assignedTo.trim()) {
        await this.options.roomManager.assignTask(roomId, taskId, body.assignedTo.trim());
      }
      this.sendJson(response, { success: true, taskId });
    } catch (error) {
      this.sendJson(response, { error: error instanceof Error ? error.message : String(error) }, 500);
    }
  }

  private async handleDispatch(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      const body = await readJsonBody(request, MAX_DECISION_BODY_BYTES * 4);
      const text = typeof body.text === "string" ? body.text.trim() : "";
      if (!text) {
        return this.sendJson(response, { error: "text is required" }, 400);
      }
      const controller = new AbortController();
      let replyText = "";
      let errorText: string | undefined;
      for await (const event of this.options.bridgeService.handleUserInput({
        inputText: text,
        signal: controller.signal,
      })) {
        if (event.kind === "reply_delta") {
          replyText += event.text;
        } else if (event.kind === "error") {
          errorText = event.text;
        } else if (event.kind === "cancelled") {
          errorText = "Turn cancelled";
        }
      }
      if (errorText) {
        return this.sendJson(response, { error: errorText, replyText }, 400);
      }
      this.sendJson(response, { success: true, replyText });
    } catch (error) {
      this.sendJson(response, { error: error instanceof Error ? error.message : String(error) }, 500);
    }
  }

  private async handleSendMessage(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      const roomId = await this.requireRoomId();
      const body = await readJsonBody(request, MAX_DECISION_BODY_BYTES);
      const message = typeof body.message === "string" ? body.message.trim() : "";
      if (!message) {
        return this.sendJson(response, { error: "message is required" }, 400);
      }
      await this.options.roomManager.sendRoomMessage(roomId, message);
      this.sendJson(response, { success: true });
    } catch (error) {
      this.sendJson(response, { error: error instanceof Error ? error.message : String(error) }, 500);
    }
  }

  private async handleClaimFile(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      const roomId = await this.requireRoomId();
      const body = await readJsonBody(request, MAX_DECISION_BODY_BYTES);
      const filePath = typeof body.filePath === "string" ? body.filePath.trim() : "";
      const taskId = typeof body.taskId === "string" ? body.taskId.trim() : "";
      const participantId = typeof body.participantId === "string" ? body.participantId.trim() : this.options.roomManager.defaultParticipantId;
      if (!filePath || !taskId) {
        return this.sendJson(response, { error: "filePath and taskId are required" }, 400);
      }
      const claim = await this.options.coordinationService.claimFile({
        roomId,
        taskId,
        filePath,
        participantId,
      });
      this.sendJson(response, { success: true, claim });
    } catch (error) {
      this.sendJson(response, { error: error instanceof Error ? error.message : String(error) }, 400);
    }
  }

  private async handleReleaseClaim(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      const roomId = await this.requireRoomId();
      const body = await readJsonBody(request, MAX_DECISION_BODY_BYTES);
      const filePath = typeof body.filePath === "string" ? body.filePath.trim() : "";
      const taskId = typeof body.taskId === "string" ? body.taskId.trim() : "";
      const participantId = typeof body.participantId === "string" ? body.participantId.trim() : this.options.roomManager.defaultParticipantId;
      if (!filePath || !taskId) {
        return this.sendJson(response, { error: "filePath and taskId are required" }, 400);
      }
      const result = await this.options.coordinationService.releaseFileClaim({
        roomId,
        taskId,
        filePath,
        participantId,
      });
      this.sendJson(response, { success: true, released: result.released });
    } catch (error) {
      this.sendJson(response, { error: error instanceof Error ? error.message : String(error) }, 400);
    }
  }

  private async readConnectionStatus(agentName: string): Promise<string> {
    let status: Record<string, unknown> | undefined;
    try { status = await this.options.agentRegistry.adapters.get(agentName)?.readStatus(); } catch { return "Disconnected"; }
    if (!status) return "Unavailable";
    const hasLiveEndpoint = Object.entries(status).some(([key, value]) => /connected|running|ready|available/i.test(key) && value === true);
    return hasLiveEndpoint ? "Connected" : "Available";
  }

  private memberConnection(agentName: string, members: Awaited<ReturnType<AgentRoomManager["listRoomMembers"]>>): string | undefined {
    const sessions = members.filter((member) => member.participantId === agentName);
    if (sessions.some((member) => member.connectionStatus === "connected")) return "Connected";
    if (sessions.some((member) => member.connectionStatus === "interrupted")) return "Interrupted";
    return sessions.some((member) => member.connectionStatus === "left") ? "Disconnected" : undefined;
  }

  private streamEvents(response: ServerResponse): void {
    response.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
    response.write("retry: 3000\n\n");
    response.write("event: dashboard.invalidate\ndata: {}\n\n");
    this.activityResponses.add(response);
    const heartbeat = setInterval(() => response.write(": heartbeat\n\n"), 20000);
    response.once("close", () => {
      clearInterval(heartbeat);
      this.activityResponses.delete(response);
    });
  }

  private broadcast(eventName: string, value: unknown): void {
    const data = `event: ${eventName}\ndata: ${JSON.stringify(value)}\n\n`;
    for (const response of this.activityResponses) response.write(data);
  }

  private async decideApproval(request: IncomingMessage, response: ServerResponse, approvalId: string): Promise<void> {
    try {
      const body = await readJsonBody(request, MAX_DECISION_BODY_BYTES);
      const decision = body.decision;
      if (decision !== "accept" && decision !== "decline" && decision !== "cancel") {
        return this.sendJson(response, { error: "decision must be accept, decline, or cancel" }, 400);
      }
      if (!this.options.approvalQueue.decide(approvalId, decision)) return this.sendJson(response, { error: "Approval is no longer pending" }, 404);
      this.sendJson(response, { approvalId, decision });
    } catch (error) {
      this.sendJson(response, { error: error instanceof Error ? error.message : String(error) }, 400);
    }
  }

  private async requireRoomId(): Promise<string> {
    const rooms = await this.options.roomManager.listRooms();
    const room = rooms.find((candidate) => candidate.roomId === this.options.roomId) ?? rooms[0];
    if (!room) throw new Error(`No room exists yet. Use get_room_setup, then create_room. Suggested path: ${this.options.roomManager.roomDirectoryPath(this.options.roomId)}`);
    return room.roomId;
  }

  private async serveAsset(name: string, contentType: string, response: ServerResponse): Promise<void> {
    try {
      const content = await readFile(join(ASSET_DIRECTORY, name));
      response.writeHead(200, { "Content-Type": contentType, "Cache-Control": "no-cache" }).end(content);
    } catch {
      response.writeHead(404).end("Dashboard asset not found");
    }
  }

  private sendJson(response: ServerResponse, value: unknown, status = 200): void {
    response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }).end(JSON.stringify(value));
  }
}

async function readJsonBody(request: IncomingMessage, maximumBytes: number): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > maximumBytes) throw new Error("Request body is too large.");
    chunks.push(buffer);
  }
  const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("Request body must be a JSON object.");
  return parsed as Record<string, unknown>;
}

export interface SkillSummary {
  id: string;
  name: string;
  description: string;
  category: string;
}

export interface RuleSummary {
  id: string;
  name: string;
  description: string;
  category: string;
}

async function discoverSkillsAndRules(targetRepositoryPath: string): Promise<{ skills: SkillSummary[]; rules: RuleSummary[] }> {
  const skills: SkillSummary[] = [
    { id: "relay-send", name: "relay-send", description: "Send message or delegate task to another agent via MCP", category: "Relay Core" },
    { id: "relay-setup", name: "relay-setup", description: "Configure VS Code settings and register MCP server", category: "Relay Core" },
    { id: "imran-playbook", name: "imran-playbook", description: "Imran's engineering playbook & senior developer rules", category: "Playbook" },
    { id: "vercel-react-best-practices", name: "vercel-react-best-practices", description: "Vercel React & Next.js performance optimization", category: "Engineering" },
    { id: "next-best-practices", name: "next-best-practices", description: "Next.js structure, routing, server actions", category: "Engineering" },
    { id: "web-design-guidelines", name: "web-design-guidelines", description: "Web UI interface guidelines and UX accessibility review", category: "Design" },
    { id: "frontend-skill", name: "frontend-skill", description: "Frontend architecture and component patterns", category: "Design" },
    { id: "agent-browser", name: "agent-browser", description: "Automated browser interaction and testing", category: "Testing" },
    { id: "playwright", name: "playwright", description: "End-to-end browser testing with Playwright", category: "Testing" },
    { id: "security-best-practices", name: "security-best-practices", description: "Security defense, auth, input validation", category: "Security" },
    { id: "security-threat-model", name: "security-threat-model", description: "Security threat modeling and audit checklist", category: "Security" },
    { id: "supabase-postgres-best-practices", name: "supabase-postgres-best-practices", description: "Database schema, indexing, RLS security", category: "Database" },
  ];

  try {
    const userSkillsPath = join(homedir(), ".agents", "skills");
    const entries = await readdir(userSkillsPath, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory() && !skills.some((s) => s.id === entry.name)) {
        skills.push({
          id: entry.name,
          name: entry.name,
          description: `Custom agent skill: ${entry.name}`,
          category: "Custom Skills",
        });
      }
    }
  } catch {
    // Ignore if not accessible
  }

  const rules: RuleSummary[] = [
    { id: "class-vs-function", name: "class-vs-function", description: "Classes for stateful services; functions for stateless logic", category: "Architecture" },
    { id: "change-ladder", name: "change-ladder", description: "Most localized change first; reuse before writing new code", category: "Architecture" },
    { id: "functions", name: "functions", description: "Small functions, early returns, typed object parameters and returns", category: "Code Style" },
    { id: "naming", name: "naming", description: "Domain names, no abbreviations, named constants for domain values", category: "Code Style" },
    { id: "workflow", name: "workflow", description: "Senior developer workflow: map scope, validate happy path", category: "Process" },
    { id: "code-reviewer", name: "code-reviewer", description: "Structured review for correctness, security, performance, tests", category: "Quality" },
    { id: "material-design-3", name: "material-design-3", description: "Material Design 3 principles, components, color roles", category: "Design" },
    { id: "material-3-web", name: "material-3-web", description: "Material 3 web UI, Tailwind tokens, avoid AI-slop design", category: "Design" },
    { id: "agent-swarm", name: "agent-swarm", description: "Parallel swarm check (Swarm: yes/no, because...)", category: "Process" },
    { id: "memory-knowledge", name: "memory-knowledge", description: "Living knowledge.md memory file for durable handoffs", category: "Process" },
    { id: "npm-packages", name: "npm-packages", description: "npm only, @latest, avoid pinned versions", category: "Dependencies" },
    { id: "security-safety", name: "security-safety", description: "Explicit review option and untrusted agent output boundaries", category: "Security" },
  ];

  return { skills, rules };
}

