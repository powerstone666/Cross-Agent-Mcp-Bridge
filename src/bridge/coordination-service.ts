// Coordinates room task file claims and Git worktrees without mixing shell commands with user input.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { appendFile, mkdir, readFile, realpath } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

const execFileAsync = promisify(execFile);

export interface CoordinationServiceOptions {
  targetRepositoryPath: string;
  worktreeRootPath?: string;
}

export interface FileClaim {
  roomId: string;
  taskId: string;
  filePath: string;
  participantId: string;
  claimedAt: string;
}

export interface TaskWorktree {
  roomId: string;
  taskId: string;
  path: string;
  branch: string;
}

export interface CoordinationEvent {
  roomId: string;
  type: "room.file.claimed" | "room.file.released" | "room.worktree.created" | "room.worktree.removed";
  actor: string;
  summary: string;
  resourcePath: string;
}

export class CoordinationService {
  private readonly repositoryPath: string;
  private readonly claimsPath: string;
  private readonly worktreeRootPath: string;
  private readonly listeners = new Set<(event: CoordinationEvent) => void>();
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly options: CoordinationServiceOptions) {
    this.repositoryPath = realpathSync(resolve(options.targetRepositoryPath));
    this.claimsPath = join(this.repositoryPath, ".agent-room", "coordination", "file-claims.jsonl");
    this.worktreeRootPath = resolve(options.worktreeRootPath ?? join(dirname(this.repositoryPath), `${basename(this.repositoryPath)}-agent-worktrees`));
  }

  async claimFile(input: { roomId: string; taskId: string; filePath: string; participantId: string }): Promise<FileClaim> {
    const roomId = identifier(input.roomId, "roomId");
    const taskId = identifier(input.taskId, "taskId");
    const participantId = input.participantId.trim();
    const filePath = this.resolveClaimPath(input.filePath);
    if (!participantId) throw new Error("participantId must not be empty.");
    if (filePath === this.repositoryPath || !filePath.startsWith(`${this.repositoryPath}/`)) throw new Error("filePath must be inside the target repository.");
    await this.validateTaskFile(roomId, taskId, input.filePath);

    return this.serial(async () => {
      const claims = await this.readClaims();
      const active = claims.find((claim) => claim.filePath === filePath);
      if (active && (active.roomId !== roomId || active.taskId !== taskId || active.participantId !== participantId)) {
        throw new Error(`File is already claimed by ${active.participantId} for task ${active.taskId}.`);
      }
      const claim = active ?? { roomId, taskId, filePath, participantId, claimedAt: new Date().toISOString() };
      if (!active) {
        await mkdir(dirname(this.claimsPath), { recursive: true, mode: 0o700 });
        await appendFile(this.claimsPath, `${JSON.stringify({ ...claim, action: "claim" })}\n`, { mode: 0o600 });
        this.publish({ roomId, type: "room.file.claimed", actor: participantId, summary: `${participantId} claimed ${filePath.split(/[\\/]/).at(-1)}.`, resourcePath: filePath });
      }
      return claim;
    });
  }

  async releaseFileClaim(input: { roomId: string; taskId: string; filePath: string; participantId: string }): Promise<{ released: boolean }> {
    const roomId = identifier(input.roomId, "roomId");
    const taskId = identifier(input.taskId, "taskId");
    const filePath = this.resolveClaimPath(input.filePath);
    const participantId = input.participantId.trim();
    return this.serial(async () => {
      const claims = await this.readClaims();
      const active = claims.find((claim) => claim.filePath === filePath && claim.roomId === roomId && claim.taskId === taskId && claim.participantId === participantId);
      if (!active) return { released: false };
      await appendFile(this.claimsPath, `${JSON.stringify({ ...active, action: "release", releasedAt: new Date().toISOString() })}\n`, { mode: 0o600 });
      this.publish({ roomId, type: "room.file.released", actor: participantId, summary: `${participantId} released ${filePath.split(/[\\/]/).at(-1)}.`, resourcePath: filePath });
      return { released: true };
    });
  }

  async listFileClaims(roomId?: string): Promise<FileClaim[]> {
    const claims = await this.readClaims();
    return roomId ? claims.filter((claim) => claim.roomId === identifier(roomId, "roomId")) : claims;
  }

  async createTaskWorktree(input: { roomId: string; taskId: string }): Promise<TaskWorktree> {
    const roomId = identifier(input.roomId, "roomId");
    const taskId = identifier(input.taskId, "taskId");
    const parentPath = join(this.worktreeRootPath, roomId);
    await mkdir(parentPath, { recursive: true });
    const path = join(await realpath(parentPath), taskId);
    const branch = `agent-room/${roomId}/${taskId}`;
    await execFileAsync("git", ["-C", this.repositoryPath, "worktree", "add", "-b", branch, path], { maxBuffer: 1024 * 1024 });
    this.publish({ roomId, type: "room.worktree.created", actor: "cross-agent-mcp-bridge", summary: `Created worktree for task ${taskId}.`, resourcePath: path });
    return { roomId, taskId, path, branch };
  }

  async listTaskWorktrees(): Promise<TaskWorktree[]> {
    const { stdout } = await execFileAsync("git", ["-C", this.repositoryPath, "worktree", "list", "--porcelain"], { maxBuffer: 1024 * 1024 });
    const entries = stdout.split(/\n\n/).filter(Boolean);
    const found: TaskWorktree[] = [];
    for (const entry of entries) {
      const path = entry.match(/^worktree (.+)$/m)?.[1];
      const match = entry.match(/^branch refs\/heads\/agent-room\/([^/]+)\/([^/]+)$/m);
      if (!path || !match) continue;
      const [, roomId, taskId] = match;
      if (!roomId || !taskId) continue;
      found.push({ roomId, taskId, path, branch: `agent-room/${roomId}/${taskId}` });
    }
    return found;
  }

  async removeTaskWorktree(input: { roomId: string; taskId: string }): Promise<{ removed: boolean; path: string }> {
    const roomId = identifier(input.roomId, "roomId");
    const taskId = identifier(input.taskId, "taskId");
    const path = join(await realpath(join(this.worktreeRootPath, roomId)).catch(() => join(this.worktreeRootPath, roomId)), taskId);
    const { stdout } = await execFileAsync("git", ["-C", this.repositoryPath, "worktree", "list", "--porcelain"], { maxBuffer: 1024 * 1024 });
    if (!stdout.split(/\n\n/).some((entry) => entry.split("\n").includes(`worktree ${path}`))) return { removed: false, path };
    // Git refuses dirty worktrees by default so uncommitted work is preserved.
    await execFileAsync("git", ["-C", this.repositoryPath, "worktree", "remove", path], { maxBuffer: 1024 * 1024 });
    this.publish({ roomId, type: "room.worktree.removed", actor: "cross-agent-mcp-bridge", summary: `Removed worktree for task ${taskId}.`, resourcePath: path });
    return { removed: true, path };
  }

  subscribe(listener: (event: CoordinationEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private publish(event: CoordinationEvent): void {
    for (const listener of this.listeners) {
      try { listener(event); } catch { /* Activity consumers must not interrupt a completed coordination action. */ }
    }
  }

  private async readClaims(): Promise<FileClaim[]> {
    try {
      const lines = (await readFile(this.claimsPath, "utf8")).split("\n").filter(Boolean);
      const active = new Map<string, FileClaim>();
      for (const line of lines) {
        const event = JSON.parse(line) as FileClaim & { action: "claim" | "release" };
        const key = event.filePath;
        if (event.action === "claim") active.set(key, event);
        else if (event.action === "release") active.delete(key);
      }
      return [...active.values()].map(({ roomId, taskId, filePath, participantId, claimedAt }) => ({ roomId, taskId, filePath, participantId, claimedAt }));
    } catch (error) {
      if (isMissing(error)) return [];
      throw error;
    }
  }

  private resolveClaimPath(filePath: string): string {
    const resolved = resolve(this.repositoryPath, filePath);
    if (resolved === this.repositoryPath || !resolved.startsWith(`${this.repositoryPath}/`)) throw new Error("filePath must be inside the target repository.");
    return resolved;
  }

  private async validateTaskFile(roomId: string, taskId: string, requestedFilePath: string): Promise<void> {
    const taskPath = join(this.repositoryPath, ".agent-room", "rooms", roomId, "tasks", `${taskId}.md`);
    const task = await readFile(taskPath, "utf8");
    const declaredFiles = task.match(/^- Files:\s*(.+)$/im)?.[1]?.trim();
    if (!declaredFiles || declaredFiles === "none") return;
    const requested = requestedFilePath.replaceAll("\\", "/").replace(/^\.\//, "");
    const files = declaredFiles.split(",").map((file) => file.trim().replaceAll("\\", "/").replace(/^\.\//, ""));
    if (!files.includes(requested)) throw new Error(`Task ${taskId} does not list ${requested} as an owned file.`);
  }

  private async serial<T>(operation: () => Promise<T>): Promise<T> {
    let result!: T;
    const next = this.queue.then(async () => { result = await operation(); });
    this.queue = next.catch(() => undefined);
    await next;
    return result;
  }
}

function identifier(value: string, name: string): string {
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(value) || value.includes("..")) throw new Error(`${name} must contain only letters, numbers, dot, underscore, or dash.`);
  return value;
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
