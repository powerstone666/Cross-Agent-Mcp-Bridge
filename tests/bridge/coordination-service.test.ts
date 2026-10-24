import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CoordinationService } from "../../src/bridge/coordination-service.js";

const exec = promisify(execFile);

async function createRepository(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "cross-agent-mcp-bridge-coordination-"));
  await exec("git", ["init", path]);
  await exec("git", ["-C", path, "config", "user.email", "test@example.com"]);
  await exec("git", ["-C", path, "config", "user.name", "Test"]);
  await writeFile(join(path, "README.md"), "base\n");
  await exec("git", ["-C", path, "add", "README.md"]);
  await exec("git", ["-C", path, "commit", "-m", "initial"]);
  return path;
}

test("file claims serialize competing participants and can be released", async () => {
  const repositoryPath = await mkdtemp(join(tmpdir(), "cross-agent-mcp-bridge-claims-"));
  try {
    const taskDirectory = join(repositoryPath, ".agent-room", "rooms", "backend", "tasks");
    await mkdir(taskDirectory, { recursive: true });
    await writeFile(join(taskDirectory, "task-1.md"), "# Task\n\n- Files: src/app.ts\n");
    const coordination = new CoordinationService({ targetRepositoryPath: repositoryPath });
    const claim = { roomId: "backend", taskId: "task-1", filePath: "src/app.ts", participantId: "codex" };
    const results = await Promise.allSettled([
      coordination.claimFile(claim),
      coordination.claimFile({ ...claim, participantId: "claude" }),
    ]);
    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    assert.equal((await coordination.listFileClaims()).length, 1);
    const owner = results.find((result): result is PromiseFulfilledResult<Awaited<ReturnType<typeof coordination.claimFile>>> => result.status === "fulfilled")!.value;
    assert.deepEqual(await coordination.releaseFileClaim({ ...claim, participantId: owner.participantId }), { released: true });
    assert.deepEqual(await coordination.listFileClaims(), []);
    await assert.rejects(coordination.claimFile({ ...claim, filePath: "../outside" }), /inside the target repository/);
    await assert.rejects(coordination.claimFile({ ...claim, filePath: "src/other.ts" }), /does not list/);
  } finally {
    await rm(repositoryPath, { recursive: true, force: true });
  }
});

test("task worktrees can be created, listed, and removed without force", async () => {
  const repositoryPath = await createRepository();
  const worktreeRootPath = join(repositoryPath, "..", `${repositoryPath.split("/").at(-1)}-worktrees`);
  try {
    const coordination = new CoordinationService({ targetRepositoryPath: repositoryPath, worktreeRootPath });
    const created = await coordination.createTaskWorktree({ roomId: "backend", taskId: "task-1" });
    assert.equal(created.branch, "agent-room/backend/task-1");
    assert.deepEqual(await coordination.listTaskWorktrees(), [created]);
    assert.deepEqual(await coordination.removeTaskWorktree({ roomId: "backend", taskId: "task-1" }), { removed: true, path: created.path });
    assert.deepEqual(await coordination.listTaskWorktrees(), []);
  } finally {
    await rm(worktreeRootPath, { recursive: true, force: true });
    await rm(repositoryPath, { recursive: true, force: true });
  }
});
