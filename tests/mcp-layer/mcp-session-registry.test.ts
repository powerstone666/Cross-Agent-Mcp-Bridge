import assert from "node:assert/strict";
import { test } from "node:test";
import { McpSessionRegistry, type McpSession } from "../../src/mcp-layer/mcp-session-registry.js";

function fakeSession(): McpSession & { closed: number } {
  const session = { inFlight: 0, closed: 0, async close() { session.closed += 1; } };
  return session;
}

test("closes a session once however often it is removed", async () => {
  const registry = new McpSessionRegistry(1000);
  const session = fakeSession();
  registry.add("a", session);
  await Promise.all([registry.remove("a"), registry.remove("a")]);
  await registry.remove("a");
  assert.equal(session.closed, 1);
  assert.equal(registry.get("a"), undefined);
});

test("sweeps only sessions that are idle and not serving a request or stream", async () => {
  let time = 0;
  const registry = new McpSessionRegistry(1000, () => time);
  const idle = fakeSession();
  const busy = fakeSession();
  const recent = fakeSession();
  registry.add("idle", idle);
  registry.add("busy", busy);
  registry.add("recent", recent);
  busy.inFlight = 1;
  time = 900;
  registry.get("recent");
  time = 1500;
  await registry.closeIdle();
  assert.deepEqual([idle.closed, busy.closed, recent.closed], [1, 0, 0]);
  // Using a session refreshes its timer.
  time = 2000;
  await registry.closeIdle();
  assert.equal(recent.closed, 1);
  assert.equal(busy.closed, 0);
});

test("closeAll closes every session and survives a session that fails to close", async () => {
  const registry = new McpSessionRegistry(1000);
  const good = fakeSession();
  registry.add("bad", { inFlight: 0, close: async () => { throw new Error("boom"); } });
  registry.add("good", good);
  const originalError = console.error;
  console.error = () => undefined;
  try { await registry.closeAll(); } finally { console.error = originalError; }
  assert.equal(good.closed, 1);
});
