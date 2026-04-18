# Experiments

Runs executed on `2026-04-18`.

## Proven working paths

### 1. Existing thread via spawned `stdio` app-server

- target thread: `019d9f9d-e340-7410-b1c3-073c39cdfb5d`
- outcome: new turn added to the existing thread
- proof:
  - before turns: `3`
  - after turns: `4`
  - new assistant message: `Ce fil a bien recu un tour supervise.`
- logs:
  - `/home/ubuntulxc/codex-thread-supervisor/logs/2026-04-18T13-22-28-428Z-d9c2d6.events.jsonl`
  - `/home/ubuntulxc/codex-thread-supervisor/logs/heartbeats.jsonl`

### 2. Existing thread via WebSocket app-server

- websocket: `ws://127.0.0.1:9234`
- `initialize.userAgent`: `Codex Desktop/0.121.0 (...)`
- target thread: `019d9fa1-02bc-74b0-ae6e-4cc030e03782`
- outcome: new turn added to the existing thread
- proof:
  - before turns: `9`
  - after turns: `10`
  - new assistant message: `This thread received a supervised turn through the websocket app-server.`
- logs:
  - `/home/ubuntulxc/codex-thread-supervisor/logs/2026-04-18T13-22-55-229Z-7bff05.events.jsonl`
  - `/home/ubuntulxc/codex-thread-supervisor/logs/heartbeats.jsonl`

### 3. Existing thread via WebSocket app-server plus SMS

- websocket: `ws://127.0.0.1:9234`
- target thread: `019d9f9d-e340-7410-b1c3-073c39cdfb5d`
- outcome:
  - new turn added to the existing thread
  - Free Mobile SMS sent after turn completion
- proof:
  - before turns: `4`
  - after turns: `5`
  - new assistant message: `Le tour supervise est termine et le SMS de synthese peut maintenant etre envoye.`
  - SMS result: `code=0`, `SMS sent successfully.`
- logs:
  - `/home/ubuntulxc/codex-thread-supervisor/logs/2026-04-18T13-24-58-129Z-cda82f.events.jsonl`
  - `/home/ubuntulxc/codex-thread-supervisor/logs/heartbeats.jsonl`

## Important limitation discovered

If the target thread already has an active turn, `turn/start` is not safe to treat as "append a clean next turn immediately".

Observed on:

- target thread: `019d9f8e-f46c-7b90-a974-1cbebbe30a23`
- the supervisor request was issued while the thread was still busy
- result: the requested supervisor input was observed only after the existing active turn completed, which makes completion tracking ambiguous

Logs:

- `/home/ubuntulxc/codex-thread-supervisor/logs/2026-04-18T13-23-22-353Z-34eff0.events.jsonl`

Mitigation implemented in `supervisor.mjs`:

- read thread status first
- require `thread.status.type === "idle"` before starting a supervised turn
- fail clearly after `--idle-timeout-ms` if the thread does not become idle
