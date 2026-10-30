// Sends a relay turn into the Codex IDE through the wrapper's socket and streams the reply back.
// Never answer an approval here. The human answers it in the IDE.
import { randomUUID } from "node:crypto";
import { readdir, stat } from "node:fs/promises";
import { connect, type Socket } from "node:net";
import { join } from "node:path";
import { createInterface } from "node:readline";
import type {
  AgentAdapter,
  AgentEvent,
  AgentStatus,
  AgentTurnRequest,
} from "../../../bridge/types/agent-adapter.js";
import type {
  NewThreadParams,
  IdeClientMessage,
  IdeServerMessage,
} from "./codex-ide-protocol.js";
import { createAsyncQueue } from "../../../bridge/utils/create-async-queue.js";
import { isRecord } from "../../../bridge/utils/is-record.js";
import { checkPrivateDirectory } from "../../../bridge/utils/check-private-directory.js";
import { contains, orderSocketsForFolder, readWrapperWorkspace } from "../../../bridge/utils/ide-wrapper-workspace.js";
import type { ShowInIde } from "../../../bridge/utils/show-in-ide.js";

// The wrapper names its socket <pid>.sock (see codex-ide-wrapper-main.ts).
const SOCKET_FILE_SUFFIX = ".sock";

export interface CodexIdeAdapterOptions {
  socketDirectoryPath: string;
  // Lets the wrapper start a thread when the IDE has none open.
  newThreadParams: NewThreadParams;
  // Opens a relay thread in the Codex panel; does nothing when left out.
  showInIde?: ShowInIde;
}

// The IDE shows the turn live and asks the human for approvals.
export class CodexIdeAdapter implements AgentAdapter {
  // Threads already brought to the front, so each is opened once, not on every turn.
  private readonly shownThreadIds = new Set<string>();

  constructor(private readonly options: CodexIdeAdapterOptions) {}

  // A connection serves one turn only.
  async *run(request: AgentTurnRequest): AsyncGenerator<AgentEvent> {
    const { socket, windowFolder } = await this.connectToWrapper(request.workingDirectory);
    // Replies with a different id belong to another client and are ignored.
    const requestId = randomUUID();
    const events = createAsyncQueue<AgentEvent>();

    const sendMessage = (message: IdeClientMessage) =>
      socket.write(`${JSON.stringify(message)}\n`);
    const interruptTurn = () => sendMessage({ type: "interrupt", requestId });

    createInterface({ input: socket }).on("line", (line) => {
      const message = parseServerMessage(line);
      // Ignore invalid lines and replies for other requests. They must not fail the turn.
      if (!message || ("requestId" in message && message.requestId !== requestId)) return;
      if (message.type === "accepted") {
        this.showThread({ threadId: message.threadId, windowFolder });
      } else if (message.type === "delta") {
        events.push({ kind: "reply_delta", text: message.text });
      } else if (message.type === "error") {
        events.push({ kind: "error", text: message.message });
        events.end();
      } else if (message.type === "completed") {
        events.push(toTerminalEvent(message));
        events.end();
      }
    });
    // If the wrapper stops (VS Code closed), end with an error instead of waiting forever.
    socket.on("close", () => {
      events.push({ kind: "error", text: "Lost connection to the Codex IDE wrapper" });
      events.end();
    });

    // Handlers are set before sending, so the first reply line cannot be missed.
    request.signal.addEventListener("abort", interruptTurn, { once: true });
    try {
      sendMessage({
        type: "send",
        requestId,
        text: request.messageText,
        newThreadParams: this.threadParamsFor(request.workingDirectory),
      });
      // An already-cancelled signal never fires "abort", so check it here.
      if (request.signal.aborted) interruptTurn();
      for await (const event of events) yield event;
    } finally {
      request.signal.removeEventListener("abort", interruptTurn);
      // Closing the socket frees the wrapper's single turn slot.
      socket.destroy();
    }
  }

