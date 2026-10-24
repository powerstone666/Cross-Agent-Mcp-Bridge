// Fake `claude` speaking stream-json, so tests need no real Claude or network.
// Prompts: "needs-approval", "cancelled-approval", "dialog", "hang", "fail", "crash",
// "no-deltas", "show-args"; other text is echoed.
import { createInterface } from "node:readline";

const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
const SESSION_ID = "session-1";
const APPROVAL_INPUT = { command: "rm -rf build", description: "remove build output" };
let hasStarted = false;
let isTurnOpen = false;
let nextRequestId = 1;
// Control requests sent to the client, each waiting for its control_response.
const responseWaiters = new Map();

function say(text) {
  const parts = [text.slice(0, Math.ceil(text.length / 2)), text.slice(Math.ceil(text.length / 2))];
  for (const part of parts.filter(Boolean)) {
    send({ type: "stream_event", session_id: SESSION_ID, parent_tool_use_id: null, event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: part } } });
  }
  send({ type: "assistant", session_id: SESSION_ID, parent_tool_use_id: null, message: { role: "assistant", content: [{ type: "text", text }] } });
}

function finish({ isError = false, subtype = "success", result = "" } = {}) {
  isTurnOpen = false;
  send({ type: "result", subtype: isError ? "error_during_execution" : subtype, is_error: isError, result, session_id: SESSION_ID });
}

function askClient(request, onResponse) {
  const requestId = `req-${nextRequestId++}`;
  responseWaiters.set(requestId, onResponse);
  send({ type: "control_request", request_id: requestId, request });
  return requestId;
}

function runTurn(text) {
  if (!hasStarted) {
    hasStarted = true;
    send({ type: "system", subtype: "init", session_id: SESSION_ID });
  }
  isTurnOpen = true;
  if (text.includes("crash")) {
    console.error("fatal: fake crash");
    process.exit(3);
  } else if (text.includes("fail")) {
    finish({ isError: true, result: "model exploded" });
  } else if (text.includes("hang")) {
    // Ends only when the client sends an interrupt.
  } else if (text.includes("no-deltas")) {
    send({ type: "assistant", session_id: SESSION_ID, parent_tool_use_id: null, message: { role: "assistant", content: [{ type: "text", text: "only assistant text" }] } });
    finish();
  } else if (text.includes("show-args")) {
    say(`cwd=${process.cwd()} args=${process.argv.slice(2).join(" ")}`);
    finish();
  } else if (text.includes("dialog")) {
    askClient({ subtype: "request_user_dialog" }, (response) => {
      say(`dialog=${response.subtype}`);
      finish();
    });
  } else if (text.includes("cancelled-approval")) {
    const requestId = askClient({ subtype: "can_use_tool", tool_name: "Bash", input: APPROVAL_INPUT }, reportApproval);
    send({ type: "control_cancel_request", request_id: requestId });
  } else if (text.includes("needs-approval")) {
    askClient({ subtype: "can_use_tool", tool_name: "Bash", input: APPROVAL_INPUT, title: "Run command", description: "remove build output" }, reportApproval);
  } else if (text.includes("needs-edit")) {
    askClient({ subtype: "can_use_tool", tool_name: "Edit", input: { file_path: "/tmp/a.txt" } }, reportApproval);
  } else {
    say(`echo: ${text}`);
    finish();
  }
}

function reportApproval(response) {
  const decision = response.response ?? {};
  say(JSON.stringify({
    behavior: decision.behavior,
    interrupt: decision.interrupt,
    message: decision.message,
    updatedInputMatches: JSON.stringify(decision.updatedInput) === JSON.stringify(APPROVAL_INPUT),
    hasUpdatedPermissions: "updatedPermissions" in decision,
  }));
  if (decision.interrupt === true) finish({ isError: true });
  else finish();
}

createInterface({ input: process.stdin }).on("line", (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  if (message.type === "user") {
    const text = message.message?.content?.[0]?.text ?? "";
    runTurn(text);
  } else if (message.type === "control_response") {
    const waiter = responseWaiters.get(message.response?.request_id);
    responseWaiters.delete(message.response?.request_id);
    waiter?.(message.response);
  } else if (message.type === "control_request" && message.request?.subtype === "interrupt") {
    send({ type: "control_response", response: { subtype: "success", request_id: message.request_id } });
    if (isTurnOpen) finish({ isError: true });
  }
});
