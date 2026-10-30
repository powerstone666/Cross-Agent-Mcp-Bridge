# Cross-Agent-Mcp-Bridge setup

Use this guide to run one shared Cross-Agent-Mcp-Bridge MCP server and connect Codex, Claude Code, GitHub Copilot in VS Code, and Gemini CLI. The MCP tools and room workflows are documented in [`skills/tools.md`](skills/tools.md) and [`skills/rooms.md`](skills/rooms.md).

## 1. Start the shared MCP server

Open a terminal in the Cross-Agent-Mcp-Bridge project directory (the folder containing `package.json`):

```bash
npm install
npm run mcp
```

Keep this process running while agents use the relay. It serves the Streamable HTTP MCP endpoint at:

```text
http://127.0.0.1:38765/mcp
```

The live dashboard is at `http://127.0.0.1:8000`.

Start one server for the local agents. Each client connects to that HTTP endpoint; do not start one stdio server process per client. If the endpoint is already active, use that server rather than starting a duplicate.

The server working directory is where relay logs, connectors, and the dashboard are initialized. It does not decide where an agent room is created. The agent supplies an absolute repository path to `get_room_setup` and `create_room`; room files are written in that repository.

## 2. Add the MCP endpoint to each client

Add one `cross-agent-mcp-bridge` entry to each client's user-level MCP settings. Preserve other servers and settings already in each file. If `cross-agent-mcp-bridge` already exists, update that entry's URL rather than adding a duplicate.

### Codex

File: `~/.codex/config.toml`

```toml
[mcp_servers.cross-agent-mcp-bridge]
url = "http://127.0.0.1:38765/mcp"
```

### Claude Code

User-level MCP settings are stored in `~/.claude.json`. Merge this object into the top level:

```json
{
  "mcpServers": {
    "cross-agent-mcp-bridge": {
      "type": "http",
      "url": "http://127.0.0.1:38765/mcp"
    }
  }
}
```

If `mcpServers` already exists, add only the `cross-agent-mcp-bridge` property inside it.

### GitHub Copilot in VS Code

Use the user-level MCP file, not a repository's `.vscode/mcp.json`:

- macOS: `~/Library/Application Support/Code/User/mcp.json`
- Linux: `~/.config/Code/User/mcp.json`
- Windows: `%APPDATA%\Code\User\mcp.json`

Merge this property into the existing top-level `servers` object:

```json
{
  "servers": {
    "cross-agent-mcp-bridge": {
      "type": "http",
      "url": "http://127.0.0.1:38765/mcp"
    }
  }
}
```

### Gemini CLI

File: `~/.gemini/settings.json`

```json
{
  "mcpServers": {
    "cross-agent-mcp-bridge": {
      "httpUrl": "http://127.0.0.1:38765/mcp"
    }
  }
}
```

If this file or the `mcpServers` object already exists, merge the server entry without replacing other settings.

## 3. Reload clients and verify the connection

Restart or reload each client after updating its user settings. Approve or trust the server if the client asks. In Codex, run `codex mcp list` to confirm `cross-agent-mcp-bridge` appears. In the other clients, confirm their MCP tool list includes `send_to_agent`, `list_agents`, `relay_status`, and the room tools.

Call `relay_status` to inspect the relay and connector states. A client being connected to the MCP server means its MCP tools are available; an agent being available to receive `send_to_agent` requests depends on that agent's own connector being online.

## 4. Configure VS Code agent adapters

MCP entries make room and relay tools available to a client. VS Code adapter settings provide IDE fallback routes when a CLI connector is unavailable. Preview the adapter changes from the project root:

```bash
npx tsx configure-vscode-settings.ts
```

If the preview is correct, apply it:

```bash
npx tsx configure-vscode-settings.ts --apply
```

The script adds only settings declared by the available agent connectors, preserves other VS Code settings, and saves a backup before writing. Restart VS Code after applying. To configure one adapter, use `--agent codex`, `--agent claude`, `--agent copilot`, or `--agent gemini` with `--apply`.

### Connector-specific setup and status

The direct `send_to_agent` tool needs the destination connector to be available. Use `list_agents` to see which adapters loaded and `relay_status` to inspect their live state.

| Agent | VS Code setup | Status and notes |
|---|---|---|
| Codex | The script sets `chatgpt.cliExecutable` to the relay wrapper. Install the Codex VS Code extension. Fully quit and reopen VS Code after applying; Reload Window may leave the existing Codex server running. | MCP prefers the Codex CLI when its binary is available, then falls back to the IDE wrapper. Optional overrides: `RELAY_CODEX_MODE`, `RELAY_CODEX_BINARY`, `RELAY_CODEX_IDE_SOCKET_DIRECTORY`. |
| Claude Code | The script sets `claudeCode.claudeProcessWrapper` for direct IDE/terminal relay use. Install the Claude CLI for relay-handled approvals; the VS Code Agent Host Claude provider is the fallback. | MCP prefers the Claude CLI when available. Optional overrides: `RELAY_CLAUDE_MODE`, `RELAY_CLAUDE_BINARY`, `RELAY_CLAUDE_IDE_SOCKET_DIRECTORY`. |
| GitHub Copilot | No VS Code setting is added. Keep VS Code open with the Agent Host available. | `relay_status` reports `hostRunning`. If multiple VS Code windows are active, set `RELAY_COPILOT_SESSION_ID` to choose the session. `RELAY_COPILOT_ENDPOINT_DIRECTORY` can override where the relay discovers VS Code's host. MCP creates a Copilot session in the requested workspace when none exists. |
| Gemini | No VS Code setting is added. Install and sign in to Gemini CLI, or keep an Antigravity window open; both routes answer approvals through the relay. | MCP prefers Gemini CLI when available. Optional overrides: `RELAY_GEMINI_BINARY`, `RELAY_GEMINI_ACP_FLAG`, `RELAY_GEMINI_IDE_TIMEOUT_MS`. |

The relay queues messages and accepts its own action approval requests automatically. Set `requireHumanApproval: true` on `send_to_agent` when you want dashboard review, or prefix a terminal message with `/review `. MCP prefers CLI connectors for Codex, Claude, and Gemini so the relay can handle approvals. Copilot and IDE fallbacks may still show provider-controlled prompts that the relay cannot answer. Set `RELAY_COORDINATOR_AGENT` to choose the room coordinator; the first available agent is the default.

## 5. Create or join a room in the agent's repository

Rooms are created only when an agent calls the room tools; starting the MCP server does not create a room. From the target project, provide its absolute path:

1. Call `get_room_setup` with `{ "targetRepositoryPath": "/absolute/path/to/project" }`.
2. Join an appropriate existing room if one is listed. If there is no room, call `create_room` with a room name and the same `targetRepositoryPath`.
3. Call `join_room` using the returned room ID, then `get_room_onboarding` to read the room instructions, shared knowledge, decisions, and assigned tasks.

Room files live under:

```text
<targetRepositoryPath>/.agent-room/rooms/<room-name>/
```

See `skills/rooms.md` for room, task, knowledge, decision, message, event, file-claim, and worktree workflows. See `skills/tools.md` for direct agent messaging.
