import { appendFile, open, readdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { isAbsolute, join, resolve } from "node:path";
import { AgentRoomService, type AgentRoomPaths, type RoomMembershipRecord } from "./agent-room-service.js";

const DEFAULT_PARTICIPANT = "cross-agent-mcp-bridge";

export interface AgentRoomManagerOptions {
  targetRepositoryPath: string;
  sessionId: string;
  participantId?: string;
  roomName?: string;
  coordinatorId?: string | undefined;
}

export interface RoomSummary {
  roomId: string;
  path: string;
  tasks: number;
  knowledge: number;
}

export interface RoomTask {
  taskId: string;
  path: string;
  content: string;
  status: "open" | "in_progress" | "review" | "done";
  assignedTo: string | null;
  files: string[];
  workingSessionId: string | null;
}

export type RoomActivityType =
  | "room.created"
  | "room.task.created"
  | "room.task.updated"
  | "room.knowledge.updated"
  | "room.decision.updated"
  | "room.message.received"
  | "room.agent.joined"
  | "room.agent.left"
  | "room.file.claimed"
  | "room.file.released"
  | "room.worktree.created"
  | "room.worktree.removed";

export interface RoomActivityEvent {
  id: string;
  roomId: string;
  type: RoomActivityType;
  actor: string;
  timestamp: string;
  summary: string;
  resourcePath?: string;
}

export interface RoomMember extends RoomMembershipRecord {
  connectionStatus: "connected" | "interrupted" | "left";
  role: "coordinator" | "worker";
  coordinator: string | null;
}

export interface KnowledgeHit {
  knowledgeId: string;
  path: string;
  content: string;
}

export class AgentRoomManager {
  private readonly targetRepositoryPath: string;
  private readonly rootPath: string;
  private readonly roomsPath: string;
  private readonly participantId: string;
  private readonly roomName: string;
  private readonly activeSessionIds: Set<string>;
  private readonly services = new Map<string, AgentRoomService>();
  private readonly knownRepositoryPaths = new Set<string>();
  private readonly activityListeners = new Set<(event: RoomActivityEvent) => void>();
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(private readonly options: AgentRoomManagerOptions) {
    this.targetRepositoryPath = resolve(options.targetRepositoryPath);
    this.rootPath = join(this.targetRepositoryPath, ".agent-room");
    this.roomsPath = join(this.rootPath, "rooms");
    this.participantId = options.participantId?.trim() || DEFAULT_PARTICIPANT;
    this.roomName = roomIdFor(options.roomName ?? "backend");
    this.activeSessionIds = new Set([options.sessionId]);
    this.knownRepositoryPaths.add(this.targetRepositoryPath);
  }

  get currentSessionId(): string { return this.options.sessionId; }
  get defaultParticipantId(): string { return this.participantId; }
  get defaultRoomId(): string { return this.roomName; }
  get defaultRepositoryPath(): string { return this.targetRepositoryPath; }
  get roomsDirectoryPath(): string { return this.roomsPath; }
  roomsDirectoryPathFor(targetRepositoryPath: string): string { return join(resolve(targetRepositoryPath), ".agent-room", "rooms"); }
  roomDirectoryPath(roomId: string, targetRepositoryPath = this.targetRepositoryPath): string {
    const location = targetRepositoryPath === this.targetRepositoryPath
      ? this.parseRoomReference(roomId)
      : { roomName: validateRoomId(roomId), repositoryPath: resolve(targetRepositoryPath) };
    return join(location.repositoryPath, ".agent-room", "rooms", location.roomName);
  }
  repositoryPathForRoom(roomId: string): string { return this.parseRoomReference(roomId).repositoryPath; }
  localRoomId(roomId: string): string { return this.parseRoomReference(roomId).roomName; }
  roomReference(roomId: string, targetRepositoryPath: string): string {
    const name = validateRoomId(roomId);
    const repositoryPath = resolve(targetRepositoryPath);
    return repositoryPath === this.targetRepositoryPath ? name : scopedRoomReference(name, repositoryPath);
  }

  async createRoom(name: string, targetRepositoryPath = this.targetRepositoryPath, coordinatorId?: string): Promise<RoomSummary> {
    const localRoomId = roomIdFor(name);
    const repositoryPath = resolve(targetRepositoryPath);
    if (!(await directoryExists(repositoryPath))) throw new Error(`Target repository directory does not exist: ${repositoryPath}`);
    this.knownRepositoryPaths.add(repositoryPath);
    const roomId = this.roomReference(localRoomId, repositoryPath);
    const service = this.serviceFor(roomId);
    const existed = await directoryExists(service.pathsForRoom.roomDirectoryPath);
    const coordinator = normalizeParticipant(coordinatorId ?? this.options.coordinatorId ?? this.participantId);
    await service.initialize(coordinator);
    const summary = await this.describeRoom(roomId);
    if (!existed) await this.publishActivity({ roomId, type: "room.created", actor: this.participantId, summary: `${roomId} room created.` });
    return summary;
  }

  async joinRoom(roomId: string, participantId = this.participantId, sessionId = this.options.sessionId): Promise<RoomSummary> {
    const id = this.normalizeRoomReference(roomId);
    const participant = normalizeParticipant(participantId);
    if (!participant) throw new Error("Participant ID must contain letters or numbers.");
    const service = this.serviceFor(id);
    await ensureDirectory(service.pathsForRoom.roomDirectoryPath, id, this.roomDirectoryPath(id));
    await service.initialize();
    this.activeSessionIds.add(sessionId);
    await service.recordMembership(participant, "joined", sessionId);
    await this.publishActivity({ roomId: id, type: "room.agent.joined", actor: participant, summary: `${participant} joined the room.` });
    return this.describeRoom(id);
  }

  async leaveRoom(roomId: string, participantId = this.participantId, sessionId = this.options.sessionId): Promise<void> {
    const id = this.normalizeRoomReference(roomId);
    const participant = normalizeParticipant(participantId);
    await this.pathsFor(id);
    const service = this.serviceFor(id);
    await service.recordMembership(participant, "left", sessionId);
    this.activeSessionIds.delete(sessionId);
    await this.publishActivity({ roomId: id, type: "room.agent.left", actor: participant, summary: `${participant} left the room.` });
  }

  async listRoomMembers(roomId: string): Promise<RoomMember[]> {
    const paths = await this.pathsFor(roomId);
    const coordinator = readRoomCoordinator(await readOrEmpty(paths.roomMarkdownPath), this.options.coordinatorId);
    const rows = (await readOrEmpty(paths.membersPath)).split("\n").filter(Boolean).flatMap(parseMembership);
    const latest = new Map<string, RoomMembershipRecord>();
    for (const row of rows) {
      const key = `${row.participantId}:${row.sessionId}`;
      const previous = latest.get(key);
      if (!previous || previous.timestamp <= row.timestamp) latest.set(key, row);
    }
    return [...latest.values()].map((member) => ({
      ...member,
      connectionStatus: member.status === "left" ? "left" : this.activeSessionIds.has(member.sessionId) ? "connected" : "interrupted",
      role: member.participantId === coordinator ? "coordinator" : "worker",
      coordinator: member.participantId === coordinator ? null : coordinator,
    }));
  }

  // Explicit onboarding keeps agents from having to reconstruct the shared context by hand.
  async getRoomOnboarding(roomId: string, participantId = this.participantId): Promise<Record<string, unknown>> {
    const paths = await this.pathsFor(roomId);
    const participant = normalizeParticipant(participantId);
    const [room, tasks, knowledgeEntries, decisionEntries] = await Promise.all([
      readOrEmpty(paths.roomMarkdownPath),
      this.listRoomTasks(roomId),
      readdir(paths.knowledgeDirectoryPath, { withFileTypes: true }),
      readdir(paths.decisionsDirectoryPath, { withFileTypes: true }),
    ]);
    const assignedTasks = tasks.filter((task) => task.assignedTo === participant);
    const coordinator = readRoomCoordinator(room, this.options.coordinatorId);
    const knowledge = await Promise.all(knowledgeEntries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
      .map(async (entry) => ({ path: join(paths.knowledgeDirectoryPath, entry.name), content: await readFile(join(paths.knowledgeDirectoryPath, entry.name), "utf8") })));
    const decisions = await Promise.all(decisionEntries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
      .map(async (entry) => ({ path: join(paths.decisionsDirectoryPath, entry.name), content: await readFile(join(paths.decisionsDirectoryPath, entry.name), "utf8") })));
    return { roomId: this.normalizeRoomReference(roomId), participantId: participant, role: participant === coordinator ? "coordinator" : "worker", coordinator: participant === coordinator ? null : coordinator, room, knowledge, decisions, assignedTasks };
  }

  async listRooms(targetRepositoryPath = this.targetRepositoryPath): Promise<RoomSummary[]> {
    const repositoryPath = resolve(targetRepositoryPath);
    this.knownRepositoryPaths.add(repositoryPath);
    const roomsPath = this.roomsDirectoryPathFor(repositoryPath);
    let entries;
    try {
      entries = await readdir(roomsPath, { withFileTypes: true });
    } catch (error) {
      if (isMissing(error)) return [];
      throw error;
    }
    return Promise.all(entries.filter((entry) => entry.isDirectory()).map((entry) => this.describeRoom(this.roomReference(entry.name, repositoryPath))));
  }

  async listAllRooms(): Promise<RoomSummary[]> {
    const rooms = await Promise.all([...this.knownRepositoryPaths].map((repositoryPath) => this.listRooms(repositoryPath)));
    return rooms.flat();
  }

  async getRoomContext(roomId: string): Promise<Record<string, unknown>> {
    const paths = await this.pathsFor(roomId);
    const [room, tasks, messages] = await Promise.all([
      readOrEmpty(paths.roomMarkdownPath),
      readOrEmpty(paths.tasksMarkdownPath),
      readLastLines(paths.messagesPath, RECENT_MESSAGE_LIMIT),
    ]);
    return {
      roomId: this.normalizeRoomReference(roomId),
      roomPath: paths.roomDirectoryPath,
      room,
      tasks,
      recentMessages: messages.flatMap(parseMessage),
    };
  }

  async listRoomTasks(roomId: string): Promise<RoomTask[]> {
    const paths = await this.pathsFor(roomId);
    const entries = await readdir(paths.tasksDirectoryPath, { withFileTypes: true });
    return Promise.all(entries.filter((entry) => entry.isFile() && entry.name.endsWith(".md")).map(async (entry) => {
      const content = await readFile(join(paths.tasksDirectoryPath, entry.name), "utf8");
      return {
        taskId: entry.name.slice(0, -3),
        path: join(paths.tasksDirectoryPath, entry.name),
        content,
        status: readTaskStatus(content),
        assignedTo: readTaskAssignee(content),
        files: readTaskFiles(content),
        workingSessionId: readTaskSession(content),
      } satisfies RoomTask;
    }));
  }

  async createTask(roomId: string, task: string, options: { assignedTo?: string; files?: string[] } = {}): Promise<RoomTask> {
    const paths = await this.pathsFor(roomId);
    const taskId = `task-${Date.now()}-${randomUUID().slice(0, 8)}`;
    const timestamp = new Date().toISOString();
    const assignedTo = normalizeParticipant(options.assignedTo ?? "");
    const files = normalizeFileList(options.files ?? []);
    const content = [`# Task: ${taskId}`, "", `- Status: open`, `- Assigned to: ${assignedTo || "unassigned"}`, `- Files: ${files.length ? files.join(", ") : "none"}`, `- Working session: none`, `- Created: ${timestamp}`, `- Updated: ${timestamp}`, "", "## Description", "", task.trim(), ""].join("\n");
    await this.enqueue(async () => {
      await writeAtomically(join(paths.tasksDirectoryPath, `${taskId}.md`), content);
      await rebuildTaskIndex(paths);
    });
    const result = { taskId, path: join(paths.tasksDirectoryPath, `${taskId}.md`), content, status: "open" as const, assignedTo: assignedTo || null, files, workingSessionId: null };
    await this.publishActivity({ roomId: this.normalizeRoomReference(roomId), type: "room.task.created", actor: this.participantId, summary: `Created task ${taskId}${assignedTo ? ` for ${assignedTo}` : ""}.`, resourcePath: result.path });
    return result;
  }

  async updateTask(roomId: string, taskId: string, update: string): Promise<RoomTask> {
    const paths = await this.pathsFor(roomId);
    const id = validateTaskId(taskId);
    const path = join(paths.tasksDirectoryPath, `${id}.md`);
    const timestamp = new Date().toISOString();
    let content = "";
    await this.enqueue(async () => {
      const previous = await readFile(path, "utf8");
      content = `${previous.trimEnd()}\n\n## Update ${timestamp}\n\n${update.trim()}\n`;
      await writeAtomically(path, content);
      await rebuildTaskIndex(paths);
    });
    const result = { taskId: id, path, content, status: readTaskStatus(content), assignedTo: readTaskAssignee(content), files: readTaskFiles(content), workingSessionId: readTaskSession(content) };
    await this.publishActivity({ roomId: this.normalizeRoomReference(roomId), type: "room.task.updated", actor: this.participantId, summary: `Updated task ${id}.`, resourcePath: path });
    return result;
  }

  async setTaskStatus(roomId: string, taskId: string, status: RoomTask["status"]): Promise<RoomTask> {
    const paths = await this.pathsFor(roomId);
    const id = validateTaskId(taskId);
    if (!["open", "in_progress", "review", "done"].includes(status)) throw new Error(`Invalid task status: ${status}`);
    const path = join(paths.tasksDirectoryPath, `${id}.md`);
    const timestamp = new Date().toISOString();
    let content = "";
    await this.enqueue(async () => {
      const previous = await readFile(path, "utf8");
      content = replaceTaskField(replaceTaskField(replaceTaskField(previous, "Status", status), "Updated", timestamp), "Working session", status === "in_progress" ? this.options.sessionId : "none");
      await writeAtomically(path, content);
      await rebuildTaskIndex(paths);
    });
    const result = { taskId: id, path, content, status, assignedTo: readTaskAssignee(content), files: readTaskFiles(content), workingSessionId: readTaskSession(content) };
    await this.publishActivity({ roomId: this.normalizeRoomReference(roomId), type: "room.task.updated", actor: this.participantId, summary: `Marked task ${id} ${status.replace("_", " ")}.`, resourcePath: path });
    return result;
  }

  async publishKnowledge(roomId: string, content: string): Promise<KnowledgeHit> {
    const paths = await this.pathsFor(roomId);
    const knowledgeId = `knowledge-${Date.now()}-${randomUUID().slice(0, 8)}`;
    const filePath = join(paths.knowledgeDirectoryPath, `${knowledgeId}.md`);
    const fileContent = [`# Knowledge: ${knowledgeId}`, "", `- Published: ${new Date().toISOString()}`, "", content.trim(), ""].join("\n");
    await this.enqueue(() => writeAtomically(filePath, fileContent));
    await this.publishActivity({ roomId: this.normalizeRoomReference(roomId), type: "room.knowledge.updated", actor: this.participantId, summary: `Published knowledge ${knowledgeId}.`, resourcePath: filePath });
    return { knowledgeId, path: filePath, content: fileContent };
  }

  async publishDecision(roomId: string, title: string, content: string): Promise<KnowledgeHit> {
    const paths = await this.pathsFor(roomId);
    const decisionId = `decision-${Date.now()}-${randomUUID().slice(0, 8)}`;
    const filePath = join(paths.decisionsDirectoryPath, `${decisionId}.md`);
    const fileContent = [`# Decision: ${title.trim()}`, "", `- Decision ID: ${decisionId}`, `- Recorded by: ${this.participantId}`, `- Recorded: ${new Date().toISOString()}`, "", content.trim(), ""].join("\n");
    await this.enqueue(() => writeAtomically(filePath, fileContent));
    await this.publishActivity({ roomId: this.normalizeRoomReference(roomId), type: "room.decision.updated", actor: this.participantId, summary: `Recorded decision: ${title.trim()}.`, resourcePath: filePath });
    return { knowledgeId: decisionId, path: filePath, content: fileContent };
  }

  async assignTask(roomId: string, taskId: string, assignedTo: string): Promise<RoomTask> {
    const paths = await this.pathsFor(roomId);
    const id = validateTaskId(taskId);
    const participant = normalizeParticipant(assignedTo);
    if (!participant) throw new Error("Assignee must contain letters or numbers.");
    const path = join(paths.tasksDirectoryPath, `${id}.md`);
    let content = "";
    await this.enqueue(async () => {
      const previous = await readFile(path, "utf8");
      content = replaceTaskField(replaceTaskField(previous, "Assigned to", participant), "Updated", new Date().toISOString());
      await writeAtomically(path, content);
      await rebuildTaskIndex(paths);
    });
    const result = { taskId: id, path, content, status: readTaskStatus(content), assignedTo: participant, files: readTaskFiles(content), workingSessionId: readTaskSession(content) };
    await this.publishActivity({ roomId: this.normalizeRoomReference(roomId), type: "room.task.updated", actor: this.participantId, summary: `Assigned task ${id} to ${participant}.`, resourcePath: path });
    return result;
  }

  async listDecisions(roomId: string): Promise<KnowledgeHit[]> {
    const paths = await this.pathsFor(roomId);
    const entries = await readdir(paths.decisionsDirectoryPath, { withFileTypes: true });
    return Promise.all(entries.filter((entry) => entry.isFile() && entry.name.endsWith(".md")).map(async (entry) => ({ knowledgeId: entry.name.slice(0, -3), path: join(paths.decisionsDirectoryPath, entry.name), content: await readFile(join(paths.decisionsDirectoryPath, entry.name), "utf8") })));
  }

  async searchKnowledge(roomId: string, query: string): Promise<KnowledgeHit[]> {
    const paths = await this.pathsFor(roomId);
    const needle = query.trim().toLowerCase();
    const entries = await readdir(paths.knowledgeDirectoryPath, { withFileTypes: true });
    const hits: KnowledgeHit[] = [];
    for (const entry of entries.filter((item) => item.isFile() && item.name.endsWith(".md"))) {
      const content = await readFile(join(paths.knowledgeDirectoryPath, entry.name), "utf8");
      if (content.toLowerCase().includes(needle)) hits.push({ knowledgeId: entry.name.slice(0, -3), path: join(paths.knowledgeDirectoryPath, entry.name), content });
    }
    return hits;
  }

  async sendRoomMessage(roomId: string, message: string, participantId = this.participantId): Promise<void> {
    const paths = await this.pathsFor(roomId);
    const record = { roomId: this.normalizeRoomReference(roomId), sessionId: this.options.sessionId, participantId, timestamp: new Date().toISOString(), message: message.trim() };
    await this.enqueue(() => appendFile(paths.messagesPath, `${JSON.stringify(record)}\n`, { mode: 0o600 }));
    await this.publishActivity({ roomId: this.normalizeRoomReference(roomId), type: "room.message.received", actor: participantId, summary: `${participantId} sent a room message.` });
  }

  // The dashboard and MCP resource share this event stream for concise change notices.
  async appendRelayEvent(event: import("./types/relay-event.js").RelayEvent): Promise<void> {
    const service = this.serviceFor(this.roomName);
    if (!(await directoryExists(service.pathsForRoom.roomDirectoryPath))) return;
    await this.enqueue(() => service.append(event));
    if (event.kind === "reply_delta") return;
    const summary = event.kind === "user_message" ? `${event.from} sent a message to ${event.to}.` : `${event.from} ${event.kind.replaceAll("_", " ")}.`;
    await this.publishActivity({ roomId: this.roomName, type: "room.message.received", actor: event.from, summary });
  }

  async listRoomEvents(roomId: string, limit = 50): Promise<RoomActivityEvent[]> {
    const paths = await this.pathsFor(roomId);
    const lines = await readLastLines(paths.eventsPath, clampLimit(limit));
    return lines.flatMap(parseActivity);
  }

  async listRecentEvents(limit = 50): Promise<RoomActivityEvent[]> {
    const rooms = await this.listAllRooms();
    const events = (await Promise.all(rooms.map((room) => this.listRoomEvents(room.roomId, limit)))).flat();
    return events.sort((left, right) => left.timestamp.localeCompare(right.timestamp)).slice(-clampLimit(limit));
  }

  subscribe(listener: (event: RoomActivityEvent) => void): () => void {
    this.activityListeners.add(listener);
    return () => this.activityListeners.delete(listener);
  }

  async recordCoordinationActivity(input: { roomId: string; type: Extract<RoomActivityType, `room.file.${string}` | `room.worktree.${string}`>; actor: string; summary: string; resourcePath?: string }): Promise<void> {
    await this.publishActivity(input);
  }

  private async pathsFor(roomId: string): Promise<AgentRoomPaths> {
    const id = this.normalizeRoomReference(roomId);
    const service = this.serviceFor(id);
    await ensureDirectory(service.pathsForRoom.roomDirectoryPath, id, this.roomDirectoryPath(id));
    await service.initialize();
    return service.pathsForRoom;
  }

  private serviceFor(roomId: string): AgentRoomService {
    const id = this.normalizeRoomReference(roomId);
    const existing = this.services.get(id);
    if (existing) return existing;
    const location = this.parseRoomReference(id);
    const service = new AgentRoomService({ targetRepositoryPath: location.repositoryPath, sessionId: this.options.sessionId, roomName: location.roomName, participants: [this.participantId], coordinatorId: this.options.coordinatorId });
    this.services.set(id, service);
    return service;
  }

  private async describeRoom(roomId: string): Promise<RoomSummary> {
    const paths = await this.pathsFor(roomId);
    const [tasks, knowledge] = await Promise.all([readdir(paths.tasksDirectoryPath), readdir(paths.knowledgeDirectoryPath)]);
    return { roomId, path: paths.roomDirectoryPath, tasks: tasks.filter((name) => name.endsWith(".md")).length, knowledge: knowledge.filter((name) => name.endsWith(".md")).length };
  }

  private enqueue(operation: () => Promise<void>): Promise<void> {
    const written = this.writeQueue.then(operation);
    this.writeQueue = written.catch(() => undefined);
    return written;
  }

  private async publishActivity(input: Omit<RoomActivityEvent, "id" | "timestamp">): Promise<void> {
    const roomId = this.normalizeRoomReference(input.roomId);
    const service = this.serviceFor(roomId);
    const event: RoomActivityEvent = { ...input, roomId, id: randomUUID(), timestamp: new Date().toISOString() };
    await this.enqueue(() => appendFile(service.pathsForRoom.eventsPath, `${JSON.stringify(event)}\n`, { mode: 0o600 }));
    for (const listener of this.activityListeners) {
      try { listener(event); } catch { /* One dashboard subscriber must not fail a persisted room update. */ }
    }
  }

  private normalizeRoomReference(roomId: string): string {
    const location = this.parseRoomReference(roomId);
    this.knownRepositoryPaths.add(location.repositoryPath);
    return location.reference;
  }

  private parseRoomReference(value: string): { reference: string; roomName: string; repositoryPath: string } {
    const separator = value.lastIndexOf("@");
    if (separator < 0) {
      const roomName = validateRoomId(value);
      return { reference: roomName, roomName, repositoryPath: this.targetRepositoryPath };
    }
    const roomName = validateRoomId(value.slice(0, separator));
    const encodedPath = value.slice(separator + 1);
    let repositoryPath: string;
    try { repositoryPath = resolve(Buffer.from(encodedPath, "base64url").toString("utf8")); }
    catch { throw new Error(`Invalid room reference: ${value}`); }
    if (!isAbsolute(repositoryPath) || !encodedPath || Buffer.from(repositoryPath).toString("base64url") !== encodedPath) throw new Error(`Invalid room reference: ${value}`);
    return { reference: scopedRoomReference(roomName, repositoryPath), roomName, repositoryPath };
  }
}

function roomIdFor(name: string): string {
  const id = name.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  if (!id) throw new Error("Room name must contain letters or numbers.");
  return id;
}

function validateRoomId(value: string): string {
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(value) || value.includes("..")) throw new Error(`Invalid room ID: ${value}`);
  return value;
}

