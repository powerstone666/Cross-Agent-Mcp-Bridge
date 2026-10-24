// Sends a relay message into Antigravity's own agent (a "cascade") and reads the reply back.
// Never answer the IDE's approval prompts and never resend a message: the human decides in the IDE.
import { randomUUID } from "node:crypto";
import type {
  AgentAdapter,
  AgentEvent,
  AgentStatus,
  AgentTurnRequest,
} from "../../../bridge/types/agent-adapter.js";
import {
  CASCADE_SOURCE,
  POLL_INTERVAL_MS,
  TIMEOUT_MESSAGE,
  TRAJECTORY_VERBOSITY,
  WAITING_FOR_APPROVAL_LINE,
  readIdeTimeoutMs,
} from "./antigravity-config.js";
import {
  discoverHub,
  isHubHealthy,
  listProcesses,
  parseHubProcessLines,
  type ListProcesses,
} from "./antigravity-hub-discovery.js";
import { HubClient, HubTransportError, type HubJson } from "./antigravity-hub-client.js";

const PLANNER_RESPONSE_STEP = "CORTEX_STEP_TYPE_PLANNER_RESPONSE";
const ERROR_STEP_STATUS = "CORTEX_STEP_STATUS_ERROR";
const ERROR_STEP_TYPE = "CORTEX_STEP_TYPE_ERROR_MESSAGE";
const BUSY_RUN_STATUSES = ["CASCADE_RUN_STATUS_RUNNING", "CASCADE_RUN_STATUS_BUSY"];
const DELIVERY_UNCERTAIN_MESSAGE =
  "Antigravity did not confirm the message, so it may or may not have arrived. It was not resent.";

export interface GeminiIdeAdapterOptions {
  environment?: NodeJS.ProcessEnv;
  listProcesses?: ListProcesses;
  pollIntervalMs?: number;
  timeoutMs?: number;
}

interface TurnContext {
  client: HubClient;
  cascadeId: string;
  stepCountBefore: number;
  request: AgentTurnRequest;
}

export class GeminiIdeAdapter implements AgentAdapter {
  private isTurnRunning = false;
  private readonly cascadeByFolder = new Map<string, string>();
  // undefined = not read yet; null = the hub gave no model, so the hub picks its own default.
  private cachedModel: string | null | undefined;

  constructor(private readonly options: GeminiIdeAdapterOptions = {}) {}

  async *run(request: AgentTurnRequest): AsyncGenerator<AgentEvent> {
    if (this.isTurnRunning) throw new Error("An Antigravity turn from this relay is still running");
    this.isTurnRunning = true;
    try {
      yield* this.runTurn(request);
    } finally {
      this.isTurnRunning = false;
    }
  }

  async readStatus(): Promise<AgentStatus> {
    const hubs = parseHubProcessLines(await this.listProcessOutput());
    const health = await Promise.all(hubs.map(isHubHealthy));
    const hubCount = health.filter(Boolean).length;
    return { mode: "ide", hubRunning: hubCount > 0, hubCount };
  }

  close(): void {}

  private listProcessOutput(): Promise<string> {
    return (this.options.listProcesses ?? listProcesses)();
  }

  private async *runTurn(request: AgentTurnRequest): AsyncGenerator<AgentEvent> {
    if (request.messageText.trim() === "") throw new Error("The message is empty");
    const hub = await discoverHub({
      listProcesses: () => this.listProcessOutput(),
      workingDirectory: request.workingDirectory,
    });
    const client = new HubClient(hub);
    const model = await this.readModel(client);
    const cascadeId = await this.findOrStartCascade({ client, folder: request.workingDirectory });
    const stepCountBefore = (await readSummary({ client, cascadeId }))?.stepCount ?? 0;
    try {
      await client.callHub("SendUserCascadeMessage", {
        cascadeId,
        items: [{ text: request.messageText }],
        cascadeConfig: {
          plannerConfig: {
            ...(model && { planModel: model }),
            conversational: {
              plannerMode: "CONVERSATIONAL_PLANNER_MODE_DEFAULT",
              agenticMode: true,
            },
          },
        },
      });
    } catch (error) {
      if (!(error instanceof HubTransportError)) throw error;
      yield { kind: "error", text: DELIVERY_UNCERTAIN_MESSAGE };
      return;
    }
    yield* this.waitForReply({ client, cascadeId, stepCountBefore, request });
  }

  // The account's model list is in GetUserStatus; GetCascadeModelConfigs comes back empty.
  private async readModel(client: HubClient): Promise<string | null> {
    if (this.cachedModel !== undefined) return this.cachedModel;
    try {
      const { userStatus } = await client.callHub("GetUserStatus", {});
      this.cachedModel = pickDefaultModel(userStatus?.cascadeModelConfigData ?? {});
    } catch {
      return null;
    }
    return this.cachedModel;
  }

