// Starts one shared Streamable HTTP MCP relay on localhost and serves all agent sessions.
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { DEFAULT_MAX_REQUEST_BODY_SIZE, isInitializeRequest, WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/server";
import { AGENT_MODULES } from "../agent-modules.js";
import { createAgentRegistry } from "../bridge/agent-registry.js";
import { loadBridgeConfig } from "../bridge/bridge-config.js";
import { EventLogService } from "../bridge/event-log-service.js";
import { McpSessionRegistry, type McpSession } from "./mcp-session-registry.js";
import { McpServerService } from "./mcp-server-service.js";
import { BridgeService } from "../bridge/bridge-service.js";
import { AgentRoomManager } from "../bridge/agent-room-manager.js";
import { CoordinationService } from "../bridge/coordination-service.js";
import { rejectNonLocalRequest } from "../bridge/utils/local-request-guard.js";
import { ApprovalQueue } from "../bridge/approval-queue.js";
import { DashboardServer, DASHBOARD_PORT } from "../dashboard/dashboard-server.js";

export async function runMcpCommand(): Promise<void> {
  const config = loadBridgeConfig({
    environment: process.env,
    workingDirectory: process.cwd(),
  });

  // Prefer connector routes whose action approvals the relay can answer itself.
  const agentRegistry = createAgentRegistry({
    modules: AGENT_MODULES,
    environment: process.env,
    targetRepositoryPath: config.targetRepositoryPath,
    humanApprovalChannel: "automatic",
  });

  const conversationId = randomUUID();
  const roomManager = new AgentRoomManager({
    targetRepositoryPath: config.targetRepositoryPath,
    sessionId: conversationId,
    participantId: process.env.RELAY_AGENT_NAME?.trim() || "cross-agent-mcp-bridge",
    roomName: config.agentRoomName,
    coordinatorId: agentRegistry.agentInfos.find((agent) => agent.role === "coordinator")?.agentName,
  });
  const coordinationService = new CoordinationService({ targetRepositoryPath: config.targetRepositoryPath });
  const unsubscribeCoordinationActivity = coordinationService.subscribe((event) => {
    void roomManager.recordCoordinationActivity(event);
  });
  const approvalQueue = new ApprovalQueue();
  const bridgeService = new BridgeService({
    adapters: agentRegistry.adapters,
    eventLog: new EventLogService({ logDirectoryPath: config.logDirectoryPath }),
    approvalPrompter: approvalQueue,
    conversationId,
    workingDirectory: config.targetRepositoryPath,
    agentRoom: roomManager,
  });
  const dashboardServer = new DashboardServer({
    targetRepositoryPath: config.targetRepositoryPath,
    roomId: config.agentRoomName,
    mcpUrl: `http://127.0.0.1:${MCP_PORT}/mcp`,
    agentRegistry,
    bridgeService,
    approvalQueue,
    roomManager,
    coordinationService,
  });
  const sessions = new McpSessionRegistry<ActiveSession>(SESSION_IDLE_TIMEOUT_MS);
  const stopSweepingSessions = sessions.startSweeping(SESSION_SWEEP_INTERVAL_MS);
  const httpServer = createServer(async (request, response) => {
    const refusal = rejectNonLocalRequest(request.headers);
    if (refusal) {
      response.writeHead(403).end(refusal);
      return;
    }
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (url.pathname !== "/mcp") {
      response.writeHead(404).end("Not found");
      return;
    }
    try {
      const sessionId = request.headers["mcp-session-id"];
      let session = typeof sessionId === "string" ? sessions.get(sessionId) : undefined;
      let parsedBody: unknown;
      let bodyText: string | undefined;
      if (!session && request.method === "POST" && typeof sessionId !== "string") {
        // Only an initialize request may open a session; anything else would build a server that is never closed.
        bodyText = await readBodyText(request);
        try { parsedBody = JSON.parse(bodyText); } catch { /* answered below as a bad request */ }
        if (!isInitializeRequest(parsedBody)) {
          response.writeHead(400).end("Send an initialize request first");
          return;
        }
        let createdSessionId = "";
        const transport = new WebStandardStreamableHTTPServerTransport({
          sessionIdGenerator: randomUUID,
          onsessioninitialized: (id) => { createdSessionId = id; },
        });
        const sessionService = new McpServerService({
          bridgeService,
          agentRegistry,
          relayInfo: { targetRepository: config.targetRepositoryPath, logDirectory: config.logDirectoryPath },
          roomManager,
          coordinationService,
        });
        await sessionService.server.connect(transport);
        session = { transport, inFlight: 0, close: () => sessionService.close() };
        // Initialization establishes the transport's session ID before the response is sent.
        const webResponse = await transport.handleRequest(toWebRequest(request, bodyText), { parsedBody });
        if (createdSessionId) sessions.add(createdSessionId, session);
        else await session.close();
        await sendWebResponse(webResponse, response, session);
        return;
      }
      if (!session) {
        response.writeHead(404).end("Unknown MCP session");
        return;
      }
      await sendWebResponse(await session.transport.handleRequest(toWebRequest(request)), response, session);
      if (request.method === "DELETE" && typeof sessionId === "string") await sessions.remove(sessionId);
    } catch (error) {
      console.error("MCP HTTP request failed:", error);
      if (!response.headersSent) response.writeHead(500);
      response.end("MCP request failed");
    }
  });
  const port = MCP_PORT;
  httpServer.listen(port, "127.0.0.1");
  try {
    await once(httpServer, "listening");
  } catch (error) {
    unsubscribeCoordinationActivity();
    agentRegistry.close();
    throw error;
  }
  {
    const address = httpServer.address();
    if (!address || typeof address === "string") throw new Error("Could not determine MCP HTTP port");
    console.error(`cross-agent-mcp-bridge MCP server ready: http://127.0.0.1:${address.port}/mcp`);
  }
  try {
    await dashboardServer.listen();
    console.error(`Dashboard ready: http://127.0.0.1:${DASHBOARD_PORT}`);
  } catch (error) {
    console.error(`Dashboard unavailable on http://127.0.0.1:${DASHBOARD_PORT}: ${error instanceof Error ? error.message : String(error)}`);
  }
  let shuttingDown = false;
  const shutdown = async () => {
    // A second signal means the graceful path is stuck.
    if (shuttingDown) process.exit(1);
    shuttingDown = true;
    setTimeout(() => process.exit(1), SHUTDOWN_GRACE_MS).unref();
    try {
      stopSweepingSessions();
      const httpClosed = new Promise<void>((resolve) => httpServer.close(() => resolve()));
      approvalQueue.cancelAll();
      await sessions.closeAll();
      unsubscribeCoordinationActivity();
      await dashboardServer.close().catch(() => undefined);
      // Open event streams would keep close() waiting forever.
      httpServer.closeAllConnections();
      await httpClosed;
      agentRegistry.close();
    } finally {
      process.exit(0);
    }
  };
  process.on("SIGINT", () => { void shutdown(); });
  process.on("SIGTERM", () => { void shutdown(); });
  for (const { agentName, reason } of agentRegistry.unavailableAgents) {
    console.error(`Agent @${agentName} unavailable: ${reason}`);
  }
}

const MCP_PORT = 38765;
const MAX_REQUEST_BODY_BYTES = DEFAULT_MAX_REQUEST_BODY_SIZE;
// Clients such as IDE agents often disappear without sending DELETE, so unused sessions expire.
const SESSION_IDLE_TIMEOUT_MS = 30 * 60 * 1000;
const SESSION_SWEEP_INTERVAL_MS = 60 * 1000;
const SHUTDOWN_GRACE_MS = 5000;

interface ActiveSession extends McpSession {
  transport: WebStandardStreamableHTTPServerTransport;
}

async function readBodyText(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_REQUEST_BODY_BYTES) throw new Error("Request body is too large.");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

// A body already read from the stream is passed as text; otherwise the request stream is forwarded.
function toWebRequest(request: IncomingMessage, bodyText?: string): Request {
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(", ") : value);
  }
  const method = request.method ?? "GET";
  const body = method === "GET" || method === "HEAD" ? undefined : bodyText ?? Readable.toWeb(request) as ReadableStream<Uint8Array>;
  return new Request(`http://127.0.0.1${request.url ?? "/mcp"}`, { method, headers, body, ...(body !== undefined && bodyText === undefined ? { duplex: "half" } : {}) } as RequestInit);
}

// The session counts as busy until the client's connection closes, because streams outlive this function.
async function sendWebResponse(webResponse: Response, response: ServerResponse, session: McpSession): Promise<void> {
  session.inFlight += 1;
  response.once("close", () => { session.inFlight -= 1; });
  response.writeHead(webResponse.status, Object.fromEntries(webResponse.headers.entries()));
  if (!webResponse.body) {
    response.end();
    return;
  }
  const stream = Readable.fromWeb(webResponse.body as import("node:stream/web").ReadableStream);
  // A client that disconnects must stop the upstream stream, not leave it open.
  response.once("close", () => stream.destroy());
  stream.pipe(response);
}