function scopedRoomReference(roomId: string, repositoryPath: string): string {
  return `${roomId}@${Buffer.from(resolve(repositoryPath)).toString("base64url")}`;
}

function validateTaskId(value: string): string {
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(value)) throw new Error(`Invalid task ID: ${value}`);
  return value;
}

async function readOrEmpty(path: string): Promise<string> {
  try { return await readFile(path, "utf8"); } catch (error) { if (isMissing(error)) return ""; throw error; }
}

const RECENT_MESSAGE_LIMIT = 50;
const TAIL_CHUNK_BYTES = 64 * 1024;

// Reads only the end of an append-only log, so cost stays flat as the file grows.
async function readLastLines(path: string, count: number): Promise<string[]> {
  let handle;
  try { handle = await open(path, "r"); } catch (error) { if (isMissing(error)) return []; throw error; }
  try {
    let position = (await handle.stat()).size;
    const chunks: Buffer[] = [];
    let newlines = 0;
    // Collect chunks from the end until they hold more than `count` newlines (the extra one marks a complete first line).
    while (position > 0 && newlines <= count) {
      const length = Math.min(TAIL_CHUNK_BYTES, position);
      position -= length;
      const chunk = Buffer.alloc(length);
      await handle.read(chunk, 0, length, position);
      chunks.unshift(chunk);
      for (const byte of chunk) if (byte === 0x0a) newlines += 1;
    }
    const lines = Buffer.concat(chunks).toString("utf8").split("\n");
    // Unless we reached the file start, the first line may be cut off.
    if (position > 0) lines.shift();
    return lines.filter(Boolean).slice(-count);
  } finally {
    await handle.close();
  }
}

