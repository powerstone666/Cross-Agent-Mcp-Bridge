// MCP tools for messaging agents and reporting relay status.
import { type CallToolResult, type McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { AgentRegistry } from "../../bridge/agent-registry.js";
import type { BridgeService } from "../../bridge/bridge-service.js";

export function registerAgentTools(server: McpServer, { agentRegistry, bridgeService, relayInfo }: {
  agentRegistry: AgentRegistry;
  bridgeService: BridgeService;
  relayInfo: Record<string, unknown>;
}): void {
  const responseByRequest = new Map<string, { response: Promise<CallToolResult>; settled: boolean }>();
  const agentNames = agentRegistry.agentInfos.map(({ agentName }) => agentName).join(", ");
  server.registerTool("send_to_agent", {
    title: "Send a message to another agent",
    description: `Sends a message to an agent through the relay and returns its reply. Available agents: ${agentNames || "none"}.`,
    inputSchema: z.object({
      agent: z.string().min(1).describe(`Agent name without @. Available: ${agentNames || "none"}.`),
      message: z.string().min(1).describe("A self-contained request for the agent."),
      requireHumanApproval: z.boolean().optional().describe("Ask a person to approve the receiving agent's commands and file changes. Defaults to false."),
    }),
  }, async ({ agent, message, requireHumanApproval }, context) => {
    if (!agentRegistry.adapters.has(agent)) {
      return errorResult(`Unknown agent "${agent}". Available: ${agentNames || "none"}.`);
    }
    const requestKey = `${context.sessionId ?? "session"}:${String(context.mcpReq.id)}`;
    const existingResponse = responseByRequest.get(requestKey);
    if (existingResponse) return existingResponse.response;
    const response = runAgentTurn({ agent, message, signal: context.mcpReq.signal, bridgeService, requireHumanApproval });
    const cachedResponse = { response, settled: false };
    responseByRequest.set(requestKey, cachedResponse);
    void response.then(() => { cachedResponse.settled = true; }, () => { cachedResponse.settled = true; });
    // MCP request IDs are unique within a session; keep a bounded cache for uncertain retries.
    if (responseByRequest.size > 500) {
      const oldestCompleted = [...responseByRequest].find(([key, item]) => key !== requestKey && item.settled)?.[0];
      if (oldestCompleted) responseByRequest.delete(oldestCompleted);
    }
    return response;
  });

  server.registerTool("list_agents", {
    title: "List agents",
    description: "Lists available and unavailable agents that can be used with send_to_agent.",
  }, async () => textResult({ agents: agentRegistry.agentInfos, unavailableAgents: agentRegistry.unavailableAgents }));

  server.registerTool("relay_status", {
    title: "Relay status",
    description: "Shows agent connection status and relay log and room locations.",
  }, async () => {
    const agents = await Promise.all(agentRegistry.agentInfos.map(async (info) => ({
      ...info,
      status: await agentRegistry.adapters.get(info.agentName)?.readStatus(),
    })));
    return textResult({ ...relayInfo, activity: bridgeService.getLiveActivity(), agents, unavailableAgents: agentRegistry.unavailableAgents });
  });
}

export async function runAgentTurn({ agent, message, signal, bridgeService, requireHumanApproval = false, onStarted, workingDirectory }: {
  agent: string;
  message: string;
  signal: AbortSignal;
  bridgeService: BridgeService;
  requireHumanApproval?: boolean | undefined;
  onStarted?: () => void;
  workingDirectory?: string;
}): Promise<CallToolResult> {
    let replyText = "";
    let failureText: string | undefined;
    // Gather streamed deltas into the single reply returned by this MCP call.
    for await (const event of bridgeService.handleUserInput({ inputText: `@${agent} ${message}`, signal, requireHumanApproval, ...(onStarted && { onStarted }), ...(workingDirectory && { workingDirectory }) })) {
      if (event.kind === "reply_delta") replyText += event.text;
      else if (event.kind === "error") failureText = event.text;
      else if (event.kind === "cancelled") failureText = "Turn cancelled";
    }
    if (failureText !== undefined) return errorResult(failureText);
    return textResult(replyText || `(${agent} sent no text)`);
}

// MCP tool results accept text content; stringify structured relay data consistently.
export function textResult(value: unknown): CallToolResult {
  return { content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }] };
}

export function errorResult(message: string): CallToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}
