// Runs each turn in the agent's IDE when it is open, so the human can watch it there, and in the
// agent's CLI otherwise. Never name a specific agent here.
import type { AgentAdapter, AgentEvent, AgentStatus, AgentTurnRequest } from "./types/agent-adapter.js";

export interface IdeFirstAdapterOptions {
  ide: AgentAdapter;
  cli: AgentAdapter;
  // Reads the IDE adapter's status and answers whether a turn can go there now.
  isIdeOpen(status: AgentStatus): boolean;
}

export class IdeFirstAdapter implements AgentAdapter {
  constructor(private readonly options: IdeFirstAdapterOptions) {}

  async *run(request: AgentTurnRequest): AsyncGenerator<AgentEvent> {
    const adapter = (await this.isIdeOpen()) ? this.options.ide : this.options.cli;
    yield* adapter.run(request);
  }

  async readStatus(): Promise<AgentStatus> {
    const ideStatus = await this.readIdeStatus();
    if (ideStatus && this.options.isIdeOpen(ideStatus)) return { route: "ide", ...ideStatus };
    return { route: "cli", ...(await this.options.cli.readStatus()) };
  }

  close(): void {
    this.options.ide.close();
    this.options.cli.close();
  }

  private async isIdeOpen(): Promise<boolean> {
    const status = await this.readIdeStatus();
    return status !== undefined && this.options.isIdeOpen(status);
  }

  private async readIdeStatus(): Promise<AgentStatus | undefined> {
    try {
      return await this.options.ide.readStatus();
    } catch {
      return undefined;
    }
  }
}
