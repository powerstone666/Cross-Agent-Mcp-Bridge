// Fake `codex app-server` with scripted replies, so tests need no real Codex or network.
// "show-config" replies with the `thread/start` settings (FAKE_CODEX_DEFAULT_POLICY sets the
// policy Codex applies when the client sends none), "needs-approval" asks for approval,
// "hang" never finishes until interrupted; other text is echoed.
import { createInterface } from "node:readline";

const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
let threadStartParams = null;
let activeTurn = null;
let nextServerRequestId = 1000;
let startedThreadCount = 0;
// Approval requests sent, keyed by request id, each waiting for the client's answer.
const approvalWaiters = new Map();

function finishTurn(status) {
  if (!activeTurn) return;
  const { threadId, turnId } = activeTurn;
  activeTurn = null;
  send({ method: "turn/completed", params: { threadId, turn: { id: turnId, status, items: [] } } });
}

function delta(text) {
  send({ method: "item/agentMessage/delta", params: { threadId: activeTurn.threadId, turnId: activeTurn.turnId, itemId: "i1", delta: text } });
}

function runTurn(text) {
  if (text.includes("show-config")) {
    delta(JSON.stringify({ threadId: activeTurn.threadId, cwd: threadStartParams.cwd, approvalPolicy: threadStartParams.approvalPolicy, approvalsReviewer: threadStartParams.approvalsReviewer, sandbox: threadStartParams.sandbox }));
    finishTurn("completed");
  } else if (text.includes("needs-approval")) {
    const id = nextServerRequestId++;
    approvalWaiters.set(id, (decision) => {
      delta(`decision=${decision}`);
      finishTurn(decision === "cancel" ? "interrupted" : "completed");
    });
    send({ id, method: "item/commandExecution/requestApproval", params: { threadId: activeTurn.threadId, turnId: activeTurn.turnId, itemId: "i2", startedAtMs: 0, command: "rm -rf build", reason: "cleanup" } });
  } else if (text.includes("hang")) {
    // On purpose: the test must end this turn with `turn/interrupt`.
  } else {
    delta("echo: ");
    delta(text);
    finishTurn("completed");
  }
}

createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  // An id with no method is the client's answer to one of our requests.
  if (message.method === undefined && message.id !== undefined) {
    approvalWaiters.get(message.id)?.(message.result?.decision ?? "error");
    approvalWaiters.delete(message.id);
    return;
  }
  if (message.method === "initialize") {
    send({ id: message.id, result: { codexHome: "/tmp", platformFamily: "unix", platformOs: "macos", userAgent: "fake" } });
  } else if (message.method === "thread/start") {
    threadStartParams = message.params;
    const params = message.params ?? {};
    send({ id: message.id, result: {
      thread: { id: `thread-${++startedThreadCount}` },
      approvalPolicy: params.approvalPolicy ?? process.env.FAKE_CODEX_DEFAULT_POLICY ?? "on-request",
      approvalsReviewer: params.approvalsReviewer ?? "user",
      sandbox: { type: params.sandbox ?? "workspace-write" },
    } });
  } else if (message.method === "turn/start") {
    activeTurn = { threadId: message.params.threadId, turnId: "turn-1" };
    send({ id: message.id, result: { turn: { id: "turn-1", status: "inProgress", items: [] } } });
    runTurn(message.params.input[0].text);
  } else if (message.method === "turn/interrupt") {
    send({ id: message.id, result: {} });
    finishTurn("interrupted");
  }
});