  private async findOrStartCascade({
    client,
    folder,
  }: {
    client: HubClient;
    folder: string;
  }): Promise<string> {
    const known = this.cascadeByFolder.get(folder);
    if (known) return known;
    const cascadeId = randomUUID();
    await client.callHub("StartCascade", {
      cascadeId,
      source: CASCADE_SOURCE,
      workspaceUris: [`file://${folder}`],
    });
    this.cascadeByFolder.set(folder, cascadeId);
    return cascadeId;
  }

  private async *waitForReply(context: TurnContext): AsyncGenerator<AgentEvent> {
    const { client, cascadeId, stepCountBefore, request } = context;
    const pollIntervalMs = this.options.pollIntervalMs ?? POLL_INTERVAL_MS;
    const timeoutMs = this.options.timeoutMs ?? readIdeTimeoutMs(this.options.environment ?? {});
    const deadline = Date.now() + timeoutMs;
    let hasStarted = false;
    let hasAnnouncedWaiting = false;

    while (true) {
      if (request.signal.aborted) return yield await cancelCascade(context);
      if (Date.now() >= deadline) return yield { kind: "error", text: TIMEOUT_MESSAGE };
      await sleep({ ms: pollIntervalMs, signal: request.signal });
      if (request.signal.aborted) continue;

      const summary = await readSummary({ client, cascadeId });
      if (!summary) continue;
      hasStarted ||= (summary.stepCount ?? 0) > stepCountBefore || isBusy(summary);
      if (hasWaitingSteps(summary) && !hasAnnouncedWaiting) {
        hasAnnouncedWaiting = true;
        yield { kind: "reply_delta", text: WAITING_FOR_APPROVAL_LINE };
      }
      if (hasStarted && isFullyIdle(summary)) break;
    }
    yield* this.readAnswer(context);
  }

  private async *readAnswer({
    client,
    cascadeId,
    stepCountBefore,
  }: TurnContext): AsyncGenerator<AgentEvent> {
    const { steps = [] } = await client.callHub("GetCascadeTrajectorySteps", {
      cascadeId,
      stepOffset: 0,
      trajectoryVerbosity: TRAJECTORY_VERBOSITY,
    });
    const newSteps: HubJson[] = steps.slice(stepCountBefore);
    const answer = findAnswerText(newSteps);
    if (answer) {
      yield { kind: "reply_delta", text: answer };
      yield { kind: "reply_complete", text: "" };
      return;
    }
    const failedStep = newSteps.find(
      (step) => step.status === ERROR_STEP_STATUS || step.type === ERROR_STEP_TYPE,
    );
    const reason = describeStepError(failedStep) ?? "Antigravity finished without a reply";
    yield { kind: "error", text: reason };
  }
}

function pickDefaultModel(configs: HubJson): string | null {
  const override = configs.defaultOverrideModelConfig?.modelOrAlias;
  const first = configs.clientModelConfigs?.[0]?.modelOrAlias;
  const candidate = override ?? first;
  return typeof candidate === "string" ? candidate : (candidate?.model ?? null);
}

async function readSummary({
  client,
  cascadeId,
}: {
  client: HubClient;
  cascadeId: string;
}): Promise<HubJson | undefined> {
  const { trajectorySummaries } = await client.callHub("GetAllCascadeTrajectories", {});
  return trajectorySummaries?.[cascadeId];
}

const isBusy = (summary: HubJson) => BUSY_RUN_STATUSES.includes(summary.status);
const hasWaitingSteps = (summary: HubJson) => (summary.waitingSteps?.length ?? 0) > 0;

function isFullyIdle(summary: HubJson): boolean {
  return (
    summary.status === "CASCADE_RUN_STATUS_IDLE" &&
    !summary.notFullyIdle &&
    !summary.hasRunningSubagents &&
    !summary.backgroundTaskCount &&
    !hasWaitingSteps(summary)
  );
}

function findAnswerText(steps: HubJson[]): string {
  for (const step of [...steps].reverse()) {
    const text = step.plannerResponse?.response?.trim();
    if (step.type === PLANNER_RESPONSE_STEP && text) return text;
  }
  for (const step of [...steps].reverse()) {
    const text = step.notifyUser?.notificationContent?.trim();
    if (text) return text;
  }
  return "";
}

async function cancelCascade({ client, cascadeId }: TurnContext): Promise<AgentEvent> {
  try {
    await client.callHub("CancelCascadeInvocation", { cascadeId, killBackgroundTasks: false });
  } catch {
    // The turn is abandoned either way.
  }
  return { kind: "cancelled", text: "Turn cancelled" };
}

function sleep({ ms, signal }: { ms: number; signal: AbortSignal }): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });
}

// A failed run shows up as an error-message step. Its short error says why.
function describeStepError(step: HubJson | undefined): string | undefined {
  const error = step?.errorMessage?.error ?? step?.error;
  const parts = [error?.userErrorMessage, error?.shortError].filter(Boolean);
  return parts.length > 0 ? parts.join(": ") : undefined;
}

