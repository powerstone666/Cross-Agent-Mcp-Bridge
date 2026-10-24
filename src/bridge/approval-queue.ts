import { randomUUID } from "node:crypto";
import type { ApprovalDecision, ApprovalPrompter, ApprovalRequest } from "./types/agent-adapter.js";

export interface PendingApproval {
  approvalId: string;
  request: ApprovalRequest;
  createdAt: string;
}

// Keeps MCP-mode approvals answerable from the local dashboard while the tool call waits.
export class ApprovalQueue implements ApprovalPrompter {
  private readonly pending = new Map<string, PendingApproval>();
  private readonly listeners = new Set<() => void>();

  requestApproval(request: ApprovalRequest, signal: AbortSignal): Promise<ApprovalDecision> {
    if (signal.aborted) return Promise.resolve("cancel");
    const approval: PendingApproval = { approvalId: randomUUID(), request, createdAt: new Date().toISOString() };
    return new Promise((resolve) => {
      const finish = (decision: ApprovalDecision) => {
        if (!this.pending.delete(approval.approvalId)) return;
        this.resolvers.delete(approval.approvalId);
        signal.removeEventListener("abort", cancel);
        this.notify();
        resolve(decision);
      };
      const cancel = () => finish("cancel");
      this.pending.set(approval.approvalId, approval);
      this.resolvers.set(approval.approvalId, finish);
      signal.addEventListener("abort", cancel, { once: true });
      this.notify();
      if (signal.aborted) cancel();
    });
  }

  private readonly resolvers = new Map<string, (decision: ApprovalDecision) => void>();

  decide(approvalId: string, decision: ApprovalDecision): boolean {
    const resolve = this.resolvers.get(approvalId);
    if (!resolve) return false;
    resolve(decision);
    return true;
  }

  listPending(): PendingApproval[] {
    return [...this.pending.values()];
  }

  cancelAll(): void {
    for (const approval of this.listPending()) this.decide(approval.approvalId, "cancel");
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify(): void {
    for (const listener of this.listeners) {
      try { listener(); } catch { /* A dashboard update must not strand an approval request. */ }
    }
  }
}
