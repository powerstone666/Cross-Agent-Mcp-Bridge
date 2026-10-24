// The init entrypoint reuses setup's dry-run default and only writes with --apply.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

const relayRootPath = resolve(import.meta.dirname, "..");
const tsxCliPath = resolve(relayRootPath, "node_modules/tsx/dist/cli.mjs");
const mainPath = resolve(relayRootPath, "src/main.ts");

test("init previews settings changes and requires --apply to write", () => {
  const temporaryDirectory = mkdtempSync(join(tmpdir(), "relay-init-"));
  const settingsPath = join(temporaryDirectory, "settings.json");
  const originalSettings = '{\n    "editor.fontSize": 14\n}\n';
  writeFileSync(settingsPath, originalSettings);

  try {
    const preview = spawnSync(
      process.execPath,
      [tsxCliPath, mainPath, "init", "--settings", settingsPath],
      { cwd: temporaryDirectory, encoding: "utf8" },
    );
    assert.equal(preview.status, 0, preview.stderr);
    assert.match(preview.stdout, /Dry run: nothing written/);
    assert.equal(readFileSync(settingsPath, "utf8"), originalSettings);

    const apply = spawnSync(
      process.execPath,
      [tsxCliPath, mainPath, "init", "--settings", settingsPath, "--apply"],
      { cwd: temporaryDirectory, encoding: "utf8" },
    );
    assert.equal(apply.status, 0, apply.stderr);
    const updatedSettings = JSON.parse(readFileSync(settingsPath, "utf8")) as Record<string, unknown>;
    assert.equal(updatedSettings["editor.fontSize"], 14);
    assert.ok(Object.keys(updatedSettings).some((key) => key.endsWith(".cliExecutable")));
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});
