// A fake Antigravity hub on a local port that speaks gRPC-Web JSON and records every call.
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export interface FakeHubOptions {
  token?: string;
  // Polls that show RUNNING (with a waiting step when `waitsForApproval`) before IDLE.
  runningPolls?: number;
  waitsForApproval?: boolean;
  neverFinishes?: boolean;
  modelConfigsFail?: boolean;
  grpcErrorOnMethod?: string;
  dropConnectionOnSend?: boolean;
  errorStepInsteadOfReply?: boolean;
}

export interface FakeHub {
  port: number;
  token: string;
  calls: { method: string; body: Record<string, any> }[];
  callsOf(method: string): Record<string, any>[];
  close(): Promise<void>;
}

const frame = (flags: number, text: string) => {
  const payload = Buffer.from(text, "utf8");
  const header = Buffer.alloc(5);
  header[0] = flags;
  header.writeUInt32BE(payload.length, 1);
  return Buffer.concat([header, payload]);
};

export async function startFakeHub(options: FakeHubOptions = {}): Promise<FakeHub> {
  const token = options.token ?? "11111111-2222-4333-8444-555555555555";
  const calls: FakeHub["calls"] = [];
  const steps: Record<string, any>[] = [];
  let pollsSinceSend = 0;
  let hasSent = false;

  const summary = () => {
    const isRunning = hasSent && (options.neverFinishes || pollsSinceSend <= (options.runningPolls ?? 1));
    return {
      status: isRunning ? "CASCADE_RUN_STATUS_RUNNING" : "CASCADE_RUN_STATUS_IDLE",
      stepCount: steps.length,
      notFullyIdle: false,
      hasRunningSubagents: false,
      backgroundTaskCount: 0,
      waitingSteps: isRunning && options.waitsForApproval ? [{ stepIndex: steps.length - 1 }] : [],
    };
  };

  const handle = (method: string, body: Record<string, any>, response: ServerResponse) => {
    if (method === options.grpcErrorOnMethod) return finish(response, "grpc-status: 13\r\ngrpc-message: boom%20happened\r\n");
    switch (method) {
      case "GetCascadeModelConfigs":
        return finish(response, "grpc-status: 0\r\n", {}); // the real hub returns nothing here
      case "GetUserStatus":
        if (options.modelConfigsFail) return finish(response, "grpc-status: 2\r\n");
        return finish(response, "grpc-status: 0\r\n", {
          userStatus: { cascadeModelConfigData: { defaultOverrideModelConfig: { modelOrAlias: { model: "MODEL_FAKE_1" } } } },
        });
      case "StartCascade":
        return finish(response, "grpc-status: 0\r\n", { cascadeId: body.cascadeId });
      case "SendUserCascadeMessage":
        hasSent = true;
        pollsSinceSend = 0;
        steps.push({ type: "CORTEX_STEP_TYPE_USER_INPUT" });
        steps.push(
          options.errorStepInsteadOfReply
            ? { type: "CORTEX_STEP_TYPE_ERROR_MESSAGE", status: "CORTEX_STEP_STATUS_DONE", errorMessage: { error: { userErrorMessage: "Agent execution terminated due to error.", shortError: "unknown model key: model not found" } } }
            : { type: "CORTEX_STEP_TYPE_PLANNER_RESPONSE", plannerResponse: { response: ` reply to: ${body.items[0].text} ` } },
        );
        return finish(response, "grpc-status: 0\r\n");
      case "GetAllCascadeTrajectories":
        pollsSinceSend += 1;
        return finish(response, "grpc-status: 0\r\n", { trajectorySummaries: { [findCascadeId()]: summary() } });
      case "GetCascadeTrajectorySteps":
        return finish(response, "grpc-status: 0\r\n", { steps });
      default:
        return finish(response, "grpc-status: 0\r\n");
    }
  };

  const findCascadeId = () => calls.find((call) => call.method === "StartCascade")?.body.cascadeId;

  const server = createServer(async (request, response) => {
    if (request.url === "/healthz") return void response.writeHead(200).end("ok");
    if (request.headers["x-codeium-csrf-token"] !== token) return void response.writeHead(403).end("denied");
    const method = request.url?.split("/").pop() ?? "";
    const body = await readFrameBody(request);
    calls.push({ method, body });
    if (method === "SendUserCascadeMessage" && options.dropConnectionOnSend) return void request.socket.destroy();
    handle(method, body, response);
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    port: (server.address() as AddressInfo).port,
    token,
    calls,
    callsOf: (method) => calls.filter((call) => call.method === method).map((call) => call.body),
    close: () => new Promise((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }),
  };
}

function finish(response: ServerResponse, trailer: string, data?: Record<string, any>) {
  response.writeHead(200, { "Content-Type": "application/grpc-web+json" });
  const dataFrame = data ? frame(0, JSON.stringify(data)) : Buffer.alloc(0);
  response.end(Buffer.concat([dataFrame, frame(0x80, trailer)]));
}

async function readFrameBody(request: IncomingMessage): Promise<Record<string, any>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  const bytes = Buffer.concat(chunks);
  return JSON.parse(bytes.subarray(5, 5 + bytes.readUInt32BE(1)).toString("utf8"));
}
