// Writes the event log: JSONL, one file per conversation, by default in
// <target repo>/.cross-agent-mcp-bridge/log/.
// Never rewrite or delete past lines, and never send events anywhere else.

import { appendFile, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  RelayEvent,
  RelayEventInput,
} from "./types/relay-event.js";

// Owner-only, because the log holds the full conversation and may contain secrets.
// A mode applies only when a file is created, so existing files keep their permissions.
const LOG_DIRECTORY_MODE = 0o700;
const LOG_FILE_MODE = 0o600;
const ISO_DATE_LENGTH = "yyyy-mm-dd".length;

export interface EventLogServiceOptions {
  logDirectoryPath: string;
}

// Append-only log. Writes run one after another, so lines never mix. `serverSequence`
// orders events even when two timestamps are equal.
// shortcut: sequence numbers live in memory, so a restart starts a new file, upgrade by
// counting existing lines when conversations must continue across restarts.
export class EventLogService {
  private readonly nextSequenceByConversation = new Map<string, number>();
  private readonly filePathByConversation = new Map<string, string>();
  // Each write waits for the one before it, so lines keep the order of `append` calls.
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(private readonly options: EventLogServiceOptions) {}

  // Resolves with the stored event once it is on disk. Rejects if this write fails.
  append(eventInput: RelayEventInput): Promise<RelayEvent> {
    // Taken before any `await`, so two quick calls never get the same number.
    const timestamp = new Date().toISOString();
    const serverSequence =
      this.nextSequenceByConversation.get(eventInput.conversationId) ?? 1;
    this.nextSequenceByConversation.set(
      eventInput.conversationId,
      serverSequence + 1,
    );

    const event: RelayEvent = { serverSequence, timestamp, ...eventInput };
    const filePath = this.resolveFilePath({
      conversationId: event.conversationId,
      timestamp,
    });

    // Created on every write: cheap, and survives the folder being deleted mid-run.
    const written = this.writeQueue.then(async () => {
      await mkdir(this.options.logDirectoryPath, {
        recursive: true,
        mode: LOG_DIRECTORY_MODE,
      });
      await appendFile(filePath, `${JSON.stringify(event)}\n`, {
        mode: LOG_FILE_MODE,
      });
    });
    // Keep the chain alive after a failure, or one error would block every later write.
    // The caller still sees it through `written`.
    this.writeQueue = written.catch(() => undefined);
    return written.then(() => event);
  }

  // Empty for a conversation this process has not written (see the shortcut above).
  async readConversation(conversationId: string): Promise<RelayEvent[]> {
    // Wait for pending writes, so a read right after `append` sees that event.
    await this.writeQueue;
    const filePath = this.filePathByConversation.get(conversationId);
    if (!filePath) return [];

    const fileText = await readFile(filePath, "utf8");
    const events: RelayEvent[] = [];
    for (const line of fileText.split("\n")) {
      if (!line) continue;
      try {
        events.push(JSON.parse(line) as RelayEvent);
      } catch {
        // A crash can leave a cut-off last line. Skip it.
      }
    }
    return events;
  }

  // The name uses the first event's date and never changes, so one file survives midnight.
  private resolveFilePath({
    conversationId,
    timestamp,
  }: {
    conversationId: string;
    timestamp: string;
  }): string {
    const knownPath = this.filePathByConversation.get(conversationId);
    if (knownPath) return knownPath;

    const datePrefix = timestamp.slice(0, ISO_DATE_LENGTH);
    const filePath = join(
      this.options.logDirectoryPath,
      `${datePrefix}-${conversationId}.jsonl`,
    );
    this.filePathByConversation.set(conversationId, filePath);
    return filePath;
  }
}
