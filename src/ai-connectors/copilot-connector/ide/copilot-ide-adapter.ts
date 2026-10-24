// Sends a relay message through VS Code's Agent Host Protocol and streams the reply back.
// Never confirm a tool call or answer an input request, and never resend a message.
import { randomBytes, randomUUID } from "node:crypto";
import { connect } from "node:net";
import type {
  AgentAdapter,
  AgentEvent,
  AgentStatus,
  AgentTurnRequest,
} from "../../../bridge/types/agent-adapter.js";
import { createAsyncQueue } from "../../../bridge/utils/create-async-queue.js";
import {
  ACK_TIMEOUT_MS,
  AHP_PROTOCOL_VERSIONS,
  MAX_MESSAGE_BYTES,
} from "../copilot-config.js";
import { CopilotAhpClient } from "./copilot-ahp-client.js";
import {
  listLiveEndpoints,
  readValidEndpointEntry,
  type EndpointReference,
} from "./copilot-endpoint-registry.js";
import { assertChatIdle, createProviderSession, pickSession, readSendableChat } from "./copilot-session-picker.js";
import { createTurnReader } from "./copilot-turn-reader.js";
import { CLIENT_NAME } from "../../../bridge/bridge-config.js";

const FIRST_CLIENT_SEQ = 1;
const NO_ENDPOINT_MESSAGE =
  "No VS Code Agent Host is running. Open VS Code and try again.";

export interface AgentHostIdeAdapterOptions {
  endpointDirectories: string[];
  pinnedSessionId: string | null;
  provider?: string;
  ackTimeoutMs?: number;
}

export type CopilotIdeAdapterOptions = AgentHostIdeAdapterOptions;

interface OpenChat {
  client: CopilotAhpClient;
  chatResource: string;
}

export class AgentHostIdeAdapter implements AgentAdapter {
  private isTurnRunning = false;

  constructor(private readonly options: AgentHostIdeAdapterOptions) {}

  async *run(request: AgentTurnRequest): AsyncGenerator<AgentEvent> {
    if (this.isTurnRunning) throw new Error("An Agent Host turn from this relay is still running");
    this.isTurnRunning = true;
    let client: CopilotAhpClient | undefined;
    try {
      assertSendableText(request.messageText);
      const openChat = await this.openDefaultChat(request.workingDirectory);
      client = openChat.client;
      yield* this.runTurn({ ...openChat, request });
    } finally {
      client?.close();
      this.isTurnRunning = false;
    }
  }

  // Counts a host only when its socket accepts a connection, so stale entries do not.
  async readStatus(): Promise<AgentStatus> {
    const endpoints = await listLiveEndpoints({ directories: this.options.endpointDirectories });
    const probes = await Promise.all(endpoints.map(({ socketPath }) => canConnect(socketPath)));
    return { mode: "ide", hostRunning: probes.some(Boolean) };
  }

  close(): void {}

  private async *runTurn({
    client,
    chatResource,
    request,
  }: OpenChat & { request: AgentTurnRequest }): AsyncGenerator<AgentEvent> {
    const clientSeq = FIRST_CLIENT_SEQ;
    const turnId = `relay-${randomBytes(8).toString("hex")}`;
    const reader = createTurnReader({ clientId: client.clientId, clientSeq, turnId });
    const events = createAsyncQueue<AgentEvent>();
    let isAccepted = false;
    const finish = (event: AgentEvent) => {
      events.push(event);
      events.end();
    };

    client.onNotification(({ method, params }) => {
      if (method !== "action" || !hasChannel({ params, channel: chatResource })) return;
      const step = reader.read(params);
      isAccepted = step.isAccepted;
      for (const event of step.events) events.push(event);
      if (step.isFinished) events.end();
    });
    client.onClose(() =>
      finish({
        kind: "error",
        text: isAccepted
          ? "Lost connection to VS Code. The turn may still be running there."
          : DELIVERY_UNCERTAIN_MESSAGE,
      }),
    );
    const ackTimer = setTimeout(() => {
      if (!isAccepted) finish({ kind: "error", text: DELIVERY_UNCERTAIN_MESSAGE });
    }, this.options.ackTimeoutMs ?? ACK_TIMEOUT_MS);
    const stopWaiting = () =>
      finish({
        kind: "cancelled",
        text: "Stopped waiting for the Agent Host. The turn may still run in VS Code.",
      });

    request.signal.addEventListener("abort", stopWaiting, { once: true });
    try {
      client.notify({
        method: "dispatchAction",
        params: {
          channel: chatResource,
          clientSeq,
          action: {
            type: "chat/turnStarted",
            turnId,
            startedAt: new Date().toISOString(),
            message: { text: request.messageText, origin: { kind: "user" } },
          },
        },
      });
      if (request.signal.aborted) stopWaiting();
      for await (const event of events) yield event;
    } finally {
      clearTimeout(ackTimer);
      request.signal.removeEventListener("abort", stopWaiting);
    }
  }

