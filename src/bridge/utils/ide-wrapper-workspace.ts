// IDE wrappers note their VS Code window's workspace folder next to their socket, so the relay can
// send a turn to the window that has the turn's repository open.
import { readFile, rm, writeFile } from "node:fs/promises";

const SOCKET_SUFFIX = ".sock";
const WORKSPACE_SUFFIX = ".workspace.json";

function workspaceFilePath(socketPath: string): string {
  return `${socketPath.endsWith(SOCKET_SUFFIX) ? socketPath.slice(0, -SOCKET_SUFFIX.length) : socketPath}${WORKSPACE_SUFFIX}`;
}

// Never throws: a missing note only means the relay falls back to the newest wrapper.
export async function writeWrapperWorkspace(socketPath: string, workspaceFolder: string): Promise<void> {
  try {
    await writeFile(workspaceFilePath(socketPath), `${JSON.stringify({ workspaceFolder })}\n`, { mode: 0o600 });
  } catch {
    // The IDE must keep working without it.
  }
}

export async function removeWrapperWorkspace(socketPath: string): Promise<void> {
  await rm(workspaceFilePath(socketPath), { force: true });
}

export async function readWrapperWorkspace(socketPath: string): Promise<string | undefined> {
  try {
    const parsed: unknown = JSON.parse(await readFile(workspaceFilePath(socketPath), "utf8"));
    const folder = (parsed as { workspaceFolder?: unknown } | null)?.workspaceFolder;
    return typeof folder === "string" && folder !== "" ? folder : undefined;
  } catch {
    return undefined;
  }
}

export function contains(workspaceFolder: string, targetFolder: string): boolean {
  const base = workspaceFolder.replace(/\/+$/, "");
  return targetFolder === base || targetFolder.startsWith(`${base}/`);
}

// Keeps the given order within each group: windows with the target open, then windows that did not
// say which folder they have (wrappers started before this note existed). Other windows only when
// nothing else is left, so the relay still reaches some IDE.
export async function orderSocketsForFolder(socketPaths: string[], targetFolder: string): Promise<string[]> {
  const folders = await Promise.all(socketPaths.map(readWrapperWorkspace));
  const matching = socketPaths.filter((_, index) => folders[index] !== undefined && contains(folders[index]!, targetFolder));
  const unknown = socketPaths.filter((_, index) => folders[index] === undefined);
  const preferred = [...matching, ...unknown];
  return preferred.length > 0 ? preferred : socketPaths;
}
