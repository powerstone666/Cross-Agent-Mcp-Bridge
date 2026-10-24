// Tracks live MCP sessions so each one is closed exactly once, including clients that vanish without a DELETE.
export interface McpSession {
  /** Requests and open streams still being served; a session in use is never swept. */
  inFlight: number;
  close(): Promise<void>;
}

export class McpSessionRegistry<Session extends McpSession = McpSession> {
  private readonly sessions = new Map<string, { session: Session; lastUsedAt: number }>();

  constructor(private readonly idleTimeoutMs: number, private readonly now: () => number = Date.now) {}

  add(sessionId: string, session: Session): void {
    this.sessions.set(sessionId, { session, lastUsedAt: this.now() });
  }

  get(sessionId: string): Session | undefined {
    const entry = this.sessions.get(sessionId);
    if (entry) entry.lastUsedAt = this.now();
    return entry?.session;
  }

  // Removes first so a repeated call (DELETE then transport close) cannot close twice.
  async remove(sessionId: string): Promise<void> {
    const entry = this.sessions.get(sessionId);
    if (!entry) return;
    this.sessions.delete(sessionId);
    await entry.session.close().catch((error: unknown) => console.error("MCP session close failed:", error));
  }

  async closeIdle(): Promise<void> {
    const cutoff = this.now() - this.idleTimeoutMs;
    const idle = [...this.sessions].filter(([, { session, lastUsedAt }]) => session.inFlight === 0 && lastUsedAt <= cutoff);
    await Promise.all(idle.map(([sessionId]) => this.remove(sessionId)));
  }

  async closeAll(): Promise<void> {
    await Promise.all([...this.sessions.keys()].map((sessionId) => this.remove(sessionId)));
  }

  // Returns a function that stops the periodic sweep. The timer never keeps the process alive.
  startSweeping(intervalMs: number): () => void {
    const timer = setInterval(() => { void this.closeIdle(); }, intervalMs);
    timer.unref();
    return () => clearInterval(timer);
  }
}
