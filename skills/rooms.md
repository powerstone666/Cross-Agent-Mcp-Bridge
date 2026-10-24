# Rooms and shared project work

Use rooms when two or more agents need shared project context, task assignments, status, messages, knowledge, or decisions. A room is stored inside the repository chosen by the agent, even when the MCP server runs from another directory.

## Start or join a room

1. Get the target repository's absolute path from the current workspace. Call `get_room_setup` with `{ "targetRepositoryPath": "/absolute/path/to/repo" }`.
2. If the tool lists a suitable existing room, use its exact `roomId`. If there is no suitable room, call `create_room` with a name and the same repository path. Pass `participantId` to join the creator immediately.
3. Call `join_room` with the returned room ID if `create_room` did not join the participant.
4. Call `get_room_onboarding` to read `ROOM.md`, shared knowledge and decisions, and tasks assigned to the participant. Read `list_room_tasks` for the full task list.

The server does not create a room on startup. Room files are created only by an explicit room tool call and live at:

```text
<targetRepositoryPath>/.agent-room/rooms/<room-name>/
```

Each new room records its coordinator in `ROOM.md`: the creator named by `create_room`'s `participantId`, or the relay's coordinator when no participant is supplied. The creator is joined in the current MCP session when `participantId` is supplied. Other agents appear as workers in `list_room_members` and `get_room_onboarding`; assign their work with `create_task` or `assign_task`, or pass `task` to `invite_to_room` to create an assigned task before waking them. `RELAY_COORDINATOR_AGENT` selects the relay coordinator at server startup.

Pass the exact repository-scoped `roomId` returned by the setup or create tool to subsequent room calls. Different repositories can each have a room named `backend`; their scoped IDs distinguish their data. `get_room_setup`, `list_rooms`, and `create_room` require the repository path; other room calls use the returned ID.

## Room tool reference

| Tool | Use |
|---|---|
| `get_room_setup` | Inspect rooms in a repository and return the suggested room directory if none exist. |
| `create_room` | Initialize the room files; optional `participantId` joins the creator and records them as coordinator. Returns `joined`. |
| `list_rooms` | List existing rooms in the supplied repository. |
| `join_room` / `leave_room` | Record participant membership for the current MCP session. |
| `list_room_members` | See joined, left, and interrupted sessions. |
| `get_room_onboarding` | Load room instructions, knowledge, decisions, and the participant's assigned tasks. |
| `get_room_context` | Read room metadata, task index, and recent messages. |
| `list_room_tasks` | Read task files and their current statuses. |
| `create_task` | Add a task with an optional assignee and repository-relative file list. |
| `assign_task` | Assign an existing task to a participant. |
| `update_task` | Add a progress note to a task. |
| `set_task_status` | Set a task to `open`, `in_progress`, `review`, or `done`. |
| `invite_to_room` | Post an invitation and wake another agent; optional `task` creates an assigned task first and returns its `taskId`. Room messages alone never wake an agent. |
| `list_invitable_agents` | Check which connected agents are in the room, interrupted, disconnected, or available to invite. |
| `send_room_message` | Share a concise update or handoff with room members. |
| `publish_knowledge` / `search_knowledge` | Save reusable project context and search it later. |
| `publish_decision` / `list_room_decisions` | Record and retrieve settled implementation or architecture choices. |

## Plan and hand off work

- Break the request into tasks with clear owners, file paths, and expected outcomes. Assign independent tasks to different available agents.
- Set a task to `in_progress` when work begins, `review` when it is ready for review, and `done` when it is complete. Add progress or handoff notes with `update_task` and `send_room_message`.
- Use `assign_task` to change ownership. Call `get_room_onboarding` again when an agent joins or needs refreshed context.
- Publish reusable discoveries with `publish_knowledge`. Record decisions with `publish_decision` so later agents can find why a choice was made.
- Join before starting shared room work. Read the room instructions and assigned tasks before implementation.

## Events and shared files

The MCP server exposes the `cross-agent-mcp-bridge://rooms/events` resource. Subscribe to it for concise event notifications such as task changes, new messages, knowledge updates, decisions, and participant joins or departures. Read the relevant room tool or file when a summary indicates new information; events are summaries, not copies of full documents.

For file coordination:

| Tool | Use |
|---|---|
| `claim_task_file` | Record that a participant is handling a task-listed repository-relative file. |
| `list_task_file_claims` | Inspect active claims, optionally filtered by room. |
| `release_task_file` | Release a participant's claim when work is handed off or finished. |
| `create_task_worktree` | Create a Git worktree for an isolated task branch. |
| `list_task_worktrees` | List the relay's task worktrees. |
| `remove_task_worktree` | Remove a worktree when the task no longer needs it; Git preserves dirty worktrees by refusing removal. |

Claims are shared coordination records; they do not lock a file against editors outside the relay. File-claim and worktree tools currently use the relay's configured target repository. For rooms stored in a different repository, continue to coordinate through room tasks and messages; use these file tools only when the configured repository matches the room.

## Practical rules

- Use the same `targetRepositoryPath` for setup and creation. Do not create a duplicate room when a suitable one already exists.
- Use the exact room, task, and participant IDs returned by MCP calls.
- Keep file paths in task file lists and claims relative to the target repository.
- Keep room messages actionable. Put durable findings in knowledge and settled choices in decisions.
- Use a Git worktree when concurrent implementation needs isolated checkouts; communicate its returned path to the task owner.
- When a session restarts, inspect `list_room_members` and task states. Membership can show interrupted sessions; task files retain their persisted status.

## Example

```text
get_room_setup({"targetRepositoryPath":"/Users/me/projects/my-app"})
create_room({"name":"backend","targetRepositoryPath":"/Users/me/projects/my-app"})
join_room({"roomId":"<roomId returned by create_room>"})
get_room_onboarding({"roomId":"<same roomId>"})
create_task({"roomId":"<same roomId>","task":"Implement session refresh","assignedTo":"claude","files":["src/auth/session.ts"]})
```

Use actual paths and IDs from tool results; placeholders are explanatory only.
