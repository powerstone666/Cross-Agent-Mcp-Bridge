// Fake adapter for bridge service tests; starts no process.
import type {
  AgentAdapter,
  AgentEvent,
  AgentStatus,
  AgentTurnRequest,
} from "../../src/bridge/types/agent-adapter.js";

const ASK_APPROVAL_MARKER = "ask-approval";

// Replies "echo: <message>"; a message containing "ask-approval" asks for approval first.
export class EchoAdapter implements AgentAdapter {
  async *run(request: AgentTurnRequest): AsyncGenerator<AgentEvent> {
    if (request.messageText.includes(ASK_APPROVAL_MARKER)) {
      const decision = await request.requestApproval({
        kind: "command",
        summary: "Echo wants to run: ls",
        detailLines: [],
      });
      yield { kind: "reply_delta", text: `decision: ${decision}` };
      yield { kind: "reply_complete", text: "" };
      return;
    }
    yield { kind: "reply_delta", text: `echo: ${request.messageText}` };
    yield { kind: "reply_complete", text: "" };
  }

  async readStatus(): Promise<AgentStatus> {
    return {};
  }

  close(): void {}
}
