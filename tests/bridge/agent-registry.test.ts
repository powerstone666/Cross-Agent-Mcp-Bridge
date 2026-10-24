// Proves one agent failing to start does not stop the others, and every adapter is closed.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createAgentRegistry } from "../../src/bridge/agent-registry.js";
import type { AgentAdapter } from "../../src/bridge/types/agent-adapter.js";
import {
  createFakeAgentModule,
  createReplyingAdapter,
} from "../fixtures/create-fake-agent-module.js";

const baseInput = { environment: {}, targetRepositoryPath: "/tmp", humanApprovalChannel: "terminal" } as const;

test("one agent failing to start does not stop the others", () => {
  const registry = createAgentRegistry({
    ...baseInput,
    modules: [
      createFakeAgentModule({ agentName: "broken", failureMessage: "not installed" }),
      createFakeAgentModule({ agentName: "works", adapter: createReplyingAdapter("ok") }),
    ],
  });
  assert.deepEqual([...registry.adapters.keys()], ["works"]);
  assert.deepEqual(registry.unavailableAgents, [{ agentName: "broken", reason: "not installed" }]);
  assert.deepEqual(registry.agentInfos, [{ agentName: "works", displayName: "WORKS", role: "coordinator", coordinator: null }]);
});

test("one coordinator owns the worker relationship and can be configured", () => {
  const modules = [
    createFakeAgentModule({ agentName: "one", adapter: createReplyingAdapter("one") }),
    createFakeAgentModule({ agentName: "two", adapter: createReplyingAdapter("two") }),
  ];
  const registry = createAgentRegistry({ ...baseInput, modules, environment: { RELAY_COORDINATOR_AGENT: "two" } });
  assert.deepEqual(registry.agentInfos.map(({ agentName, role, coordinator }) => ({ agentName, role, coordinator })), [
    { agentName: "one", role: "worker", coordinator: "two" },
    { agentName: "two", role: "coordinator", coordinator: null },
  ]);
  assert.throws(() => createAgentRegistry({ ...baseInput, modules, environment: { RELAY_COORDINATOR_AGENT: "missing" } }), /must name an available agent/);
});

test("close() closes every adapter", () => {
  const closedAgents: string[] = [];
  const closableAdapter = (agentName: string): AgentAdapter => ({
    ...createReplyingAdapter(agentName),
    close: () => closedAgents.push(agentName),
  });
  const registry = createAgentRegistry({
    ...baseInput,
    modules: [
      createFakeAgentModule({ agentName: "one", adapter: closableAdapter("one") }),
      createFakeAgentModule({ agentName: "two", adapter: closableAdapter("two") }),
    ],
  });
  registry.close();
  assert.deepEqual(closedAgents, ["one", "two"]);
});
