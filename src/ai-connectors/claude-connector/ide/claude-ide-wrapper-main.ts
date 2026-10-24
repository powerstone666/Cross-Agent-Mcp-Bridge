// Entry point VS Code runs through claude-ide-wrapper.sh: `<real-claude> <extension args...>`.
// Never change the traffic: keep the same arguments, environment, stdin, stdout and exit code.
import { spawn } from "node:child_process";
import { join } from "node:path";
import { stdin, stdout } from "node:process";
import { resolveClaudeIdeSocketDirectory } from "../claude-config.js";
import { ClaudeIdeWrapperService, isStreamJsonInvocation } from "./claude-ide-wrapper-service.js";

async function main(): Promise<void> {
  const [realBinaryPath, ...commandArguments] = process.argv.slice(2);
  if (!realBinaryPath) throw new Error("Usage: claude-ide-wrapper-main <real-claude-path> [args...]");

  if (!isStreamJsonInvocation({ commandArguments })) {
    const child = spawn(realBinaryPath, commandArguments, { stdio: "inherit" });
    child.on("exit", (code) => process.exit(code ?? 1));
    return;
  }

  const wrapper = new ClaudeIdeWrapperService({
    command: realBinaryPath,
    commandArguments,
    environment: process.env,
    // One socket per wrapper process, so several VS Code windows do not clash.
    socketPath: join(resolveClaudeIdeSocketDirectory({ environment: process.env }), `${process.pid}.sock`),
    extensionInput: stdin,
    extensionOutput: stdout,
  });
  await wrapper.start();
  const exitCode = await wrapper.waitForExit();
  await wrapper.stop();
  process.exit(exitCode);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
