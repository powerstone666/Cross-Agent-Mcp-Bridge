// Test helpers: a fake agent module and a fake adapter that replies "<prefix>: <message>".
import type { AgentAdapter } from "../../src/bridge/types/agent-adapter.js";
import type { AgentModule } from "../../src/bridge/types/agent-module.js";

// If `failureMessage` is set, creating the adapter throws it (an agent that cannot start).
export function createFakeAgentModule({
  agentName,
  adapter,
  failureMessage,
}: {
  agentName: string;
  adapter?: AgentAdapter;
  failureMessage?: string;
}): AgentModule {
  return {
    agentName,
    displayName: agentName.toUpperCase(),
    createAdapter() {
      if (failureMessage !== undefined) throw new Error(failureMessage);
      if (!adapter) throw new Error("fake module needs an adapter");
      return adapter;
    },
    describeVscodeSetting: () => null,
  };
}

// `readStatus` returns the prefix, so a test can tell which fake agent answered.
export function createReplyingAdapter(replyPrefix: string): AgentAdapter {
  return {
    async *run(request) {
      yield { kind: "reply_delta", text: `${replyPrefix}: ${request.messageText}` };
      yield { kind: "reply_complete", text: "" };
    },
    async readStatus() {
      return { prefix: replyPrefix };
    },
    close() {},
  };
}
