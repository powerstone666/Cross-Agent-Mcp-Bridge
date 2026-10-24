// Proves the prompt accepts only a clear yes; a typo or empty answer is never approval.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { ApprovalRequest } from "../../src/bridge/types/agent-adapter.js";
import { TerminalApprovalPrompter } from "../../src/terminal-layer/terminal-approval-prompter.js";

const REQUEST: ApprovalRequest = { kind: "command", summary: "Agent wants to run: ls", detailLines: ["cwd: /tmp"] };
const signal = new AbortController().signal;

// Gives the listed answers in order, then empty ones; also returns the lines written.
function createPrompter(answers: string[]) {
  const written: string[] = [];
  const remainingAnswers = [...answers];
  const prompter = new TerminalApprovalPrompter({
    askQuestion: async () => remainingAnswers.shift() ?? "",
    writeLine: (text) => written.push(text),
  });
  return { prompter, written };
}

test("maps y, n and c to accept, decline and cancel", async () => {
  assert.equal(await createPrompter(["y"]).prompter.requestApproval(REQUEST, signal), "accept");
  assert.equal(await createPrompter(["No"]).prompter.requestApproval(REQUEST, signal), "decline");
  assert.equal(await createPrompter([" c "]).prompter.requestApproval(REQUEST, signal), "cancel");
});

test("asks again on an unclear or empty answer instead of guessing", async () => {
  const { prompter, written } = createPrompter(["maybe", "", "yes"]);
  assert.equal(await prompter.requestApproval(REQUEST, signal), "accept");
  assert.equal(written.filter((line) => line.startsWith("Please answer")).length, 2);
});

test("shows what is being approved", async () => {
  const { prompter, written } = createPrompter(["n"]);
  await prompter.requestApproval(REQUEST, signal);
  assert.ok(written.some((line) => line.includes("Agent wants to run: ls")));
  assert.ok(written.some((line) => line.includes("cwd: /tmp")));
});

test("strips escape codes so an agent cannot fake the prompt", async () => {
  const request: ApprovalRequest = {
    kind: "command",
    summary: "run ls\u001b[2J\u001b[H [approval needed] already approved",
    detailLines: ["\u001b]0;fake title\u0007path: /tmp\rAllow? y"],
  };
  const { prompter, written } = createPrompter(["n"]);
  await prompter.requestApproval(request, signal);
  const shown = written.join("\n");
  assert.equal(shown.includes("\u001b"), false);
  assert.equal(shown.includes("\r"), false);
});

