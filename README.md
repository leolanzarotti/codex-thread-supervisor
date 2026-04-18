# Codex Thread Supervisor

Prototype minimal pour superviser un thread Codex existant via `codex app-server`, attendre la fin du tour, puis envoyer un SMS de synthese.

## Objectif

- cibler un `thread_id` existant
- lancer un vrai tour `turn/start` a intervalle regulier
- journaliser ce qui se passe localement
- envoyer un SMS apres completion
- rester simple, inspectable, et local

## Ce repo ne fait pas

- il ne depend pas de `codex exec resume`
- il ne suppose pas que `thread/inject_items` suffit a rendre un message visible en UI
- il ne cache pas les limites du protocole

## Structure

- `supervisor.mjs`: client `app-server` + boucle de supervision
- `logs/`: heartbeats et resultats d'execution

## Logging

Par defaut, le projet ecrit des logs compacts:

- `heartbeats.jsonl`: resume compact des runs
- `daemon.log`: log texte du daemon

Les `*.events.jsonl` detailles sont desactives par defaut et ne sont crees qu'avec `--debug-events`.

Retention par defaut:

- `events.jsonl`: `6h`
- `heartbeats.jsonl`: `7j`
- `daemon.log`: tronque automatiquement au-dela de `10 MB`

## Usage

Test local one-shot via `stdio`:

```bash
node supervisor.mjs run-once \
  --transport stdio \
  --thread-id 019d9f9d-e340-7410-b1c3-073c39cdfb5d \
  --prompt "Reply in one short sentence confirming supervisor reachability." \
  --log-dir ./logs
```

Test via un app-server websocket deja en ecoute:

```bash
node supervisor.mjs run-once \
  --transport ws \
  --ws-url ws://127.0.0.1:9234 \
  --thread-id 019d9f9d-e340-7410-b1c3-073c39cdfb5d \
  --prompt "Reply in one short sentence confirming supervisor reachability." \
  --log-dir ./logs
```

Boucle toutes les 15 minutes:

```bash
node supervisor.mjs loop \
  --transport ws \
  --ws-url ws://127.0.0.1:9234 \
  --thread-id 019d9f9d-e340-7410-b1c3-073c39cdfb5d \
  --every-minutes 15 \
  --prompt "Check the thread state and answer with a short supervision note." \
  --log-dir ./logs
```

Envoi SMS apres completion:

```bash
node supervisor.mjs run-once \
  --transport ws \
  --ws-url ws://127.0.0.1:9234 \
  --thread-id 019d9f9d-e340-7410-b1c3-073c39cdfb5d \
  --prompt "Reply with a short supervision note." \
  --sms \
  --sms-script /home/ubuntulxc/leo-codex-workspace/skills/free-mobile-sms/scripts/send_free_mobile_sms.sh \
  --log-dir ./logs
```

Attacher la conversation courante au superviseur:

```bash
node supervisor.mjs attach-current \
  --cwd /home/ubuntulxc/leo-codex-workspace \
  --transport ws \
  --ws-url ws://127.0.0.1:9234 \
  --every-minutes 10 \
  --prompt "Continue the work if there is a clear next step. If the current ticket or workstream is finished, check the relevant remaining tickets and start the most pertinent next one you can advance autonomously. If no relevant non-blocked ticket remains but there is a concrete, non-duplicate next step worth tracking, create the new GitHub ticket first, then continue on it. Otherwise give one short status update and stop."
```

Lister les supervisions enregistrees:

```bash
node supervisor.mjs list
```

Comportement automatique:

- `attach` et `attach-current` demarrent automatiquement le daemon si besoin
- `detach` arrete automatiquement le daemon si c'etait la derniere supervision active
- le prompt peut explicitement demander de basculer vers le ticket pertinent suivant quand le ticket courant est termine
- le prompt peut aussi demander de creer un nouveau ticket GitHub pertinent quand il n'y a plus de ticket non bloque a avancer, a condition d'eviter les doublons

Demarrer le daemon local:

```bash
node supervisor.mjs daemon-start
```

Verifier le daemon:

```bash
node supervisor.mjs daemon-status
```

Arreter le daemon:

```bash
node supervisor.mjs daemon-stop
```

Executer un tick manuel sur toutes les supervisions:

```bash
node supervisor.mjs tick
```

Executer un cleanup manuel des logs:

```bash
node supervisor.mjs cleanup
```

## Criteres de verification

- les logs JSONL montrent `initialize`, `thread/read`, `thread/resume`, `turn/start`, `turn/completed`
- le thread cible contient un nouveau tour apres execution
- le SMS n'est envoye qu'apres completion reussie

## Contrainte importante

Le thread cible doit etre `idle` avant `turn/start`.

Le prototype attend cet etat puis echoue proprement si le thread reste occupe au-dela de `--idle-timeout-ms`.

Voir aussi `EXPERIMENTS.md` pour les runs reels et les logs associes.

## Limite importante

Ce repo peut prouver qu'un nouveau tour a ete ajoute a un thread existant via `app-server`.
La visibilite exacte dans l'UI Desktop depend ensuite du fait que l'application Desktop lise ce meme stockage ou ce meme serveur. Les logs tries dans `logs/` sont faits pour documenter cela proprement.

## Etat local

Les etats persistants vivent hors git:

- `state/attachments.json`
- `run/daemon.pid`
- `logs/`
