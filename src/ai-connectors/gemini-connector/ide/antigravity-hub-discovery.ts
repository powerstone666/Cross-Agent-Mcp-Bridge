// Finds running Antigravity hubs from `ps` output and picks the one for a folder.
// The csrf token stays inside HubEndpoint. Never log it or put it in a message.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { HUB_HEALTH_PATH, HUB_HOST, NO_HUB_MESSAGE } from "./antigravity-config.js";

const execFileAsync = promisify(execFile);

export interface HubEndpoint {
  pid: number;
  port: number;
  csrfToken: string;
  folders: string[];
}

export type ListProcesses = () => Promise<string>;

export const listProcesses: ListProcesses = async () => {
  const { stdout } = await execFileAsync("ps", ["-eo", "pid,args"], { maxBuffer: 16 * 1024 * 1024 });
  return stdout;
};

const PROCESS_LINE = /^\s*(\d+)\s+(.*)$/;
const PORT_FLAG = /(?:^|\s)--hub-port=(\d+)/;
const TOKEN_FLAG = /(?:^|\s)--csrf_token=([\w-]+)/;
const FOLDER_FLAG = /(?:^|\s)--add-dir=(.*?)(?=\s--|$)/g;

export function parseHubProcessLines(output: string): HubEndpoint[] {
  const hubs: HubEndpoint[] = [];
  for (const line of output.split("\n")) {
    const processMatch = PROCESS_LINE.exec(line);
    if (!processMatch) continue;
    const pid = processMatch[1] ?? "";
    const args = processMatch[2] ?? "";
    if (!/(?:^|\s)--hub(?:\s|$)/.test(args)) continue;
    const port = PORT_FLAG.exec(args)?.[1];
    const csrfToken = TOKEN_FLAG.exec(args)?.[1];
    if (!port || !csrfToken) continue;
    const folders = [...args.matchAll(FOLDER_FLAG)].map((match) => (match[1] ?? "").trim());
    hubs.push({ pid: Number(pid), port: Number(port), csrfToken, folders });
  }
  return hubs;
}

function coversFolder({ hubFolder, targetFolder }: { hubFolder: string; targetFolder: string }) {
  const base = hubFolder.replace(/\/+$/, "");
  return targetFolder === base || targetFolder.startsWith(`${base}/`);
}

export function selectHub({
  hubs,
  workingDirectory,
}: {
  hubs: HubEndpoint[];
  workingDirectory: string;
}): HubEndpoint {
  if (hubs.length === 0) throw new Error(NO_HUB_MESSAGE);
  const matching = hubs.filter((hub) =>
    hub.folders.some((hubFolder) => coversFolder({ hubFolder, targetFolder: workingDirectory })),
  );
  const candidates = matching.length > 0 ? matching : hubs.length === 1 ? hubs : [];
  if (candidates.length === 0) {
    throw new Error("No Antigravity window has this folder open. Open the folder in Antigravity.");
  }
  return candidates.reduce((newest, hub) => (hub.pid > newest.pid ? hub : newest));
}

export async function isHubHealthy(hub: HubEndpoint): Promise<boolean> {
  try {
    const response = await fetch(`http://${HUB_HOST}:${hub.port}${HUB_HEALTH_PATH}`, {
      signal: AbortSignal.timeout(2000),
    });
    return response.status === 200;
  } catch {
    return false;
  }
}

export async function discoverHub({
  listProcesses: list,
  workingDirectory,
}: {
  listProcesses: ListProcesses;
  workingDirectory: string;
}): Promise<HubEndpoint> {
  const hub = selectHub({ hubs: parseHubProcessLines(await list()), workingDirectory });
  if (!(await isHubHealthy(hub))) {
    throw new Error("The Antigravity window did not answer. Restart Antigravity and try again.");
  }
  return hub;
}
