// Asks the human in the terminal to approve or refuse a command or file change.
// Never guess: only a clear y, n or c counts, and the relay never accepts on its own.
import type {
  ApprovalDecision,
  ApprovalPrompter,
  ApprovalRequest,
} from "../bridge/types/agent-adapter.js";
import { stripTerminalControl } from "../bridge/utils/strip-terminal-control.js";

const APPROVAL_QUESTION = "Allow? [y]es / [n]o / [c]ancel turn: ";

// Unknown answers are not in this table, so the human is asked again.
const DECISION_BY_ANSWER: Readonly<Record<string, ApprovalDecision>> = {
  y: "accept",
  yes: "accept",
  n: "decline",
  no: "decline",
  c: "cancel",
  cancel: "cancel",
};

// Terminal actions are passed in so tests need no real terminal.
export interface TerminalApprovalPrompterOptions {
  askQuestion(question: string, signal: AbortSignal): Promise<string>;
  writeLine(text: string): void;
}

// Returns accept, decline or cancel. If `signal` aborts, `askQuestion` rejects.
export class TerminalApprovalPrompter implements ApprovalPrompter {
  constructor(private readonly options: TerminalApprovalPrompterOptions) {}

  async requestApproval(
    request: ApprovalRequest,
    signal: AbortSignal,
  ): Promise<ApprovalDecision> {
    const { askQuestion, writeLine } = this.options;
    // The text comes from an agent, so strip control codes that could fake this prompt.
    writeLine(`\n[approval needed] ${stripTerminalControl(request.summary)}`);
    for (const detailLine of request.detailLines) {
      writeLine(`  ${stripTerminalControl(detailLine)}`);
    }

    while (true) {
      const answer = await askQuestion(APPROVAL_QUESTION, signal);
      const decision = DECISION_BY_ANSWER[answer.trim().toLowerCase()];
      if (decision) return decision;
      writeLine("Please answer y, n or c.");
    }
  }
}
