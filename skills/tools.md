# Cross-Agent-Mcp-Bridge tools

Use these MCP tools when coordinating work between agents. For room lifecycles, tasks, shared context, messages, and file coordination, see [`rooms.md`](rooms.md). Server and client installation is in the project-root [`setup.skill.md`](../setup.skill.md).

## Discover guides

Call `list_skills` to see the relay's usage guides, then `get_skill` with a name (`guide`, `tools`, `rooms`) to read one in full. Start with `guide` when unsure which tools fit the task.

## Discover agents

Call `list_agents` before assigning direct work. It returns available and unavailable agents and their names. Use an exact available name in `send_to_agent`.

Call `relay_status` to inspect each connector's live state, the relay log location, and room locations. MCP connection status and an agent connector's availability are separate: connecting a client exposes the MCP tools, while `send_to_agent` also requires the target agent's connector to be online.

## Send work directly

Use `send_to_agent` for a direct request, question, review, or bounded implementation task that does not need a shared task board. It accepts an agent name and a message:

```json
{
  "agent": "claude",
  "message": "Review src/auth/session.ts for edge cases. Return findings with file and line references; do not edit files."
}
```

Messages are queued when another relay turn is active. The relay accepts command and file approvals automatically by default and records each decision. Pass `"requireHumanApproval": true` when you want a person to review actions for that send. This option applies to approvals handled by the relay; an IDE-hosted provider may still show its own prompt.

`list_agents` marks one agent as `coordinator` and the others as `worker`, with each worker's `coordinator` name. Set `RELAY_COORDINATOR_AGENT` before starting the server to choose the coordinator; otherwise the first available agent fills that role. The same coordinator is recorded in new rooms and appears in member listings and onboarding. All agents can still exchange messages.

Make the message self-contained. Include the goal, relevant paths, constraints, dependencies, and expected result because the other agent does not receive this conversation's context. For parallel work, send separate bounded requests to suitable agents or use shared room tasks when agents need a common project plan.

Use a room when agents need to see each other's assignments, progress, messages, decisions, or knowledge. Direct replies are returned to the caller; room messages and files remain available to room members.

## Tool reference

| Tool | Use |
|---|---|
| `list_agents` | Discover the available agents and unavailable connector details. |
| `send_to_agent` | Send a direct message and receive that agent's response. |
| `relay_status` | Check relay state, agent connector state, and storage locations. |
| `list_skills` | List the usage guides served by the relay. |
| `get_skill` | Return one guide's markdown by name. |

To coordinate a group through a room, follow [`rooms.md`](rooms.md).
