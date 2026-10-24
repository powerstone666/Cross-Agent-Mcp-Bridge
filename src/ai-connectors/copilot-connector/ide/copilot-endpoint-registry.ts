// Finds the Agent Host endpoints that running VS Code windows publish, and checks each entry.
// Never log or return a connection token except from `readValidEndpointEntry`.
import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import { basename, isAbsolute, join } from "node:path";
import { isRecord } from "../../../bridge/utils/is-record.js";

const ENTRY_FILE_SUFFIX = ".json";
const SUPPORTED_SCHEMA_VERSION = 2;
const EDITOR_ENTRY_TYPE = "editor";

export interface EndpointEntry {
  filePath: string;
  pid: number;
  socketPath: string;
  connectionToken: string;
  modifiedMs: number;
}

// An entry without its token, safe to keep and show.
export type EndpointReference = Omit<EndpointEntry, "connectionToken">;

// The token is valid only now, so call this right before connecting and do not keep it.
export async function readValidEndpointEntry({
  filePath,
}: {
  filePath: string;
}): Promise<EndpointEntry | null> {
  let parsed: unknown;
  let modifiedMs: number;
  try {
    parsed = JSON.parse(await readFile(filePath, "utf8"));
    modifiedMs = (await stat(filePath)).mtimeMs;
  } catch {
    return null;
  }
  if (!isRecord(parsed) || !isRecord(parsed.endpoint)) return null;

  const { schemaVersion, type, pid, instanceId, connectionToken, endpoint } = parsed;
  if (schemaVersion !== SUPPORTED_SCHEMA_VERSION || type !== EDITOR_ENTRY_TYPE) return null;
  if (!Number.isInteger(pid) || (pid as number) <= 1 || !isProcessAlive(pid as number)) return null;
  if (!isNonEmptyString(instanceId) || !isNonEmptyString(connectionToken)) return null;
  const expectedFileName = `${expectedEntryName({ pid: pid as number, instanceId })}${ENTRY_FILE_SUFFIX}`;
  if (basename(filePath) !== expectedFileName) return null;
  const socketPath = endpoint.path;
  if (endpoint.type !== "socket" || !isNonEmptyString(socketPath) || !isAbsolute(socketPath)) {
    return null;
  }
  if (!(await isSocketFile(socketPath))) return null;

  return { filePath, pid: pid as number, socketPath, connectionToken, modifiedMs };
}

// Newest first. A missing folder gives an empty list.
export async function listLiveEndpoints({
  directories,
}: {
  directories: string[];
}): Promise<EndpointReference[]> {
  const filePaths = (await Promise.all(directories.map(listEntryFilePaths))).flat();
  const entries = await Promise.all(filePaths.map((filePath) => readValidEndpointEntry({ filePath })));
  return entries
    .filter((entry) => entry !== null)
    .map(({ connectionToken: _discardedToken, ...reference }) => reference)
    .sort((first, second) => second.modifiedMs - first.modifiedMs);
}

async function listEntryFilePaths(directory: string): Promise<string[]> {
  try {
    const fileNames = await readdir(directory);
    return fileNames
      .filter((fileName) => fileName.endsWith(ENTRY_FILE_SUFFIX))
      .map((fileName) => join(directory, fileName));
  } catch {
    return [];
  }
}

// The host names each file after its identity, so a copied or edited file is rejected.
function expectedEntryName({ pid, instanceId }: { pid: number; instanceId: string }): string {
  return createHash("sha256").update(`editor\0${pid}\0${instanceId}`).digest("hex");
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but belongs to another user.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function isSocketFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isSocket();
  } catch {
    return false;
  }
}