  // A wrapper counts only if its socket accepts a connection. Stale socket files do not.
  async readStatus(): Promise<AgentStatus> {
    let socketPaths: string[];
    try {
      socketPaths = await this.listSocketPathsNewestFirst();
    } catch (error) {
      return { mode: "ide", ideWrapperRunning: false, problem: error instanceof Error ? error.message : String(error) };
    }
    const connections = await Promise.all(
      socketPaths.map((socketPath) => connectToSocket(socketPath).catch(() => undefined)),
    );
    const liveConnections = connections.filter((socket) => socket !== undefined);
    for (const socket of liveConnections) socket.destroy();
    return { mode: "ide", ideWrapperRunning: liveConnections.length > 0 };
  }

  // A turn for another repository, such as a room's, opens its thread there instead of the IDE workspace.
  private threadParamsFor(workingDirectory: string): NewThreadParams {
    const params = this.options.newThreadParams;
    return workingDirectory === params.cwd ? params : { ...params, cwd: workingDirectory, preferIdeWorkspace: false };
  }

  // Nothing to do: each run() closes its own socket.
  close(): void {}

  // The panel may not list a thread the relay started, so open it by link the first time.
  private showThread({ threadId, windowFolder }: { threadId: string; windowFolder: string | undefined }): void {
    if (this.shownThreadIds.has(threadId)) return;
    this.shownThreadIds.add(threadId);
    void this.options.showInIde?.({ windowFolder, path: `openai.chatgpt/local/${threadId}` });
  }

  // Prefers the window that has the folder open, then the newest, which the user most likely sees.
  // `windowFolder` is that window's folder, only when it is known to contain `folder`.
  private async connectToWrapper(folder: string): Promise<{ socket: Socket; windowFolder: string | undefined }> {
    const socketPaths = await orderSocketsForFolder(await this.listSocketPathsNewestFirst(), folder);
    for (const socketPath of socketPaths) {
      try {
        const socket = await connectToSocket(socketPath);
        const workspace = await readWrapperWorkspace(socketPath);
        return { socket, windowFolder: workspace && contains(workspace, folder) ? workspace : undefined };
      } catch {
        // Stale socket from a killed wrapper. Try the next one.
      }
    }
    throw new Error(
      "No Codex IDE wrapper is running. Set chatgpt.cliExecutable to the wrapper script and reload VS Code.",
    );
  }

  // Newest first. Empty if the folder does not exist.
  private async listSocketPathsNewestFirst(): Promise<string[]> {
    // A shared folder could hold a socket planted by someone else, so refuse it.
    if ((await checkPrivateDirectory(this.options.socketDirectoryPath)) === "unsafe") {
      throw new Error(`The socket folder ${this.options.socketDirectoryPath} is not private. It must belong to you and allow no access to others.`);
    }
    let fileNames: string[];
    try {
      fileNames = await readdir(this.options.socketDirectoryPath);
    } catch {
      return [];
    }
    const entries = await Promise.all(
      fileNames
        .filter((fileName) => fileName.endsWith(SOCKET_FILE_SUFFIX))
        .map(async (fileName) => {
          const path = join(this.options.socketDirectoryPath, fileName);
          try {
            return { path, modifiedMs: (await stat(path)).mtimeMs };
          } catch {
            return undefined; // the file was removed after the folder was listed
          }
        }),
    );
    return entries
      .filter((entry) => entry !== undefined)
      .sort((first, second) => second.modifiedMs - first.modifiedMs)
      .map((entry) => entry.path);
  }
}

function connectToSocket(socketPath: string): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = connect(socketPath);
    socket.once("connect", () => resolve(socket));
    socket.once("error", reject);
  });
}

// Returns undefined unless the line is a JSON object with a string `type`. Callers check the rest.
function parseServerMessage(line: string): IdeServerMessage | undefined {
  try {
    const parsed: unknown = JSON.parse(line);
    return isRecord(parsed) && typeof parsed.type === "string"
      ? (parsed as unknown as IdeServerMessage)
      : undefined;
  } catch {
    return undefined;
  }
}

function toTerminalEvent(
  message: Extract<IdeServerMessage, { type: "completed" }>,
): AgentEvent {
  if (message.status === "interrupted") {
    return { kind: "cancelled", text: "Turn interrupted" };
  }
  if (message.status === "failed") {
    return { kind: "error", text: message.errorMessage ?? "Codex turn failed" };
  }
  return { kind: "reply_complete", text: "" };
}
