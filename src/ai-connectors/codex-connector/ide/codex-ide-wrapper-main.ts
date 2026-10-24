// Entry point VS Code runs through codex-ide-wrapper.sh. Wraps only the app-server.
// Never change the traffic: keep the same arguments, environment, stdin, stdout and exit code.
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { stdin, stdout } from "node:process";
import { CodexIdeWrapperService, isAppServerInvocation } from "./codex-ide-wrapper-service.js";
import { findCodexBinary, resolveIdeSocketDirectory } from "../codex-config.js";

async function main(): Promise<void> {
  // Same lookup as the relay, so both use the same Codex.
  const realBinaryPath =
    process.env.RELAY_CODEX_BINARY ?? findCodexBinary({ homeDirectory: homedir() });
  if (!realBinaryPath) {
    throw new Error("Codex binary not found. Set RELAY_CODEX_BINARY.");
  }
  const commandArguments = process.argv.slice(2);

  // Other codex commands run directly, with the real terminal.
  if (!isAppServerInvocation({ commandArguments })) {
    const child = spawn(realBinaryPath, commandArguments, { stdio: "inherit" });
    child.on("exit", (code) => process.exit(code ?? 1));
    return;
  }

  const wrapper = new CodexIdeWrapperService({
    command: realBinaryPath,
    commandArguments,
    // Invisible to the extension, so no variables are removed.
    environment: process.env,
    // One socket per wrapper process (named by pid), so several VS Code windows do not clash.
    socketPath: join(resolveIdeSocketDirectory({ environment: process.env }), `${process.pid}.sock`),
    extensionInput: stdin,
    extensionOutput: stdout,
  });
  // start() does not throw if only the relay socket fails; traffic still passes through.
  await wrapper.start();
  const exitCode = await wrapper.waitForExit();
  // Remove the socket file so the relay does not see a stopped wrapper.
  await wrapper.stop();
  process.exit(exitCode);
}

// Last resort: prints other errors, such as a missing Codex binary, and exits with 1.
main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
