// Proves each turn goes to the IDE while it is open and to the CLI when it is not.
import assert from "node:assert/strict";
import { test } from "node:test";
import { IdeFirstAdapter } from "../../src/bridge/ide-first-adapter.js";
import type { AgentAdapter, AgentEvent, AgentStatus } from "../../src/bridge/types/agent-adapter.js";

function fakeAdapter(name: string, readStatus: () => Promise<AgentStatus>): AgentAdapter & { closed: boolean } {
  return {
    closed: false,
    async *run({ messageText }) {
      yield { kind: "reply_delta", text: `${name}: ${messageText}` };
      yield { kind: "reply_complete", text: "" };
    },
    readStatus,
    close() { this.closed = true; },
  };
}

const request = (messageText: string) => ({
  messageText,
  workingDirectory: "/tmp",
  signal: new AbortController().signal,
  requestApproval: async () => "accept" as const,
});

async function replyOf(adapter: AgentAdapter, messageText: string): Promise<string> {
  const events: AgentEvent[] = [];
  for await (const event of adapter.run(request(messageText))) events.push(event);
  return events[0]?.text ?? "";
}

test("uses the IDE while it is open, the CLI when it is not or cannot be read, and closes both", async () => {
  let ideOpen = true;
  let statusFails = false;
  const ide = fakeAdapter("ide", async () => {
    if (statusFails) throw new Error("no socket folder");
    return { ideWrapperRunning: ideOpen };
  });
  const cli = fakeAdapter("cli", async () => ({ isSessionOpen: false }));
  const adapter = new IdeFirstAdapter({ ide, cli, isIdeOpen: (status) => status.ideWrapperRunning === true });

  assert.equal(await replyOf(adapter, "one"), "ide: one");
  assert.deepEqual(await adapter.readStatus(), { route: "ide", ideWrapperRunning: true });
  ideOpen = false;
  assert.equal(await replyOf(adapter, "two"), "cli: two");
  assert.deepEqual(await adapter.readStatus(), { route: "cli", isSessionOpen: false });
  statusFails = true;
  assert.equal(await replyOf(adapter, "three"), "cli: three");
  adapter.close();
  assert.deepEqual([ide.closed, cli.closed], [true, true]);
});
