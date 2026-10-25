# 4011 review — branch `claude/gifted-hopper-a8qnaf` at e062352, read 2026-10-24

Reviewed by blackops from the commits, not by re-running your suites; you ran
them in your environment and CI will run them again. Twenty-four commits,
233 files. The shape is right: one registry, one boundary, one set of upkeep
rules, forty-four new test files, every new route in llms.txt, CLAUDE.md
current. What follows is what stops a merge, then answers to your questions,
then smaller things.

## Must fix before merge

1. **Bind loopback by default, everywhere.** `docker-compose.yml` publishes
   `127.0.0.1:3000`; nothing else does. `make dev`, `make demo` and
   `deploy/systemd/unfirehose-web.service.in` still start Next on every
   interface, so a no-login dashboard that can push commits and type into
   tmux is on the LAN today. Add `-H 127.0.0.1` (or `HOSTNAME=127.0.0.1`) as
   the default in all three, and make the Phone tab the opt-in: a setting
   or `UNFIREHOSE_BIND=lan` that the unit and the Makefile honour, with the
   warning spelled out beside the switch. Your "not answering" branch then
   becomes the common case and should say how to turn LAN access on.

2. **Dead export.** `packages/core/package.json` exports `./training` →
   `./training.ts`, which does not exist; `./training-export` is the real
   one. Remove the dead entry.

3. **Cold text has a reader that does not know about it.**
   `packages/core/training-export.ts` reads `content_blocks.text` directly.
   Once anyone sets a retention window, sessions older than it export with
   empty text and no error. Route it through the cold reader, and check
   `db/session-messages.ts` the same way; `logs`, `active-sessions`,
   `projects/[project]/full`, `rate-limit-scan` and `pii-backfill` already
   do.

4. **CI arrives red; make it regression-only.** Fix the lint errors (your
   last commit says green; let CI confirm). Set `CRAP_BUDGET` to the
   measured 20747 and the duplication budget to the measured 3134, each with
   a comment that they ratchet down, never up. A budget nobody has ever met
   teaches people to ignore red.

5. **Settings tab strip** scrolls the page sideways at 375 px. The one
   class you named, `overflow-x-auto`, goes in now rather than later.

## Answers to your "Decisions for fox"

These are blackops' recommendations; fox has seen them and has not
overridden. Build to them unless the ticket says otherwise.

1. **Aider**: scan `.aider.chat.history.md` only in the roots of projects we
   already ingest. **Cursor, OpenCode**: stay documented only until their
   storage holds still for two releases.
3. **CI**: fix lint; budgets set to today's measurement, regression-only
   (above).
4. **unsandbox**: off by default, stays off across upgrades, kill-session
   left broken with a note. It is leaving this repo.
5. **Retention**: default no window, as shipped. Brotli is fine.
6. **Ledger**: yes, run the secret detectors at ingest so alerts can fire;
   `npm install` is network, as you already classify it; MCP tool calls are
   network too, add them.
7. **Alerts**: accept the drop over the hourly cap; show the dropped count
   beside the rule.
8. **Training export**: keep the over-redacting `password:` rule. A leaked
   secret cannot be recalled; a lost line of code can be regenerated.
9. **LAN**: loopback by default (must-fix 1). 1024 px drawer is fine.
10. **4004** stays blocked; do not start it.

## Smaller things, your call

- `action_ledger` has an index on `timestamp` only. If the Actions page
  filters by project or flag, it wants `(project_name, timestamp)` and a
  flags index before the table grows past a few hundred thousand rows.
- `scripts/codex-bridge.mts` is a retirement notice now; README still shows
  the Codex path under the old heading. Fine either way; say which.
- The worker's `ledgerAfterIngest` runs on the ingest thread. Bounded, so
  acceptable; if the backfill tick ever shows in `[worker]` timings, it
  belongs in the payload child like the other heavy work.

## Then

Open the PR against main. blackops merges, builds and restarts the services
here, and appends the live result to this file.
