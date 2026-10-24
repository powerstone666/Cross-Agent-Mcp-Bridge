// JSON-RPC over a WebSocket on the host's Unix socket, with the AHP initialize handshake.
// Never put the token in an error, a log line or a return value.
import { connect } from "node:net";
import WebSocket from "ws";
import { isRecord } from "../../../bridge/utils/is-record.js";
import {
  REQUEST_TIMEOUT_MS,
  ROOT_CHANNEL,
} from "../copilot-config.js";
import { CLIENT_NAME, CLIENT_VERSION } from "../../../bridge/bridge-config.js";

const METHOD_NOT_FOUND = -32601;
const HANDSHAKE_TIMEOUT_MS = 10_000;
const MAX_FRAME_BYTES = 64 * 1024 * 1024;

type NotificationHandler = (notification: { method: string; params: unknown }) => void;

interface PendingRequest {
  resolve(result: unknown): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
}

export interface ConnectInput {
  socketPath: string;
  connectionToken: string;
  protocolVersions: readonly string[];
  clientId: string;
}

export class CopilotAhpClient {
  private nextRequestId = 1;
  private readonly pendingRequests = new Map<number, PendingRequest>();
  private notificationHandler: NotificationHandler = () => {};
  private closeHandler: () => void = () => {};
  private isClosed = false;

  private constructor(
    private readonly socket: WebSocket,
    private readonly connectionToken: string,
    readonly clientId: string,
    private protocolVersionValue = "",
  ) {
    socket.on("message", (data, isBinary) => {
      if (!isBinary) this.handleText(data.toString("utf8"));
    });
    socket.on("close", () => this.handleClosed());
    socket.on("error", () => this.handleClosed());
  }

  get protocolVersion(): string {
    return this.protocolVersionValue;
  }

  // Connects, runs `initialize` and keeps only a protocol version this relay offered.
  static async connect(input: ConnectInput): Promise<CopilotAhpClient> {
    const socket = await openSocket(input);
    const client = new CopilotAhpClient(socket, input.connectionToken, input.clientId);
    try {
      const result = await client.request({
        method: "initialize",
        params: {
          channel: ROOT_CHANNEL,
          protocolVersions: input.protocolVersions,
          clientId: input.clientId,
          clientInfo: { name: CLIENT_NAME, version: CLIENT_VERSION },
        },
      });
      const agreedVersion = isRecord(result) ? result.protocolVersion : undefined;
      if (typeof agreedVersion !== "string" || !input.protocolVersions.includes(agreedVersion)) {
        throw new Error(
          `The VS Code agent host speaks protocol ${String(agreedVersion)}; this relay supports ${input.protocolVersions.join(", ")}`,
        );
      }
      client.protocolVersionValue = agreedVersion;
      return client;
    } catch (error) {
      client.close();
      throw error;
    }
  }

  onNotification(handler: NotificationHandler): void {
    this.notificationHandler = handler;
  }

  onClose(handler: () => void): void {
    this.closeHandler = handler;
  }

  request({ method, params }: { method: string; params: unknown }): Promise<unknown> {
    if (this.isClosed) return Promise.reject(new Error("Connection to VS Code is closed"));
    const id = this.nextRequestId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`VS Code did not answer ${method} in time`));
      }, REQUEST_TIMEOUT_MS);
      this.pendingRequests.set(id, { resolve, reject, timer });
      this.send({ jsonrpc: "2.0", id, method, params });
    });
  }

  notify({ method, params }: { method: string; params: unknown }): void {
    if (this.isClosed) throw new Error("Connection to VS Code is closed");
    this.send({ jsonrpc: "2.0", method, params });
  }

  close(): void {
    this.socket.terminate();
    this.handleClosed();
  }

  private send(message: unknown): void {
    this.socket.send(JSON.stringify(message));
  }

  private handleText(text: string): void {
    let message: unknown;
    try {
      message = JSON.parse(text);
    } catch {
      return;
    }
    if (!isRecord(message)) return;

    const { id, method } = message;
    if (typeof method === "string") {
      if (id === undefined) this.notificationHandler({ method, params: message.params });
      else this.send({ jsonrpc: "2.0", id, error: { code: METHOD_NOT_FOUND, message: "Method not found" } });
      return;
    }
    const pending = typeof id === "number" ? this.pendingRequests.get(id) : undefined;
    if (!pending || typeof id !== "number") return;
    this.pendingRequests.delete(id);
    clearTimeout(pending.timer);
    if (isRecord(message.error)) {
      pending.reject(new Error(this.redact(String(message.error.message ?? "Request failed"))));
    } else {
      pending.resolve(message.result);
    }
  }

  private handleClosed(): void {
    if (this.isClosed) return;
    this.isClosed = true;
    for (const pending of this.pendingRequests.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error("Connection to VS Code was lost"));
    }
    this.pendingRequests.clear();
    this.closeHandler();
  }

  private redact(text: string): string {
    return redactToken(text, this.connectionToken);
  }
}

function redactToken(text: string, token: string): string {
  return text.replaceAll(token, "[token]").replaceAll(encodeURIComponent(token), "[token]");
}

function openSocket({ socketPath, connectionToken }: ConnectInput): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://localhost/?tkn=${encodeURIComponent(connectionToken)}`, {
      // ws ignores a plain `socketPath` option, so hand it the connection itself.
      createConnection: () => connect(socketPath),
      // Offering no extension makes ws reject any extension the host answers with.
      perMessageDeflate: false,
      handshakeTimeout: HANDSHAKE_TIMEOUT_MS,
      maxPayload: MAX_FRAME_BYTES,
    });
    socket.once("open", () => resolve(socket));
    socket.once("error", (error) => {
      // ws errors can echo the request URL, which holds the token.
      reject(new Error(`Could not connect to the VS Code agent host: ${redactToken(error.message, connectionToken)}`));
    });
  });
}
