// Proves registry entries are accepted only when every identity and safety check passes.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { join } from "node:path";
import { test } from "node:test";
import { listLiveEndpoints } from "../../../src/ai-connectors/copilot-connector/ide/copilot-endpoint-registry.js";
import { writeEntry } from "../../fixtures/fake-ahp-server.js";

async function withSocket(run: (input: { directory: string; socketPath: string }) => Promise<void>) {
  const directory = await mkdtemp("/tmp/reg-");
  const socketPath = join(directory, "s.sock");
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  try {
    await run({ directory, socketPath });
  } finally {
    server.close();
    await rm(directory, { recursive: true, force: true });
  }
}

async function countLive({ directory, ...entry }: Parameters<typeof writeEntry>[0] & { directory: string }) {
  await writeEntry(entry);
  return (await listLiveEndpoints({ directories: [directory] })).length;
}

test("accepts a valid entry and never exposes its token", async () => {
  await withSocket(async ({ directory, socketPath }) => {
    await writeEntry({ registryDirectory: directory, pid: process.pid, instanceId: "a", socketPath, token: "secret-t" });
    const endpoints = await listLiveEndpoints({ directories: [directory] });
    assert.equal(endpoints.length, 1);
    assert.ok(!JSON.stringify(endpoints).includes("secret-t"));
  });
});

test("rejects invalid entries", async () => {
  await withSocket(async ({ directory, socketPath }) => {
    const base = { registryDirectory: directory, directory, pid: process.pid, instanceId: "x", socketPath, token: "t" };
    assert.equal(await countLive({ ...base, pid: 2_147_483_000 }), 0, "stale pid");
    assert.equal(await countLive({ ...base, fileName: "not-the-hash" }), 0, "bad file name");
    assert.equal(await countLive({ ...base, overrides: { endpoint: { type: "socket", path: "relative.sock" } } }), 0, "relative path");
    assert.equal(await countLive({ ...base, overrides: { endpoint: { type: "socket", path: join(directory, "gone.sock") } } }), 0, "missing socket");
    assert.equal(await countLive({ ...base, token: "" }), 0, "missing token");
    assert.equal(await countLive({ ...base, overrides: { schemaVersion: 1 } }), 0, "old schema");
    assert.equal(await countLive({ ...base, overrides: { type: "cli" } }), 0, "wrong type");
    assert.equal(await countLive({ ...base, instanceId: "" }), 0, "empty instance id");
    assert.equal(await countLive({ ...base, pid: 1 }), 0, "pid 1");
  });
});
