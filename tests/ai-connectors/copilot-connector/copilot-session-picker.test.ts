// Checks Agent Host session creation and provider selection without opening an editor socket.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createProviderSession } from "../../../src/ai-connectors/copilot-connector/ide/copilot-session-picker.js";
import type { CopilotAhpClient } from "../../../src/ai-connectors/copilot-connector/ide/copilot-ahp-client.js";

test("creates a session with the chosen provider and encoded workspace URI", async () => {
  const calls: Array<{ method: string; params: unknown }> = [];
  let notify = (_notification: { method: string; params: unknown }) => {};
  const client = {
    onNotification(handler: typeof notify) { notify = handler; },
    async request({ method, params }: { method: string; params: unknown }) {
      calls.push({ method, params });
      if (method === "subscribe") {
        queueMicrotask(() => notify({
          method: "action",
          params: { channel: (params as { channel: string }).channel, action: { type: "session/ready" } },
        }));
        return { snapshot: { state: { lifecycle: "creating" } } };
      }
      return null;
    },
  } as unknown as CopilotAhpClient;

  const session = await createProviderSession({
    client,
    provider: "claude",
    workingDirectory: "/tmp/my project",
  });

  assert.match(session, /^ahp-session:\//);
  assert.deepEqual(calls.map(({ method }) => method), ["createSession", "subscribe"]);
  const params = calls[0]?.params as { provider: string; workingDirectories: string[] };
  assert.equal(params.provider, "claude");
  assert.equal(params.workingDirectories[0], "file:///tmp/my%20project");
});

test("surfaces a session initialization failure from the host", async () => {
  let notify = (_notification: { method: string; params: unknown }) => {};
  const client = {
    onNotification(handler: (notification: { method: string; params: unknown }) => void) {
      notify = handler;
    },
    async request({ method, params }: { method: string; params: unknown }) {
      if (method === "subscribe") {
        queueMicrotask(() => notify({
          method: "action",
          params: { channel: (params as { channel: string }).channel, action: { type: "session/creationFailed", error: { message: "Claude provider is disabled" } } },
        }));
        return { snapshot: { state: { lifecycle: "creating" } } };
      }
      return null;
    },
  } as unknown as CopilotAhpClient;

  await assert.rejects(
    createProviderSession({ client, provider: "claude", workingDirectory: "/tmp" }),
    /Claude provider is disabled/,
  );
});
