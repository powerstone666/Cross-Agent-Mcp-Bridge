// Brings an agent's new conversation to the front in VS Code, so the human can watch it.
// Never throws: showing the chat is a convenience, and a failure must not fail the turn.
import { execFile } from "node:child_process";

const COMMAND_TIMEOUT_MS = 10_000;
// Lets the window come to the front before the link arrives; links go to the focused window.
const FOCUS_SETTLE_MS = 500;

// `windowFolder` must be a folder some VS Code window already has open: `code <folder>` focuses
// that window, but would open a new one for any other folder.
export type ShowInIde = (input: { windowFolder: string | undefined; path: string }) => Promise<void>;

export function createShowInIde(environment: NodeJS.ProcessEnv, platform = process.platform): ShowInIde {
  if (environment.RELAY_SHOW_IN_IDE === "0") return async () => {};
  const scheme = environment.RELAY_IDE_URI_SCHEME || "vscode";
  const editorCommand = environment.RELAY_IDE_CLI || "code";
  return async ({ windowFolder, path }) => {
    if (windowFolder) {
      await run(editorCommand, [windowFolder]);
      await new Promise((resolve) => setTimeout(resolve, FOCUS_SETTLE_MS));
    }
    const link = `${scheme}://${path}`;
    if (platform === "darwin") await run("open", [link]);
    else if (platform === "win32") await run("cmd", ["/c", "start", "", link]);
    else await run("xdg-open", [link]);
  };
}

function run(command: string, args: string[]): Promise<void> {
  return new Promise((resolve) => {
    execFile(command, args, { timeout: COMMAND_TIMEOUT_MS }, () => resolve());
  });
}
