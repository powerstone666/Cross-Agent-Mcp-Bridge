// Creates an MCP v2 server and registers the relay's separate tool groups.
// Keep protocol registration here; tool behavior lives in ./tools/.
import { McpServer } from "@modelcontextprotocol/server";
import type { AgentRegistry } from "../bridge/agent-registry.js";
import type { AgentRoomManager } from "../bridge/agent-room-manager.js";
import { CLIENT_NAME, CLIENT_VERSION } from "../bridge/bridge-config.js";
import type { BridgeService } from "../bridge/bridge-service.js";
import type { CoordinationService } from "../bridge/coordination-service.js";
import { registerAgentTools } from "./tools/agent-tools.js";
import { registerInviteTools } from "./tools/invite-tools.js";
import { registerRoomTools } from "./tools/room-tools.js";
import { registerSkillTools } from "./tools/skill-tools.js";
import { registerCoordinationTools } from "./tools/coordination-tools.js";

export interface McpServerOptions {
  bridgeService: BridgeService;
  agentRegistry: AgentRegistry;
  relayInfo: Record<string, unknown>;
  roomManager?: AgentRoomManager;
  coordinationService?: CoordinationService;
}

export class McpServerService {
  readonly server = new McpServer({ name: CLIENT_NAME, version: CLIENT_VERSION });
  private readonly unsubscribeRoomEvents?: () => void;
  private readonly joinedRoomMembers = new Map<string, { roomId: string; participantId: string; sessionId?: string }>();
  private readonly roomManager: AgentRoomManager | undefined;

  constructor(options: McpServerOptions) {
    registerAgentTools(this.server, options);
    registerSkillTools(this.server);
    this.roomManager = options.roomManager;
    if (options.roomManager) {
      registerRoomTools(
        this.server,
        options.roomManager,
        (member) => this.joinedRoomMembers.set(memberKey(member), member),
        (member) => this.joinedRoomMembers.delete(memberKey(member)),
      );
      registerInviteTools(this.server, options);
      const eventsUri = "cross-agent-mcp-bridge://rooms/events";
      this.server.registerResource("room-events", eventsUri, {
        title: "Shared room activity events",
        description: "Concise room change summaries. Subscribe for updates, then read this resource to fetch the latest events.",
        mimeType: "application/json",
      }, async (uri) => ({
        contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(await options.roomManager!.listRecentEvents(50)) }],
      }));
      // MCP resource notifications wake subscribers; full event text stays in the resource read.
      this.unsubscribeRoomEvents = options.roomManager.subscribe(() => {
        void this.server.server.sendResourceUpdated({ uri: eventsUri }).catch(() => undefined);
      });
    }
    if (options.coordinationService) registerCoordinationTools(this.server, options.coordinationService);
  }

  async close(): Promise<void> {
    this.unsubscribeRoomEvents?.();
    if (this.roomManager) {
      await Promise.allSettled([...this.joinedRoomMembers.values()].map((member) => this.roomManager!.leaveRoom(member.roomId, member.participantId, member.sessionId)));
      this.joinedRoomMembers.clear();
    }
    await this.server.close();
  }
}

function memberKey(member: { roomId: string; participantId: string; sessionId?: string }): string {
  return `${member.sessionId ?? "local"}:${member.roomId}:${member.participantId}`;
}
