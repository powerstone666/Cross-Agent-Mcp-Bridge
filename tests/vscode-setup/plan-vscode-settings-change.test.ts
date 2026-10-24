// Proves the planner edits settings.json safely: valid JSON, comments kept, idempotent,
// and a different existing value is never overwritten (it asks for a manual edit).
import assert from "node:assert/strict";
import { test } from "node:test";
import { planVscodeSettingsChange } from "../../src/vscode-setup/plan-vscode-settings-change.js";

const SETTING_KEY = "example.cliExecutable";
const SETTING_VALUE = "/path/to/example-wrapper.sh";

function plan(settingsText: string) {
  return planVscodeSettingsChange({ settingsText, settingKey: SETTING_KEY, settingValue: SETTING_VALUE });
}

function addedText(settingsText: string): string {
  const result = plan(settingsText);
  assert.equal(result.outcome, "add");
  return result.outcome === "add" ? result.newText : "";
}

test("adds the setting after the last entry and keeps JSON valid", () => {
  const newText = addedText('{\n    "editor.fontSize": 14\n}\n');
  assert.deepEqual(JSON.parse(newText), {
    "editor.fontSize": 14,
    [SETTING_KEY]: SETTING_VALUE,
  });
});

test("handles a trailing comma, an empty object and an empty file", () => {
  assert.equal(JSON.parse(addedText('{\n    "a": 1,\n}')).a, 1);
  assert.equal(JSON.parse(addedText("{}"))[SETTING_KEY], SETTING_VALUE);
  assert.equal(JSON.parse(addedText(""))[SETTING_KEY], SETTING_VALUE);
});

// settings.json allows comments, so the planner edits the text instead of re-writing parsed JSON.
test("keeps comments elsewhere in the file", () => {
  const newText = addedText('{\n    // my theme\n    "workbench.colorTheme": "x"\n}');
  assert.match(newText, /\/\/ my theme/);
});

test("is idempotent and never overwrites a different value", () => {
  assert.deepEqual(plan(`{ "${SETTING_KEY}": ${JSON.stringify(SETTING_VALUE)} }`), { outcome: "already-set" });
  assert.deepEqual(plan(`{ "${SETTING_KEY}": "/other/wrapper" }`), {
    outcome: "conflict",
    existingValue: "/other/wrapper",
  });
});

test("asks for a manual edit when the last entry ends with a comment", () => {
  assert.equal(plan('{\n    "a": 1 // note\n}').outcome, "manual-edit-needed");
  assert.equal(plan("not json at all").outcome, "manual-edit-needed");
});
