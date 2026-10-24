// Keeps a file-backed agent room in the target repository.
// messages.jsonl is the shared Slack-like stream; participant files keep each
// participant's relay session identity and the messages involving them.

import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { RelayEvent } from "./types/relay-event.js";

const AGENT_ROOM_DIRECTORY_NAME = ".agent-room";
const ROOM_DIRECTORY_MODE = 0o700;
const ROOM_FILE_MODE = 0o600;
export interface AgentRoomServiceOptions {
  targetRepositoryPath: string;
  sessionId: string;
  roomName?: string;
  participants?: readonly string[];
  coordinatorId?: string | undefined;
  startedAt?: string;
}

export interface AgentRoomPaths {
  rootDirectoryPath: string;
  configPath: string;
  roomDirectoryPath: string;
  roomMarkdownPath: string;
  tasksMarkdownPath: string;
  messagesPath: string;
  eventsPath: string;
  membersPath: string;
  tasksDirectoryPath: string;
  knowledgeDirectoryPath: string;
  decisionsDirectoryPath: string;
  participantsDirectoryPath: string;
}

export interface RoomMembershipRecord {
  participantId: string;
  sessionId: string;
  status: "joined" | "left";
  timestamp: string;
}

export class AgentRoomService {
  private readonly paths: AgentRoomPaths;
  private readonly startedAt: string;
  private readonly roomName: string;
  private isInitialized = false;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(private readonly options: AgentRoomServiceOptions) {
    this.startedAt = options.startedAt ?? new Date().toISOString();
    this.roomName = safeName(options.roomName ?? "backend");
    const rootDirectoryPath = join(options.targetRepositoryPath, AGENT_ROOM_DIRECTORY_NAME);
    const roomDirectoryPath = join(rootDirectoryPath, "rooms", this.roomName);
    this.paths = {
      rootDirectoryPath,
      configPath: join(rootDirectoryPath, "config.yaml"),
      roomDirectoryPath,
      roomMarkdownPath: join(roomDirectoryPath, "ROOM.md"),
      tasksMarkdownPath: join(roomDirectoryPath, "TASKS.md"),
      messagesPath: join(roomDirectoryPath, "messages.jsonl"),
      eventsPath: join(roomDirectoryPath, "events.jsonl"),
      membersPath: join(roomDirectoryPath, "members.jsonl"),
      tasksDirectoryPath: join(roomDirectoryPath, "tasks"),
      knowledgeDirectoryPath: join(roomDirectoryPath, "knowledge"),
      decisionsDirectoryPath: join(roomDirectoryPath, "decisions"),
      participantsDirectoryPath: join(roomDirectoryPath, "participants"),
    };
  }

  get pathsForRoom(): AgentRoomPaths {
    return this.paths;
  }

  get sessionId(): string {
    return this.options.sessionId;
  }

  get roomNameForSession(): string {
    return this.roomName;
  }

  async initialize(coordinatorId = this.options.coordinatorId): Promise<void> {
    if (this.isInitialized) return;
    await Promise.all([
      mkdir(this.paths.roomDirectoryPath, { recursive: true, mode: ROOM_DIRECTORY_MODE }),
      mkdir(this.paths.tasksDirectoryPath, { recursive: true, mode: ROOM_DIRECTORY_MODE }),
      mkdir(this.paths.knowledgeDirectoryPath, { recursive: true, mode: ROOM_DIRECTORY_MODE }),
      mkdir(this.paths.decisionsDirectoryPath, { recursive: true, mode: ROOM_DIRECTORY_MODE }),
      mkdir(this.paths.participantsDirectoryPath, { recursive: true, mode: ROOM_DIRECTORY_MODE }),
    ]);
    await ensureConfig(this.paths.configPath, this.roomName);
    await ensureRoomSession(this.paths.roomMarkdownPath, roomMarkdown({
      roomName: this.roomName,
      sessionId: this.options.sessionId,
      startedAt: this.startedAt,
      participants: this.options.participants ?? [],
      coordinatorId,
    }));
    await writeIfMissing(this.paths.tasksMarkdownPath, tasksMarkdown());
    await writeIfMissing(this.paths.messagesPath, "");
    await writeIfMissing(this.paths.eventsPath, "");
    await writeIfMissing(this.paths.membersPath, "");
    for (const participant of this.options.participants ?? []) {
      await ensureParticipantFile({
        path: join(this.paths.participantsDirectoryPath, `${safeName(participant)}.md`),
        participant,
        sessionId: this.options.sessionId,
        startedAt: this.startedAt,
      });
    }
    this.isInitialized = true;
  }