function isMissing(error: unknown): boolean { return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT"; }

async function directoryExists(path: string): Promise<boolean> {
  try { return (await stat(path)).isDirectory(); } catch (error) { if (isMissing(error)) return false; throw error; }
}

async function ensureDirectory(path: string, roomId: string, suggestedPath: string): Promise<void> {
  try {
    if (!(await stat(path)).isDirectory()) throw new Error(`Room is not a directory: ${roomId}`);
  } catch (error) {
    if (isMissing(error)) throw new Error(`Room not found: ${roomId}. Create it with create_room; its directory will be ${suggestedPath}.`);
    throw error;
  }
}

function parseMessage(line: string): Record<string, unknown>[] {
  try { return [JSON.parse(line) as Record<string, unknown>]; } catch { return []; }
}

function parseActivity(line: string): RoomActivityEvent[] {
  try { return [JSON.parse(line) as RoomActivityEvent]; } catch { return []; }
}

function parseMembership(line: string): RoomMembershipRecord[] {
  try { return [JSON.parse(line) as RoomMembershipRecord]; } catch { return []; }
}

function readTaskStatus(content: string): RoomTask["status"] {
  const value = content.match(/^- Status:\s*(.+)$/im)?.[1]?.trim().toLowerCase();
  if (value === "in_progress" || value === "in progress") return "in_progress";
  if (value === "review") return "review";
  if (value === "done") return "done";
  return "open";
}

function readRoomCoordinator(content: string, fallback?: string): string | null {
  const recorded = content.match(/^- Coordinator:\s*(.+)$/im)?.[1];
  return normalizeParticipant(recorded ?? fallback ?? "") || null;
}

function readTaskAssignee(content: string): string | null {
  const value = content.match(/^- Assigned to:\s*(.+)$/im)?.[1]?.trim();
  return value && value.toLowerCase() !== "unassigned" ? value : null;
}

function readTaskFiles(content: string): string[] {
  const value = content.match(/^- Files:\s*(.+)$/im)?.[1]?.trim();
  return !value || value.toLowerCase() === "none" ? [] : value.split(",").map((file) => file.trim()).filter(Boolean);
}

function readTaskSession(content: string): string | null {
  const value = content.match(/^- Working session:\s*(.+)$/im)?.[1]?.trim();
  return value && value.toLowerCase() !== "none" ? value : null;
}

function normalizeParticipant(value: string): string {
  const participant = value.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  if (value.trim() && !participant) throw new Error("Assignee must contain letters or numbers.");
  return participant;
}

function normalizeFileList(files: string[]): string[] {
  return [...new Set(files.map((file) => file.trim().replaceAll("\\", "/")).filter(Boolean).map((file) => {
    if (file.startsWith("/") || file.split("/").some((segment) => segment === ".." || segment === "")) {
      throw new Error(`Task file path must be a repository-relative path: ${file}`);
    }
    return file;
  }))];
}

function replaceTaskField(content: string, field: string, value: string): string {
  const pattern = new RegExp(`^- ${escapeRegExp(field)}:.*$`, "im");
  if (!pattern.test(content)) throw new Error(`Task is missing its ${field} field.`);
  return content.replace(pattern, `- ${field}: ${value}`);
}

async function rebuildTaskIndex(paths: AgentRoomPaths): Promise<void> {
  const entries = await readdir(paths.tasksDirectoryPath, { withFileTypes: true });
  const tasks = await Promise.all(entries.filter((entry) => entry.isFile() && entry.name.endsWith(".md")).map(async (entry) => ({
    id: entry.name.slice(0, -3),
    content: await readFile(join(paths.tasksDirectoryPath, entry.name), "utf8"),
  })));
  const open = tasks.filter((task) => readTaskStatus(task.content) !== "done");
  const done = tasks.filter((task) => readTaskStatus(task.content) === "done");
  const format = (task: typeof tasks[number]) => {
    const assignee = readTaskAssignee(task.content);
    const suffix = assignee ? ` (${assignee})` : "";
    return `- [${readTaskStatus(task.content) === "done" ? "x" : " "}] ${task.id}${suffix}: ${task.content.split("## Description\n\n")[1]?.trim().split("\n")[0] ?? ""}`;
  };
  const index = ["# Tasks", "", "## Open", "", ...open.map(format), "", "## Done", "", ...done.map(format), ""].join("\n");
  await writeAtomically(paths.tasksMarkdownPath, index);
}

async function writeAtomically(path: string, content: string): Promise<void> {
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporaryPath, content, { mode: 0o600 });
  await rename(temporaryPath, path);
}

function clampLimit(value: number): number {
  return Math.min(Math.max(Math.trunc(value) || 50, 1), 200);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
