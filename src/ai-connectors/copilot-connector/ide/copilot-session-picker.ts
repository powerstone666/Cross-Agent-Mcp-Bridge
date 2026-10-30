// Chooses a session for the requested provider, creating one when the host has none.
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { isRecord } from "../../../bridge/utils/is-record.js";
import { ROOT_CHANNEL } from "../copilot-config.js";
import type { CopilotAhpClient } from "./copilot-ahp-client.js";

const SESSION_PAGE_SIZE = 50;
const MAX_SESSION_PAGES = 4;
const SESSION_START_TIMEOUT_MS = 30_000;

interface SessionCandidate {
  resource: string;
  modifiedMs: number;
  // The host lists these; when it does not, they are read from the session state.
  provider: string | undefined;
  workingDirectories: string[] | undefined;
}

// Returns null when this host has no matching session. Throws when a pin matches several.
// Without a pin, only a session in `workingDirectory` is reused, so the chat opens in that project.
export async function pickSession({
  client,
  pinnedSessionId,
  provider,
  workingDirectory,
}: {
  client: CopilotAhpClient;
  pinnedSessionId: string | null;
  provider: string;
  workingDirectory: string;
}): Promise<string | null> {
  const candidates = await listSessions({ client });
  const candidateMatches = candidates
    .filter(({ resource }) => pinnedSessionId === null || matchesId({ resource, id: pinnedSessionId }))
    .sort((first, second) => second.modifiedMs - first.modifiedMs);
  if (pinnedSessionId === null) {
    const folder = pathToFileURL(workingDirectory).href;
    for (const candidate of candidateMatches) {
      const facts = await readSessionFacts({ client, candidate });
      // A session the host cannot restore is skipped; a new one is created instead.
      if (!facts || facts.provider !== provider) continue;
      if (!facts.workingDirectories || facts.workingDirectories.includes(folder)) return candidate.resource;
    }
    return null;
  }
  const providerMatches: string[] = [];
  for (const candidate of candidateMatches) {
    const state = await readState({ client, channel: candidate.resource });
    if (state.provider === provider) providerMatches.push(candidate.resource);
  }
  const matches = providerMatches;
  if (matches.length > 1) {
    throw new Error("The configured session id matches more than one session for this provider");
  }
  return matches[0] ?? null;
}

// Waits for the host to finish creating the backend before reading its default chat.
export async function createProviderSession({
  client,
  provider,
  workingDirectory,
}: {
  client: CopilotAhpClient;
  provider: string;
  workingDirectory: string;
}): Promise<string> {
  const sessionResource = `ahp-session:/${randomUUID()}`;
  let timer: NodeJS.Timeout;
  const ready = new Promise<void>((resolve, reject) => {
    timer = setTimeout(
      () => reject(new Error(`VS Code did not start the ${provider} session in time`)),
      SESSION_START_TIMEOUT_MS,
    );
    client.onNotification(({ method, params }) => {
      if (method !== "action" || !isRecord(params) || params.channel !== sessionResource || !isRecord(params.action)) return;
      if (params.action.type === "session/ready") {
        resolve();
      } else if (params.action.type === "session/creationFailed") {
        const error = isRecord(params.action.error) && typeof params.action.error.message === "string"
          ? params.action.error.message
          : `VS Code could not start ${provider}`;
        reject(new Error(error));
      }
    });
  });

  try {
    await client.request({
      method: "createSession",
      params: {
        channel: sessionResource,
        provider,
        workingDirectories: [pathToFileURL(workingDirectory).href],
      },
    });
    const snapshot = await client.request({ method: "subscribe", params: { channel: sessionResource } });
    const state = isRecord(snapshot) && isRecord(snapshot.snapshot) && isRecord(snapshot.snapshot.state)
      ? snapshot.snapshot.state
      : undefined;
    if (state?.lifecycle === "ready") return sessionResource;
    if (state?.lifecycle === "failed") {
      throw new Error(`VS Code could not start ${provider}`);
    }
    // Some providers (copilotcli) defer the backend until the first message, so the session
    // stays "creating" until a turn is sent. The default chat already exists and takes that turn.
    if (state?.lifecycle === "creating" && typeof state.defaultChat === "string") return sessionResource;
    await ready;
    return sessionResource;
  } finally {
    clearTimeout(timer!);
  }
}

