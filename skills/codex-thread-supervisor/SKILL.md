---
name: codex-thread-supervisor
description: "Use when Léo wants to relaunch the current Codex conversation every X minutes, supervise an existing Codex thread by thread_id, list active supervisions, or stop a supervision. This skill uses the local backend repo at /home/ubuntulxc/codex-thread-supervisor and the codex app-server websocket."
---

# Codex Thread Supervisor

Use this skill when Léo says things like:

- `relance cette conversation toutes les 10 minutes`
- `supervise ce thread`
- `assure-toi que le travail continue`
- `liste mes supervisions Codex`
- `arrête la supervision de cette conversation`

Backend repo:

- `/home/ubuntulxc/codex-thread-supervisor`

Main entrypoint:

- `node /home/ubuntulxc/codex-thread-supervisor/supervisor.mjs`

Default websocket:

- `ws://127.0.0.1:9234`

## Core behavior

The supervisor:

- targets one concrete `thread_id`
- only relaunches when the thread is `idle`
- posts a real `turn/start` into that thread
- can send an SMS after completion when requested
- persists local attachments in the backend repo

## Default workflow

1. For "this conversation", infer the current thread with:

```bash
rtk node /home/ubuntulxc/codex-thread-supervisor/supervisor.mjs current-thread --cwd "$PWD" --limit 3
```

2. Default to the selected top candidate unless there is a serious ambiguity.

3. Attach supervision with:

```bash
rtk node /home/ubuntulxc/codex-thread-supervisor/supervisor.mjs attach-current \
  --cwd "$PWD" \
  --transport ws \
  --ws-url ws://127.0.0.1:9234 \
  --every-minutes 10 \
  --prompt "Continue the work if there is a clear next step. If the current ticket or workstream is finished, check the relevant remaining tickets and start the most pertinent next one you can advance autonomously. If no relevant non-blocked ticket remains but there is a concrete, non-duplicate next step worth tracking, create the new GitHub ticket first, then continue on it. Otherwise give one short status update and stop."
```

4. Report back:

- inferred `thread_id`
- interval
- whether SMS is enabled
- daemon status

`attach` and `attach-current` already auto-start the daemon when needed.

## Useful commands

List attachments:

```bash
rtk node /home/ubuntulxc/codex-thread-supervisor/supervisor.mjs list
```

Detach current thread:

```bash
rtk node /home/ubuntulxc/codex-thread-supervisor/supervisor.mjs detach --thread-id <THREAD_ID>
```

If that was the last active supervision, the daemon auto-stops.

Daemon status:

```bash
rtk node /home/ubuntulxc/codex-thread-supervisor/supervisor.mjs daemon-status
```

Daemon stop:

```bash
rtk node /home/ubuntulxc/codex-thread-supervisor/supervisor.mjs daemon-stop
```

One manual tick:

```bash
rtk node /home/ubuntulxc/codex-thread-supervisor/supervisor.mjs tick
```

## Prompt guidance

Prefer a short supervision prompt that does one of these:

- continue immediately if there is an obvious next action
- otherwise produce one concise status update and stop

Good default:

`Continue the work if there is a clear next step. If the current ticket or workstream is finished, check the relevant remaining tickets and start the most pertinent next one you can advance autonomously. If no relevant non-blocked ticket remains but there is a concrete, non-duplicate next step worth tracking, create the new GitHub ticket first, then continue on it. Otherwise give one short status update and stop.`

## Notes

- Do not use `codex exec resume` for this workflow.
- Prefer `attach-current` for the current conversation.
- If the user explicitly gives a `thread_id`, use `attach` instead of `attach-current`.
- If the user asks for SMS, pass `--sms`; the backend already knows the default Free Mobile script path.
