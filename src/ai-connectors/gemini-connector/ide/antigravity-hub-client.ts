// Calls the Antigravity hub with gRPC-Web JSON frames over plain http.
import {
  CSRF_HEADER,
  HOST_CLIENT_HEADER,
  HOST_CLIENT_VALUE,
  HUB_HOST,
  HUB_SERVICE_PATH,
} from "./antigravity-config.js";

const FLAG_DATA = 0x00;
const FLAG_TRAILER = 0x80;
const FRAME_HEADER_BYTES = 5;

// The request may or may not have reached the hub.
export class HubTransportError extends Error {}

export type HubJson = Record<string, any>;

export function encodeFrame(body: HubJson): Buffer {
  const payload = Buffer.from(JSON.stringify(body), "utf8");
  const header = Buffer.alloc(FRAME_HEADER_BYTES);
  header.writeUInt32BE(payload.length, 1);
  return Buffer.concat([header, payload]);
}

export function decodeFrames(bytes: Buffer): { data: HubJson; trailer: string } {
  let data: HubJson = {};
  let trailer = "";
  let offset = 0;
  while (offset + FRAME_HEADER_BYTES <= bytes.length) {
    const flags = bytes.readUInt8(offset);
    const length = bytes.readUInt32BE(offset + 1);
    const payload = bytes.subarray(offset + FRAME_HEADER_BYTES, offset + FRAME_HEADER_BYTES + length);
    offset += FRAME_HEADER_BYTES + length;
    if (flags === FLAG_TRAILER) trailer += payload.toString("utf8");
    else if (flags === FLAG_DATA && length > 0) data = JSON.parse(payload.toString("utf8"));
  }
  return { data, trailer };
}

function readTrailerField({ trailer, name }: { trailer: string; name: string }): string | null {
  const match = new RegExp(`^${name}:\\s*(.*)$`, "im").exec(trailer);
  return match?.[1]?.trim() ?? null;
}

function assertGrpcOk({ status, message }: { status: string | null; message: string | null }) {
  if (status === null || status === "0") return;
  const text = message ? safeDecode(message) : "";
  throw new Error(`Antigravity returned an error (grpc-status ${status})${text ? `: ${text}` : ""}`);
}

function safeDecode(text: string): string {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

export class HubClient {
  constructor(private readonly hub: { port: number; csrfToken: string }) {}

  async callHub(method: string, body: HubJson): Promise<HubJson> {
    let response: Response;
    let bytes: Buffer;
    try {
      response = await fetch(`http://${HUB_HOST}:${this.hub.port}${HUB_SERVICE_PATH}${method}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/grpc-web+json",
          "X-Grpc-Web": "1",
          [CSRF_HEADER]: this.hub.csrfToken,
          [HOST_CLIENT_HEADER]: HOST_CLIENT_VALUE,
        },
        body: new Uint8Array(encodeFrame(body)),
      });
      bytes = Buffer.from(await response.arrayBuffer());
    } catch (error) {
      throw new HubTransportError(`Could not reach Antigravity (${describeNetworkError(error)})`);
    }
    if (!response.ok) throw new Error(`Antigravity returned HTTP ${response.status} for ${method}`);
    assertGrpcOk({
      status: response.headers.get("grpc-status"),
      message: response.headers.get("grpc-message"),
    });
    const { data, trailer } = decodeFrames(bytes);
    assertGrpcOk({
      status: readTrailerField({ trailer, name: "grpc-status" }),
      message: readTrailerField({ trailer, name: "grpc-message" }),
    });
    return data;
  }
}

function describeNetworkError(error: unknown): string {
  const cause = (error as { cause?: { code?: string } }).cause;
  return cause?.code ?? (error instanceof Error ? error.name : "network error");
}
