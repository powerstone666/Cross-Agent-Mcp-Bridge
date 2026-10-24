// A fake VS Code agent host: Unix socket, HTTP upgrade to WebSocket, JSON-RPC, and a registry entry.
// Test-only. It speaks just enough of the protocol for the Copilot adapter.
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { Socket } from "node:net";
import { join } from "node:path";

const WEBSOCKET_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
export const FAKE_TOKEN = "dummy-token-abc123";
export const FAKE_SESSION = "copilot:/session-1";
export const FAKE_CHAT = "copilot:/session-1/chat-1";

export type TurnBehavior =
  | "reply"
  | "busy"
  | "error"
  | "drop"
  | "silent"
  | "pending-confirmation";

export interface FakeAhpOptions {
  behavior?: TurnBehavior;
  protocolVersion?: string;
  lifecycle?: string;
  chatInteractivity?: string;
  chatHasActiveTurn?: boolean;
  sessions?: Array<{ resource: string; modifiedAt: string }>;
  provider?: string;
  token?: string;
}

type Message = Record<string, unknown>;

export interface FakeAhpServer {
  registryDirectory: string;
  entryFilePath: string;
  received: Message[];
  stop(): Promise<void>;
}

export async function startFakeAhpServer(options: FakeAhpOptions = {}): Promise<FakeAhpServer> {
  // Short names: macOS limits a Unix socket path to 104 characters.
  const rootDirectory = await mkdtemp("/tmp/ahp-");
  const socketPath = join(rootDirectory, "s.sock");
  const registryDirectory = join(rootDirectory, "reg");
  const token = options.token ?? FAKE_TOKEN;
  const received: Message[] = [];
  const sockets = new Set<Socket>();
  let clientId = "";
  let currentSession = FAKE_SESSION;
  let currentChat = FAKE_CHAT;
  let currentProvider = options.provider ?? "copilot";

  const server: Server = createServer();
  server.on("upgrade", (request: IncomingMessage, socket: Socket) => {
    sockets.add(socket);
    const url = new URL(request.url ?? "/", "http://localhost");
    const key = request.headers["sec-websocket-key"];
    if (url.searchParams.get("tkn") !== token || typeof key !== "string") {
      socket.end("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
      return;
    }
    const accept = createHash("sha1").update(key + WEBSOCKET_GUID).digest("base64");
    socket.write(
      `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );
    let buffered = Buffer.alloc(0);
    socket.on("data", (chunk: Buffer) => {
      buffered = Buffer.concat([buffered, chunk]);
      for (;;) {
        const frame = readMaskedFrame(buffered);
        if (!frame) return;
        buffered = buffered.subarray(frame.consumed);
        if (frame.opcode === 1) handle(JSON.parse(frame.text) as Message, socket);
      }
    });
    socket.on("error", () => {});
  });

  function send(socket: Socket, message: unknown) {
    socket.write(encodeTextFrame(JSON.stringify(message)));
  }

  function emitAction(socket: Socket, action: Message, origin?: Message, rejectionReason?: string) {
    send(socket, {
      jsonrpc: "2.0",
      method: "action",
      params: { channel: currentChat, serverSeq: 1, action, origin, rejectionReason },
    });
  }

  function handle(message: Message, socket: Socket) {
    received.push(message);
    const { id, method } = message;
    const params = (message.params ?? {}) as Message;
    if (method === "initialize") {
      clientId = String(params.clientId);
      send(socket, { jsonrpc: "2.0", id, result: { protocolVersion: options.protocolVersion ?? "0.8.0", serverSeq: 0 } });
    } else if (method === "listSessions") {
      const items = options.sessions ?? [{ resource: FAKE_SESSION, modifiedAt: "2026-01-01T00:00:00Z" }];
      send(socket, { jsonrpc: "2.0", id, result: { items } });
    } else if (method === "createSession") {
      currentSession = String(params.channel);
      currentChat = `${currentSession}/chat-1`;
      currentProvider = String(params.provider);
      send(socket, { jsonrpc: "2.0", id, result: null });
    } else if (method === "subscribe") {
      send(socket, { jsonrpc: "2.0", id, result: { snapshot: snapshotFor(String(params.channel)) } });
    } else if (method === "dispatchAction") {
      respondToTurn(socket, params);
    }
  }

  function snapshotFor(channel: string) {
    if (channel === currentChat) {
      const state: Message = { resource: currentChat, interactivity: options.chatInteractivity ?? "full" };
      if (options.chatHasActiveTurn) state.activeTurn = { id: "other" };
      return { resource: channel, state };
    }
    return {
      resource: channel,
      state: {
        provider: currentProvider,
        lifecycle: options.lifecycle ?? "ready",
        defaultChat: currentChat,
        chats: [{ resource: currentChat, interactivity: options.chatInteractivity ?? "full" }],
      },
    };
  }

  function respondToTurn(socket: Socket, params: Message) {
    const behavior = options.behavior ?? "reply";
    const action = params.action as Message;
    const origin = { clientId, clientSeq: params.clientSeq };
    const turnId = action.turnId as string;
    if (behavior === "silent") return;
    if (behavior === "drop") return socket.destroy();
    if (behavior === "busy") return emitAction(socket, action, origin, "chat is busy");

    emitAction(socket, action, origin);
    if (behavior === "error") {
      emitAction(socket, { type: "chat/error", turnId, duration: 1, part: { kind: "error", error: { errorType: "x", message: "model failed" } } });
      return;
    }
    if (behavior === "pending-confirmation") {
      emitAction(socket, { type: "chat/toolCallStart", turnId, toolCallId: "t1", toolName: "run", displayName: "Run" });
      emitAction(socket, { type: "chat/toolCallReady", turnId, toolCallId: "t1", invocationMessage: "run ls" });
      // The relay must not confirm. Finish only if it stayed silent.
      setTimeout(() => emitAction(socket, { type: "chat/turnComplete", turnId, duration: 1 }), 150);
      return;
    }
    emitAction(socket, { type: "chat/responsePart", turnId, part: { kind: "markdown", id: "p1", content: "Hello" } });
    emitAction(socket, { type: "chat/delta", turnId, partId: "p1", content: " world" });
    emitAction(socket, { type: "chat/turnComplete", turnId, duration: 1 });
  }

  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  const pid = process.pid;
  const instanceId = randomUUID();
  const entryFilePath = await writeEntry({ registryDirectory, pid, instanceId, socketPath, token });

  return {
    registryDirectory,
    entryFilePath,
    received,
    async stop() {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => server.close(resolve));
      await rm(rootDirectory, { recursive: true, force: true });
    },
  };
}

// Writes an entry named after its identity, as VS Code does. Tests overwrite fields to break it.
export async function writeEntry({
  registryDirectory,
  pid,
  instanceId,
  socketPath,
  token,
  fileName,
  overrides = {},
}: {
  registryDirectory: string;
  pid: number;
  instanceId: string;
  socketPath: string;
  token: string;
  fileName?: string;
  overrides?: Message;
}): Promise<string> {
  const { mkdir } = await import("node:fs/promises");
  await mkdir(registryDirectory, { recursive: true });
  const name = fileName ?? createHash("sha256").update(`editor\0${pid}\0${instanceId}`).digest("hex");
  const filePath = join(registryDirectory, `${name}.json`);
  await writeFile(
    filePath,
    JSON.stringify({
      schemaVersion: 2,
      type: "editor",
      pid,
      instanceId,
      endpoint: { type: "socket", path: socketPath },
      connectionToken: token,
      protocolVersion: "0.8.0",
      ...overrides,
    }),
  );
  return filePath;
}

function readMaskedFrame(buffer: Buffer): { opcode: number; text: string; consumed: number } | null {
  if (buffer.length < 2) return null;
  const opcode = buffer[0]! & 0x0f;
  let length = buffer[1]! & 0x7f;
  let offset = 2;
  if (length === 126) {
    if (buffer.length < 4) return null;
    length = buffer.readUInt16BE(2);
    offset = 4;
  } else if (length === 127) {
    if (buffer.length < 10) return null;
    length = Number(buffer.readBigUInt64BE(2));
    offset = 10;
  }
  if (buffer.length < offset + 4 + length) return null;
  const mask = buffer.subarray(offset, offset + 4);
  const payload = Buffer.from(buffer.subarray(offset + 4, offset + 4 + length));
  for (let index = 0; index < payload.length; index++) payload[index]! ^= mask[index % 4]!;
  return { opcode, text: payload.toString("utf8"), consumed: offset + 4 + length };
}

function encodeTextFrame(text: string): Buffer {
  const payload = Buffer.from(text, "utf8");
  const header =
    payload.length < 126
      ? Buffer.from([0x81, payload.length])
      : payload.length < 65536
        ? Buffer.from([0x81, 126, payload.length >> 8, payload.length & 0xff])
        : Buffer.concat([Buffer.from([0x81, 127]), Buffer.alloc(8)]);
  if (payload.length >= 65536) header.writeBigUInt64BE(BigInt(payload.length), 2);
  return Buffer.concat([header, payload]);
}