  // Reads the entry again right before connecting, because the token can change.
  private async openDefaultChat(workingDirectory: string): Promise<OpenChat> {
    const { pinnedSessionId, endpointDirectories } = this.options;
    const provider = this.options.provider ?? "copilot";
    const endpoints = await listLiveEndpoints({ directories: endpointDirectories });
    if (endpoints.length === 0) throw new Error(NO_ENDPOINT_MESSAGE);
    if (endpoints.length > 1 && pinnedSessionId === null) {
      throw new Error(
        "More than one VS Code window is running. Set RELAY_COPILOT_SESSION_ID to choose the Copilot session.",
      );
    }
    for (const endpoint of endpoints) {
      const openChat = await this.tryOpenChat({ endpoint, pinnedSessionId, provider, workingDirectory });
      if (openChat) return openChat;
    }
    throw new Error(`Could not connect to a ${provider} session in VS Code`);
  }

  private async tryOpenChat({
    endpoint,
    pinnedSessionId,
    provider,
    workingDirectory,
  }: {
    endpoint: EndpointReference;
    pinnedSessionId: string | null;
    provider: string;
    workingDirectory: string;
  }): Promise<OpenChat | null> {
    const entry = await readValidEndpointEntry({ filePath: endpoint.filePath });
    if (!entry) return null;
    const client = await CopilotAhpClient.connect({
      socketPath: entry.socketPath,
      connectionToken: entry.connectionToken,
      protocolVersions: AHP_PROTOCOL_VERSIONS,
      clientId: `${CLIENT_NAME}-${randomUUID()}`,
    });
    try {
      const selectedSession = await pickSession({ client, pinnedSessionId, provider });
      const sessionResource = selectedSession ?? (pinnedSessionId === null
        ? await createProviderSession({ client, provider, workingDirectory })
        : null);
      if (sessionResource === null) {
        client.close();
        return null;
      }
      const chatResource = await readSendableChat({ client, sessionResource });
      await assertChatIdle({ client, chatResource });
      return { client, chatResource };
    } catch (error) {
      client.close();
      throw error;
    }
  }
}

// Kept as an alias while callers and tests migrate from the original Copilot-only name.
export { AgentHostIdeAdapter as CopilotIdeAdapter };

const DELIVERY_UNCERTAIN_MESSAGE =
  "VS Code did not confirm the message, so it may or may not have arrived. It was not resent.";

function assertSendableText(text: string): void {
  if (text.trim() === "") throw new Error("The message is empty");
  if (Buffer.byteLength(text, "utf8") > MAX_MESSAGE_BYTES) {
    throw new Error("The message is larger than 8 MiB");
  }
}

function hasChannel({ params, channel }: { params: unknown; channel: string }): boolean {
  return typeof params === "object" && params !== null && (params as { channel?: unknown }).channel === channel;
}

function canConnect(socketPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect(socketPath);
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
  });
}
