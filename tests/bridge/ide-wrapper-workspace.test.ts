// Proves the relay picks the IDE wrapper whose window has the turn's folder open.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { orderSocketsForFolder, removeWrapperWorkspace, writeWrapperWorkspace } from "../../src/bridge/utils/ide-wrapper-workspace.js";

test("orders wrappers: the folder's window, then unknown windows, other windows only as a last resort", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cross-agent-mcp-bridge-wrappers-"));
  try {
    const [relay, room, unknown] = ["1.sock", "2.sock", "3.sock"].map((name) => join(directory, name)) as [string, string, string];
    await writeWrapperWorkspace(relay, "/work/relay");
    await writeWrapperWorkspace(room, "/work/room/");
    assert.deepEqual(await orderSocketsForFolder([relay, unknown, room], "/work/room"), [room, unknown]);
    assert.deepEqual(await orderSocketsForFolder([relay, room], "/work/room/packages/api"), [room]);
    assert.deepEqual(await orderSocketsForFolder([relay, room], "/work/roomier"), [relay, room]);
    await removeWrapperWorkspace(room);
    assert.deepEqual(await orderSocketsForFolder([relay, room], "/work/room"), [room]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
