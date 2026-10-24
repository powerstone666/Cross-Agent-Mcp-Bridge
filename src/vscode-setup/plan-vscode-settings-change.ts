// Plans adding one key to a VS Code settings.json. Pure: works on text, no file access.
// Never overwrite a different existing value, and never touch other keys.

// VS Code's default indent for settings.json.
const INDENT = "    ";

// Only "add" carries new text. On "conflict" or "manual-edit-needed", the caller must
// stop and ask the human.
export type SettingsChangePlan =
  | { outcome: "add"; newText: string }
  | { outcome: "already-set" }
  | { outcome: "conflict"; existingValue: string }
  | { outcome: "manual-edit-needed"; reason: string };

interface PlanVscodeSettingsChangeInput {
  settingsText: string;
  settingKey: string;
  settingValue: string;
}

// shortcut: the file is JSONC (JSON with comments) and is not parsed, only regex and string
// edits, so it returns "manual-edit-needed" when unsure and a key inside a comment still
// matches, upgrade to a JSONC parser if that bites.
export function planVscodeSettingsChange({
  settingsText,
  settingKey,
  settingValue,
}: PlanVscodeSettingsChangeInput): SettingsChangePlan {
  // The value allows escapes. `JSON.parse` decodes them, so the comparison is fair.
  const existingMatch = new RegExp(
    `"${escapeRegExp(settingKey)}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`,
  ).exec(settingsText);
  if (existingMatch) {
    const existingValue = JSON.parse(`"${existingMatch[1]}"`) as string;
    return existingValue === settingValue
      ? { outcome: "already-set" }
      : { outcome: "conflict", existingValue };
  }

  const settingLine = `${INDENT}"${settingKey}": ${JSON.stringify(settingValue)}`;
  if (settingsText.trim() === "") {
    return { outcome: "add", newText: `{\n${settingLine}\n}\n` };
  }

  // Assumes the last "}" closes the top-level object, true for normal settings files.
  const closingBraceIndex = settingsText.lastIndexOf("}");
  if (closingBraceIndex === -1) {
    return { outcome: "manual-edit-needed", reason: "no closing brace found" };
  }

  const beforeBrace = settingsText.slice(0, closingBraceIndex).trimEnd();
  // A trailing comment would hide the comma we add, so a human must edit. Last line only.
  const lastLine = beforeBrace.slice(beforeBrace.lastIndexOf("\n") + 1);
  if (lastLine.includes("//") || lastLine.includes("*/")) {
    return {
      outcome: "manual-edit-needed",
      reason: "the last entry ends with a comment",
    };
  }

  // JSONC allows a trailing comma, so add one only when missing.
  const lastCharacter = beforeBrace.at(-1);
  const separator = lastCharacter === "{" || lastCharacter === "," ? "" : ",";
  const afterBrace = settingsText.slice(closingBraceIndex);
  return {
    outcome: "add",
    newText: `${beforeBrace}${separator}\n${settingLine}\n${afterBrace}`,
  };
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
