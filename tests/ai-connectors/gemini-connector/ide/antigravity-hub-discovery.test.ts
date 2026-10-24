// Proves discovery parses `ps` lines, picks the right hub, and never leaks the csrf token.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  discoverHub,
  parseHubProcessLines,
  selectHub,
} from "../../../../src/ai-connectors/gemini-connector/ide/antigravity-hub-discovery.js";

const TOKEN = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const hubLine = ({ pid, port, folders }: { pid: number; port: number; folders: string[] }) =>
  `${pid} /Applications/Antigravity.app/agy --hub --hub-port=${port} --app_data_dir=antigravity --csrf_token=${TOKEN} ${folders.map((folder) => `--add-dir=${folder}`).join(" ")}`;

test("parses hub lines and ignores other processes", () => {
  const output = ["  1 /sbin/launchd", hubLine({ pid: 20, port: 4001, folders: ["/work/my app", "/work/b"] })].join("\n");
  const hubs = parseHubProcessLines(output);
  assert.equal(hubs.length, 1);
  assert.deepEqual(hubs[0], { pid: 20, port: 4001, csrfToken: TOKEN, folders: ["/work/my app", "/work/b"] });
});

test("picks the hub whose folder contains the target, newest pid first", () => {
  const hubs = parseHubProcessLines(
    [
      hubLine({ pid: 10, port: 1, folders: ["/work"] }),
      hubLine({ pid: 30, port: 3, folders: ["/work/app"] }),
      hubLine({ pid: 20, port: 2, folders: ["/other"] }),
    ].join("\n"),
  );
  assert.equal(selectHub({ hubs, workingDirectory: "/work/app" }).pid, 30);
  assert.equal(selectHub({ hubs, workingDirectory: "/work/app/src" }).pid, 30);
  assert.equal(selectHub({ hubs, workingDirectory: "/work/appx" }).pid, 10);
});

test("a single hub is used even when no folder matches", () => {
  const hubs = parseHubProcessLines(hubLine({ pid: 5, port: 9, folders: ["/x"] }));
  assert.equal(selectHub({ hubs, workingDirectory: "/elsewhere" }).port, 9);
});

test("no hub throws the open-Antigravity message without the token", async () => {
  await assert.rejects(
    discoverHub({ listProcesses: async () => "1 /sbin/launchd", workingDirectory: "/work" }),
    (error: Error) => error.message === "No Antigravity window is running. Open Antigravity and try again.",
  );
});

test("an unreachable hub errors without leaking the token", async () => {
  const listProcesses = async () => hubLine({ pid: 5, port: 1, folders: ["/work"] });
  await assert.rejects(discoverHub({ listProcesses, workingDirectory: "/work" }), (error: Error) => {
    assert.ok(!error.message.includes(TOKEN));
    return true;
  });
});
