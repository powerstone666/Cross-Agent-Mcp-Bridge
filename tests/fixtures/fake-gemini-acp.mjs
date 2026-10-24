// Fake `gemini --experimental-acp` agent, so tests need no real Gemini or network.
// Prompt words pick the script: needs-approval, hang, crash, malformed, unknown-request,
// show-session, show-cwd; other text is echoed.
import { createInterface } from "node:readline";

const send = (message) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
const update = (sessionUpdate, fields) =>
  send({ method: "session/update", params: { sessionId: "session-1", update: { sessionUpdate, ...fields } } });
const chunk = (text) => update("agent_message_chunk", { content: { type: "text", text } });

let sessionCwd = null;
let promptCount = 0;
let activePromptId = null;
// Replies to our own requests, keyed by request id.
const replyWaiters = new Map();

function endPrompt(stopReason) {
  if (activePromptId === null) return;
  const id = activePromptId;
  activePromptId = null;
  send({ id, result: { stopReason } });
}

function askAgentRequest(method, params, onReply) {
  const id = method === "session/request_permission" ? 100 : 200;
  replyWaiters.set(id, onReply);
  send({ id, method, params });
}

function runPrompt(text) {
  if (text.includes("needs-approval")) {
    chunk("preparing. ");
    update("tool_call", { toolCallId: "t1", title: "rm -rf build", kind: "execute", status: "pending" });
    askAgentRequest(
      "session/request_permission",
      {
        sessionId: "session-1",
        toolCall: { toolCallId: "t1", title: "rm -rf build", kind: "execute", locations: [{ path: "/tmp/build" }], content: [{ type: "content", content: { type: "text", text: "rm -rf build\nin /tmp" } }] },
        options: [
          { optionId: "allow-always", name: "Always", kind: "allow_always" },
          { optionId: "allow-once", name: "Yes", kind: "allow_once" },
          { optionId: "reject-always", name: "Never", kind: "reject_always" },
          { optionId: "reject-once", name: "No", kind: "reject_once" },
        ],
      },
      (result) => {
        const outcome = result?.outcome;
        if (outcome?.outcome === "selected" && outcome.optionId === "allow-once") {
          update("tool_call_update", { toolCallId: "t1", status: "completed" });
          chunk("done: allowed");
          endPrompt("end_turn");
        } else {
          chunk(`not allowed: ${outcome?.outcome === "selected" ? outcome.optionId : "cancelled"}`);
          endPrompt("cancelled");
        }
      },
    );
  } else if (text.includes("hang")) {
    // On purpose: only session/cancel ends this prompt.
  } else if (text.includes("crash")) {
    chunk("about to crash");
    process.stderr.write("fatal: boom\n");
    process.exit(3);
  } else if (text.includes("malformed")) {
    process.stdout.write("not json at all\n");
    process.stdout.write("[1,2,3]\n");
    chunk("survived");
    endPrompt("end_turn");
  } else if (text.includes("unknown-request")) {
    askAgentRequest("fs/read_text_file", { sessionId: "session-1", path: "/etc/hosts" }, (_result, error) => {
      chunk(`code=${error?.code}`);
      endPrompt("end_turn");
    });
  } else if (text.includes("show-session")) {
    chunk(`session=session-1 prompts=${promptCount} pid=${process.pid}`);
    endPrompt("end_turn");
  } else if (text.includes("show-cwd")) {
    chunk(`cwd=${sessionCwd} processCwd=${process.cwd()}`);
    endPrompt("end_turn");
  } else {
    chunk("echo: ");
    chunk(text);
    update("agent_thought_chunk", { content: { type: "text", text: "secret thoughts" } });
    endPrompt("end_turn");
  }
}

createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === undefined && message.id !== undefined) {
    replyWaiters.get(message.id)?.(message.result, message.error);
    replyWaiters.delete(message.id);
  } else if (message.method === "initialize") {
    send({ id: message.id, result: { protocolVersion: 1, agentCapabilities: {}, authMethods: [{ id: "oauth-personal", name: "Login" }] } });
  } else if (message.method === "authenticate") {
    send({ id: message.id, result: {} });
  } else if (message.method === "session/new") {
    sessionCwd = message.params.cwd;
    send({ id: message.id, result: { sessionId: "session-1" } });
  } else if (message.method === "session/prompt") {
    promptCount += 1;
    activePromptId = message.id;
    runPrompt(message.params.prompt[0].text);
  } else if (message.method === "session/cancel") {
    endPrompt("cancelled");
  }
});
