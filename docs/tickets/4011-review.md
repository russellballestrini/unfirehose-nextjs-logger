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

## Review response (2026-10-25)

Branch `claude/gifted-hopper-a8qnaf`, with main merged in at `2e898b7`. The pull request is [russellballestrini/unfirehose-nextjs-logger#6](https://github.com/russellballestrini/unfirehose-nextjs-logger/pull/6), against main, open since 2026-10-24. CI has run on every push to it; all nine checks were green on `318fdc5`: typecheck, lint, core, ui, web, schema, build, scripts and the quality budgets.

### Must fix

1. **Loopback by default.** `apps/web/scripts/serve.mjs` starts `next dev` and `next start` with `-H`; apps/web's `npm run dev` and `npm run start` go through it, and so do `make dev`, `make demo` and the systemd web unit. The address is chosen by `src/lib/bind-host.mjs`:
   - `UNFIREHOSE_HOST`, when set, decides alone.
   - Otherwise `$UNFIREHOSE_DIR/web-bind.json` `{"lan": true}`, written 0600 by Settings → Phone, selects `0.0.0.0`.
   - Otherwise `127.0.0.1`.

   The Phone tab spells out the warning, needs an "I understand" tick, and says a restart is needed. It shows a QR code only when our server answers on a LAN address. Checked live: `ss` showed `127.0.0.1:3011` only, and the box's LAN address refused the connection. Compose still publishes `127.0.0.1:3000`. Commit `c62e3b9`.
2. **Dead export.** `./training` is removed. `packages/core/package-exports.test.ts` checks that every export resolves to a file. Commit `241ab18`.
3. **Cold text.** Training export, `db/session-messages.ts` (the viewer's stored reader for Codex, Gemini CLI, Continue and Aider) and the action ledger's scanner now read through `blockTextSql` / `blockToolInputSql`. Three new cases in `db/block-cold-readers.test.ts` ask each reader the same question before and after freezing every block, and fail on the old code. Every other reader of block text already went through the cold reader. Commit `318fdc5`.
4. **CI regression-only.** Lint has 0 errors. The budgets are set to the numbers GitHub's runner measured on the final code, not the review's 20747 and 3134, because Aider, energy attribution and credential alerts landed after the review read `e062352`:
   - `CRAP_BUDGET = 22115`. A local run reads 22091.
   - `DUPE_BUDGET = 2002`. Folding 23 clones into shared code took it down from 3680.

   The Makefile comment says both ratchet down, never up. The todo-board drag tests made coverage depend on timing (the score read 22115 and 22120 on one commit); they now wait out the drop animations, and two local runs match exactly.
5. **Settings tab strip.** `overflow-x-auto` is in. Headless Chromium at 320 and 375 px on all ten tabs shows no page-level horizontal scroll; the strip scrolls in place.

### Decisions

1–9 are built as answered; ticket 4011 carries each outcome.

10 is the exception. **4004 was built** (`30102a0`, `6689c5b`) from the decisions relayed in the web session, not from fox's confirmation. It stays in the PR as it is, for fox to keep or revert at merge, and nothing more is built on it until the PR lands.

Reverting it:
- Run `git revert 6689c5b 30102a0`. `30102a0` also carries the `parseNvidiaSmi` / `sumNvidiaRows` merge in `mesh-local.ts`, so revert both together.
- Lower `CRAP_BUDGET` to the new reading in the same change.

### Smaller things

- **`action_ledger` indexes:** already `(project_id, timestamp)`, `(kind, timestamp)`, `(harness, timestamp)`, `(session_id, timestamp)`, and a partial `(timestamp) WHERE flagged = 1`. The Actions page filters by project, kind, harness and flagged. Nothing added.
- **Codex bridge:** `scripts/codex-bridge.mts` stays as a retirement notice. The README is now accurate:
  - Aider is in the headline.
  - The ingested harnesses are named apart from the 19 with adapter docs.
  - Aider has a row in the "Codex CLI, Gemini CLI, Continue and Aider" table.
- **`ledgerAfterIngest`:** left on the ingest thread. It is bounded per tick; if it shows in `[worker]` timings, it moves to the payload child.

Also fixed after the review read `e062352`:
- `tmux/new` shell-quotes a remote working directory, and refuses newlines and hosts that look like ssh options.
- CI is the only npm publisher: `make publish` bumps, commits and tags, and pushing the tag publishes.

Still open, for fox:
- Only `POST /api/lan` checks where a request comes from. A page on another site, open in a browser on this machine, could post to `localhost:3000`. The proposal is one middleware check that refuses cross-site writes, as its own ticket.