  append(event: RelayEvent): Promise<void> {
    const written = this.writeQueue.then(async () => {
      await this.initialize();
      await appendFile(this.paths.messagesPath, `${JSON.stringify({ room: this.roomName, sessionId: this.options.sessionId, ...event })}\n`, { mode: ROOM_FILE_MODE });
      const participants = new Set([event.from, event.to]);
      for (const participant of participants) {
        const participantPath = join(this.paths.participantsDirectoryPath, `${safeName(participant)}.md`);
        await ensureParticipantFile({
          path: participantPath,
          participant,
          sessionId: this.options.sessionId,
          startedAt: this.startedAt,
        });
        await appendFile(participantPath, formatMarkdownMessage(event), { mode: ROOM_FILE_MODE });
      }
    });
    this.writeQueue = written.catch(() => undefined);
    return written;
  }

  recordMembership(participantId: string, status: RoomMembershipRecord["status"], sessionId = this.options.sessionId): Promise<void> {
    const written = this.writeQueue.then(async () => {
      await this.initialize();
      const timestamp = new Date().toISOString();
      const participantPath = join(this.paths.participantsDirectoryPath, `${safeName(participantId)}.md`);
      await ensureParticipantFile({ path: participantPath, participant: participantId, sessionId, startedAt: this.startedAt });
      const membership: RoomMembershipRecord = { participantId, sessionId, status, timestamp };
      await appendFile(this.paths.membersPath, `${JSON.stringify(membership)}\n`, { mode: ROOM_FILE_MODE });
    });
    this.writeQueue = written.catch(() => undefined);
    return written;
  }
}

async function writeIfMissing(path: string, content: string): Promise<void> {
  await writeFile(path, content, { flag: "wx", mode: ROOM_FILE_MODE }).catch((error: unknown) => {
    if (!isAlreadyExists(error)) throw error;
  });
}

async function ensureConfig(path: string, roomName: string): Promise<void> {
  try {
    const content = await readFile(path, "utf8");
    if (!new RegExp(`^\\s+- ${escapeRegExp(roomName)}$`, "m").test(content)) {
      await appendFile(path, `  - ${roomName}\n`);
    }
  } catch (error: unknown) {
    if (isMissing(error)) {
      await writeIfMissing(path, configYaml(roomName));
      return;
    }
    throw error;
  }
}

async function ensureRoomSession(path: string, sessionHeader: string): Promise<void> {
  const sessionLine = sessionHeader.split("\n").find((line) => line.startsWith("- Relay session ID:"));
  if (!sessionLine) return;
  try {
    const content = await readFile(path, "utf8");
    if (!content.includes(sessionLine)) {
      const laterSessionHeader = sessionHeader.split("\n").filter((line) => !line.startsWith("- Coordinator:")).join("\n");
      await appendFile(path, `\n## Relay session\n\n${laterSessionHeader}\n`);
    }
  } catch (error: unknown) {
    if (isMissing(error)) await writeIfMissing(path, sessionHeader);
    else throw error;
  }
}

async function ensureParticipantFile({
  path,
  participant,
  sessionId,
  startedAt,
}: {
  path: string;
  participant: string;
  sessionId: string;
  startedAt: string;
}): Promise<void> {
  const header = [
    `# Agent room participant: ${participant}`,
    "",
    `- Relay session ID: \`${sessionId}\``,
    `- Started: ${startedAt}`,
    "",
    "## Messages",
    "",
  ].join("\n");
  try {
    const content = await readFile(path, "utf8");
    const sessionLine = `- Relay session ID: \`${sessionId}\``;
    if (!content.includes(sessionLine)) await appendFile(path, `\n## Relay session\n\n${header}\n`);
  } catch (error: unknown) {
    if (isMissing(error)) await writeIfMissing(path, header);
    else throw error;
  }
}

function configYaml(roomName: string): string {
  return ["version: 1", `default_room: ${roomName}`, "rooms:", `  - ${roomName}`, ""].join("\n");
}

function roomMarkdown({ roomName, sessionId, startedAt, participants, coordinatorId }: {
  roomName: string;
  sessionId: string;
  startedAt: string;
  participants: readonly string[];
  coordinatorId?: string | undefined;
}): string {
  return [
    `# Agent room: ${roomName}`,
    "",
    `- Relay session ID: \`${sessionId}\``,
    `- Started: ${startedAt}`,
    ...(coordinatorId ? [`- Coordinator: ${coordinatorId}`] : []),
    "- Shared communication: `messages.jsonl`",
    "",
    "## Participants",
    ...(participants.length > 0 ? participants.map((participant) => `- ${participant} — session \`${sessionId}\``) : ["- Added when the first relay session connects"]),
    "",
  ].join("\n");
}

function tasksMarkdown(): string {
  return ["# Tasks", "", "## Open", "", "## Done", ""].join("\n");
}

function formatMarkdownMessage(event: RelayEvent): string {
  return [
    `### ${event.timestamp} · ${event.from} → ${event.to} · ${event.kind}`,
    `<!-- conversation: ${event.conversationId}; request: ${event.requestToken}; sequence: ${event.serverSequence} -->`,
    ...event.text.split("\n").map((line) => `> ${line || " "}`),
    "",
  ].join("\n");
}

function safeName(value: string): string {
  const normalized = value.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return normalized || "room";
}

function isAlreadyExists(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST";
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
