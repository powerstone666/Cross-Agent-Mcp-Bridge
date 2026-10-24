import assert from "node:assert/strict";
import { test } from "node:test";
import { ApprovalQueue } from "../../src/bridge/approval-queue.js";

test("waits for an explicit dashboard approval decision", async () => {
  const approvals = new ApprovalQueue();
  const controller = new AbortController();
  const pendingDecision = approvals.requestApproval({ kind: "file-change", summary: "Change files", detailLines: ["src/app.ts"] }, controller.signal);
  const [pending] = approvals.listPending();
  assert.ok(pending);
  assert.equal(approvals.decide(pending.approvalId, "accept"), true);
  assert.equal(await pendingDecision, "accept");
  assert.deepEqual(approvals.listPending(), []);
});

test("turn cancellation clears a waiting approval", async () => {
  const approvals = new ApprovalQueue();
  const controller = new AbortController();
  const pendingDecision = approvals.requestApproval({ kind: "command", summary: "Run command", detailLines: ["npm test"] }, controller.signal);
  controller.abort();
  assert.equal(await pendingDecision, "cancel");
  assert.deepEqual(approvals.listPending(), []);
});
