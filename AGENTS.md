# AGENTS.md

## Project

`codex-thread-supervisor` is a small local supervisor for Codex threads.

Its goal is simple:

- target one existing Codex `thread_id`
- wait until the thread is `idle`
- inject a real `turn/start`
- wait for completion
- optionally send an SMS summary
- keep local state and logs

## Principles

- Keep the implementation local, inspectable, and minimal.
- Do not depend on `codex exec resume`.
- Prefer the real `codex app-server` path.
- Treat "visible in the Codex conversation" as the success criterion, not just "JSON-RPC responded".
- Fail clearly when the target thread is not `idle`.

## Main Files

- `supervisor.mjs`: main CLI and daemon logic
- `README.md`: operator-facing usage
- `EXPERIMENTS.md`: proof runs and observed limitations
- `skills/codex-thread-supervisor/`: installable skill payload for other Codex conversations

## Runtime Model

- Attachments are stored in `state/attachments.json`
- The background daemon PID is stored in `run/daemon.pid`
- Logs go to `logs/`

These paths are intentionally ignored by git.

## Expected Commands

Common commands:

- `node supervisor.mjs current-thread`
- `node supervisor.mjs attach-current`
- `node supervisor.mjs attach`
- `node supervisor.mjs list`
- `node supervisor.mjs detach`
- `node supervisor.mjs tick`
- `node supervisor.mjs daemon-start`
- `node supervisor.mjs daemon-status`
- `node supervisor.mjs daemon-stop`

## UX Contract

- `attach` / `attach-current` must auto-start the daemon if needed
- `detach` must auto-stop the daemon if there are no remaining attachments
- The default supervision prompt should stay short and conservative
- If there is no clear next step, the supervised turn should produce one short status update and stop

## Safety Rules

- Do not silently supervise the wrong thread
- Prefer `attach-current` only when the inferred current thread is clear
- Do not force a new turn onto a busy thread
- Do not hardcode secrets in git
- Keep SMS optional

## Documentation Rules

When behavior changes materially, update:

- `README.md` for usage and operator expectations
- `EXPERIMENTS.md` for anything that materially changes feasibility claims
- this `AGENTS.md` when conventions or project rules change

## Publishing

Canonical GitHub repo:

- `git@github.com:leolanzarotti/codex-thread-supervisor.git`

When the installable skill changes, keep `skills/codex-thread-supervisor/` in sync with the runtime behavior so installation from GitHub stays correct.
