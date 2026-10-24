// Proves a folder counts as private only when it is ours and closed to everyone else.
import assert from "node:assert/strict";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { checkPrivateDirectory } from "../../src/bridge/utils/check-private-directory.js";

test("tells private, open and missing folders apart", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cross-agent-mcp-bridge-priv-"));
  try {
    await chmod(directory, 0o700);
    assert.equal(await checkPrivateDirectory(directory), "private");
    await chmod(directory, 0o750);
    assert.equal(await checkPrivateDirectory(directory), "unsafe");
    assert.equal(await checkPrivateDirectory(join(directory, "nope")), "missing");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