// Returns the default chat resource once the session is ready and the chat takes input.
export async function readSendableChat({
  client,
  sessionResource,
}: {
  client: CopilotAhpClient;
  sessionResource: string;
}): Promise<string> {
  const session = await readState({ client, channel: sessionResource });
  const chatResource = session.defaultChat;
  if (session.lifecycle !== "ready" && !(session.lifecycle === "creating" && typeof chatResource === "string")) {
    throw new Error("The VS Code agent session is not ready yet");
  }
  if (typeof chatResource !== "string") throw new Error("The VS Code agent session has no default chat");
  const summaries = Array.isArray(session.chats) ? session.chats : [];
  const summary = summaries.find((chat) => isRecord(chat) && chat.resource === chatResource);
  // The real host omits `interactivity` on a summary; only an explicit non-"full" value blocks sending.
  if (!isRecord(summary) || (summary.interactivity !== undefined && summary.interactivity !== "full")) {
    throw new Error("The default VS Code agent chat does not accept messages");
  }
  return chatResource;
}

export async function assertChatIdle({
  client,
  chatResource,
}: {
  client: CopilotAhpClient;
  chatResource: string;
}): Promise<void> {
  const chat = await readState({ client, channel: chatResource });
  if (chat.interactivity !== undefined && chat.interactivity !== "full") {
    throw new Error("The default VS Code agent chat does not accept messages");
  }
  if (chat.activeTurn !== undefined) {
    throw new Error("The VS Code agent chat is busy with another turn. Try again when it finishes.");
  }
}

async function readSessionFacts({
  client,
  candidate,
}: {
  client: CopilotAhpClient;
  candidate: SessionCandidate;
}): Promise<{ provider: unknown; workingDirectories: string[] | undefined } | undefined> {
  if (candidate.provider !== undefined && candidate.workingDirectories !== undefined) return candidate;
  try {
    const state = await readState({ client, channel: candidate.resource });
    return { provider: candidate.provider ?? state.provider, workingDirectories: candidate.workingDirectories ?? readStrings(state.workingDirectories) };
  } catch {
    return undefined;
  }
}

function readStrings(value: unknown): string[] | undefined {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : undefined;
}

async function readState({
  client,
  channel,
}: {
  client: CopilotAhpClient;
  channel: string;
}): Promise<Record<string, unknown>> {
  const result = await client.request({ method: "subscribe", params: { channel } });
  const snapshot = isRecord(result) ? result.snapshot : undefined;
  if (!isRecord(snapshot) || !isRecord(snapshot.state)) {
    throw new Error("VS Code returned no state for the agent session");
  }
  return snapshot.state;
}

async function listSessions({ client }: { client: CopilotAhpClient }): Promise<SessionCandidate[]> {
  const candidates: SessionCandidate[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < MAX_SESSION_PAGES; page++) {
    const result = await client.request({
      method: "listSessions",
      params: { channel: ROOT_CHANNEL, limit: SESSION_PAGE_SIZE, cursor },
    });
    if (!isRecord(result)) break;
    for (const item of Array.isArray(result.items) ? result.items : []) {
      if (!isRecord(item) || typeof item.resource !== "string") continue;
      const modifiedMs = typeof item.modifiedAt === "string" ? Date.parse(item.modifiedAt) : 0;
      candidates.push({
        resource: item.resource,
        modifiedMs: Number.isNaN(modifiedMs) ? 0 : modifiedMs,
        provider: typeof item.provider === "string" ? item.provider : undefined,
        workingDirectories: readStrings(item.workingDirectories),
      });
    }
    if (typeof result.nextCursor !== "string") break;
    cursor = result.nextCursor;
  }
  return candidates;
}

function matchesId({ resource, id }: { resource: string; id: string }): boolean {
  return resource === id || resource.endsWith(`/${id}`);
}
