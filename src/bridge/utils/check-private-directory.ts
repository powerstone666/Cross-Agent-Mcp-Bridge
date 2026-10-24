import { stat } from "node:fs/promises";

// "private": owned by the current user and closed to everyone else. "unsafe": it exists but is not.
export type DirectoryPrivacy = "private" | "unsafe" | "missing";

const GROUP_AND_OTHER_ACCESS = 0o077;

export async function checkPrivateDirectory(path: string): Promise<DirectoryPrivacy> {
  let info;
  try {
    info = await stat(path);
  } catch {
    return "missing";
  }
  const isOwnedByUs = process.getuid === undefined || info.uid === process.getuid();
  return info.isDirectory() && isOwnedByUs && (info.mode & GROUP_AND_OTHER_ACCESS) === 0
    ? "private"
    : "unsafe";
}
