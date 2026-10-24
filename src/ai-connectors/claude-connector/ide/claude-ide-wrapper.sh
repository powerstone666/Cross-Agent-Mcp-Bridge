#!/bin/bash
# Starts the cross-agent-mcp-bridge IDE wrapper in front of Claude. VS Code runs it via claudeCode.claudeProcessWrapper.
# VS Code passes the real claude path as the first argument. If the relay cannot run, it starts it directly.

# The relay root is four folders up from this file.
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../../.." && pwd)"
TSX="$ROOT/node_modules/.bin/tsx"

if [ -x "$TSX" ]; then
  exec "$TSX" "$HERE/claude-ide-wrapper-main.ts" "$@"
fi

exec "$@"
