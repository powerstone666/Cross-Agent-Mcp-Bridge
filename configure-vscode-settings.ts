// Adds the VS Code user settings that route each agent's IDE through the relay.
// Dry run by default; pass --apply to write. Backs up an existing file first.
// Never replaces a different existing value: exits with code 2 for a person to review.
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { AGENT_MODULES } from "./src/agent-modules.js";
import { planVscodeSettingsChange } from "./src/vscode-setup/plan-vscode-settings-change.js";

const relayRootPath = resolve(dirname(fileURLToPath(import.meta.url)));

const commandArguments = process.argv.slice(2);
const isApply = commandArguments.includes("--apply");
const settingsPath = readFlagValue("--settings") ?? defaultSettingsPath();
const onlyAgentName = readFlagValue("--agent");

const modules = AGENT_MODULES.filter(
  (module) => onlyAgentName === undefined || module.agentName === onlyAgentName,
);
if (modules.length === 0) {
  const known = AGENT_MODULES.map((module) => module.agentName).join(", ");
  console.log(`Unknown agent "${onlyAgentName}". Known agents: ${known}.`);
  process.exit(2);
}

// Keep the original text so nothing is written when nothing changed.
const originalText = existsSync(settingsPath) ? readFileSync(settingsPath, "utf8") : "";
let currentText = originalText;
let needsManualAttention = false;

for (const module of modules) {
  const setting = module.describeVscodeSetting({ relayRootPath });
  if (!setting) {
    console.log(`@${module.agentName}: no VS Code setting needed.`);
    continue;
  }

  const plan = planVscodeSettingsChange({
    settingsText: currentText,
    settingKey: setting.key,
    settingValue: setting.value,
  });
  if (plan.outcome === "already-set") {
    console.log(`@${module.agentName}: already set (${setting.key}). Nothing to do.`);
  } else if (plan.outcome === "conflict") {
    console.log(`@${module.agentName}: NOT changed. ${setting.key} is already ${plan.existingValue}. Ask the user before replacing it.`);
    needsManualAttention = true;
  } else if (plan.outcome === "manual-edit-needed") {
    console.log(`@${module.agentName}: NOT changed (${plan.reason}). Ask the user to add this line to ${settingsPath}:`);
    console.log(`    "${setting.key}": ${JSON.stringify(setting.value)}`);
    needsManualAttention = true;
  } else {
    console.log(`@${module.agentName}: ${isApply ? "adding" : "would add"} "${setting.key}": ${JSON.stringify(setting.value)}`);
    currentText = plan.newText;
  }
}

// A dry run stops here.
if (currentText !== originalText) {
  if (!isApply) {
    console.log(`Dry run: nothing written. Run again with --apply to update ${settingsPath} (a backup is saved first).`);
  } else {
    mkdirSync(dirname(settingsPath), { recursive: true });
    if (existsSync(settingsPath)) {
      // The timestamp keeps repeated runs from overwriting earlier backups.
      const backupPath = `${settingsPath}.cross-agent-mcp-bridge-backup-${Date.now()}`;
      copyFileSync(settingsPath, backupPath);
      console.log(`Backup saved: ${backupPath}`);
    }
    writeFileSync(settingsPath, currentText);
    console.log(`Updated ${settingsPath}. Next: quit and reopen VS Code so the new setting takes effect.`);
  }
}
if (needsManualAttention) process.exitCode = 2;

function readFlagValue(flag: string): string | undefined {
  const index = commandArguments.indexOf(flag);
  return index === -1 ? undefined : commandArguments[index + 1];
}

function defaultSettingsPath(): string {
  if (process.platform === "darwin") {
    return join(homedir(), "Library", "Application Support", "Code", "User", "settings.json");
  }
  if (process.platform === "win32") {
    return join(process.env.APPDATA ?? homedir(), "Code", "User", "settings.json");
  }
  return join(homedir(), ".config", "Code", "User", "settings.json");
}
