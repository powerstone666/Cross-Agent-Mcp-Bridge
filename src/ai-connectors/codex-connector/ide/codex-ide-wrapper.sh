#!/bin/bash
# Starts the cross-agent-mcp-bridge IDE wrapper in front of Codex. VS Code runs it via chatgpt.cliExecutable.
# If the relay cannot run, it starts the real codex so the IDE keeps working.

# The relay root is four folders up from this file.
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../../.." && pwd)"
TSX="$ROOT/node_modules/.bin/tsx"

# exec lets the relay use VS Code's stdin and stdout directly.
if [ -x "$TSX" ]; then
  exec "$TSX" "$HERE/codex-ide-wrapper-main.ts" "$@"
fi

# Fallback when tsx is missing: run the real codex (RELAY_CODEX_BINARY, else the newest extension).
REAL="${RELAY_CODEX_BINARY:-$(ls -d "$HOME"/.vscode/extensions/openai.chatgpt-*/bin/*/codex 2>/dev/null | sort -V | tail -1)}"
exec "$REAL" "$@"
