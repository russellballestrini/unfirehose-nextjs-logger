# 4011: Batch three — reach more people, keep what we have healthy

**Status:** open, ready for a web session; pick items in order unless fox says otherwise
**Project:** unfirehose-nextjs-logger
**Estimated:** several sessions; each item is independent and stands alone as a PR
**Owner:** web session; fox reviews

## Why

4010 made the first five minutes teach themselves. This batch is about who
can arrive at all, and about the box staying healthy once they do. Everything
here is free, local, and without a network call home; see the feedback memory
on extractive monetization. unsandbox is a separate product; item 4 prepares
its removal from this repo.

Facts measured 2026-10-23 on fox's box: 19 harness adapter docs exist in
`packages/schema/docs/harnesses/`, 5 harnesses are ingested
(`session-paths.ts`), the detector knows 4 (`harness-detect.ts`), doctor
finds 6 by another path. The database is 7.0 GB: 2.18 M messages, 2.35 M
content blocks, 427 k mesh snapshots. GitHub, where web-session PRs merge,
runs no CI; `.gitlab-ci.yml` has test and publish stages that only GitLab sees.

## Items

### 1. Ingest the harnesses we only document
Readers for Gemini CLI, OpenAI Codex, Aider, Cursor, OpenCode and Continue.dev
session logs, each a `HarnessAdapter` in `session-paths.ts`, each with a
fixture captured from the tool's public format and a test that ingests it to
the same message and content-block rows Claude Code produces. Every one of
these tools' users is someone unfirehose can serve today and does not. Start
with Gemini CLI and Codex; they have the most users. Acceptance: `make demo`
grows one synthetic session per new harness; doctor and the wizard list them.

### 2. One harness registry
Three lists name harnesses today: `session-paths.ts` (ingest), `harness-detect.ts`
(wizard, settings), and whatever doctor walks to find arborist and aborist.
Collapse to one registry in core that carries id, display name, home path,
adapter doc, and reader. Everything else imports it. Item 1 lands on top of
this, so do this first or together.

### 3. CI on GitHub too, and a suite that does not flake under load
Mirror `.gitlab-ci.yml`'s test stage as a GitHub Actions workflow on pull
requests and pushes to main: `npm ci`, `tsc --noEmit` in core, ui, web,
worker, then the four vitest suites as separate jobs so none starves another,
then `make build`. On 2026-10-22 the parallel `make test` on a busy box
failed five tests by timeout alone (shell-spawning probes, render smoke,
quality reports at 50 to 120 s); all passed in isolation. Give those tests
honest deadlines or a `serial` project so the suite's answer means something.

### 4. Isolate unsandbox behind one boundary
Thirty files mention it: `api/unsandbox`, `lib/unsandbox-auth.ts`,
`permacomputer/Unsandbox{Panel,NodeCard}.tsx`, `permacomputer/unsandbox/`,
provider ids in settings, copy in llms.txt and README. Move the code under
`apps/web/src/integrations/unsandbox/` with one registration point and a
default-off flag; the mesh page renders without it; the rest of the app does
not import from it. Scrub the brand from shared copy into an Integrations
section. A future version deletes one directory. Nothing under unsandbox's
own repos is touched.

### 5. Database health and retention, user-controlled
7.0 GB and growing. Add a Settings panel that shows size by table and growth
per week; a `make vacuum` the worker can schedule when idle; and a retention
knob for content-block text, default keep everything, where a chosen window
moves older block text into a compressed cold table and keeps every
aggregate exact. Warn in doctor and the wizard when the disk under the
database has under 10 GB free. The mesh tiered-storage memory is the pattern.

### 6. Agent action ledger
From content blocks already ingested: every tool call that touched the
filesystem, git, or the network, searchable by project, session, path and
command, with flags for destructive commands, secrets in diffs, force pushes.
A page and an API, free, because knowing what an agent did on your machine is
safety, not a feature tier.

### 7. Alert delivery from the worker
Alerts exist and are display-only. Add rules in Settings and delivery to a
webhook URL, ntfy, Slack and Discord from the worker, with a test-send
button. No email: that needs a sender we do not run.

### 8. Training-set export
The schema already defines training JSONL. Export curated sessions as SFT
data with filters for project, model, date, tool success, and the core PII
module applied, as a download from the project page. Free.

### 9. Phone on the LAN
A responsive pass over Dashboard, Tokens, Projects and Live, and a QR code in
Settings that opens the dashboard from a phone on the same network. "Phone
access" without a cloud.

### 10. Small, found on the way
- uPlot builds `Intl.NumberFormat(navigator.language)` at module load and
  throws for a POSIX-suffixed locale; guard it where we import uPlot.
- Worker stage in the Dockerfile so compose's worker has ssh and git;
  `make docker-run` catches up with compose.
- Ticket 4004 (measured watts) stays blocked on fox's three answers.

## Acceptance for every item
`make test` green, `tsc --noEmit` clean in all four packages, `make demo`
still populated, no new network calls, no new "nothing yet". Outcome and
decisions appended to this ticket like 4010 did.

## Outcome: item 10 (2026-10-23)
- **uPlot locale guard.** Every uPlot import goes through `apps/web/src/lib/uplot`
  (an eslint `no-restricted-imports` rule keeps it so). Its first import,
  `locale-guard.ts`, has no imports of its own, so ESM evaluates it before
  uPlot's module body; it rewrites `navigator.language`/`languages` to a tag
  `Intl.getCanonicalLocales` accepts (`en-US@posix` -> `en-US`, else `en-US`).
  Tested under jsdom with the real uPlot, plus a control file proving a bare
  import still throws. In Chromium, with `navigator.language` forced to
  `en-US@posix` by an init script, `/`, `/tokens`, `/scrobble` and
  `/styleguide` load with charts and no pageerror; the same run against bare
  imports reproduced `RangeError: Invalid language tag: en-US@posix`. (A
  plain LANG=C launch of our Chromium 1194 reports `en-US`, so the defect
  needs the forced tag to reproduce here.)
- **Docker.** New stages: `deps` (npm ci), `builder` (next build), `worker`
  (workspace + node_modules, tsx, ssh, git, bash, GNU coreutils, procps,
  lsblk; runs as node) and `web` (last, the default). Both images create
  `~/.unfirehose` owned by node, so compose's `init-data` chown service is
  gone. `make docker-run` is `docker compose up --build` in the foreground.
  Also removed a `COPY apps/extension/package.json` that has no source file
  and failed every build. procps and lsblk joined the web image too: the
  local probe reads `ps aux` columns and `lsblk`, which busybox lacks.
- **4004** status line now reads blocked and lists fox's three questions.

## Outcome: item 1 (2026-10-23)

Codex, Gemini CLI and Continue are ingested from the tools' own files; Aider,
Cursor and OpenCode are not yet (below).

- **One reader per foreign format**, driven by the registry: `HarnessFormat`
  gains `codex-rollout`, `gemini-chat`, `continue-session` (`FOREIGN_FORMATS`);
  each entry has a root in `harness-roots.ts`; `harness-files.ts` lists their
  session files for ingest and detection alike; `db/ingest-foreign.ts` reads
  them on every full pass, honouring `UNFIREHOSE_HARNESSES`. Every reader lands
  through the rows Claude Code's do, and a test per harness ingests its fixture
  (`packages/core/test/fixtures/harnesses/`) and holds its block shape, texts
  and token totals equal to a Claude Code fixture of the same turn.
- **Discipline.** Codex rollouts are append-only: byte offset plus the
  reader's folded state (session, model, cumulative token counters) in two new
  `ingest_offsets` columns (`mtime_ms`, `reader_state`). Gemini recordings are
  append-only but re-record a message as it fills in, with `$patch`/`$rewindTo`
  lines; Continue rewrites whole. Both skip a file while size and mtime match,
  refold a changed one, insert by id, and hold back the newest message of a file
  touched in the last 30 s so a turn is not frozen half-written.
- **Codex bridge retired.** Ingest reads `$CODEX_HOME/sessions` and gives each
  line the bridge's message id, project and session, so bridged history stays
  and nothing doubles; `~/.codex/unfirehose` joins `NOT_NATIVE_DIRS` so it is
  not read too. `scripts/codex-bridge.mts` now prints that and exits.
- **Viewer.** These harnesses have no `{slug}/{session}.jsonl`, so their
  adapters are `stored` and the session page reads `db/session-messages.ts`
  (the rows) instead; chain-live and inject answer plainly for them.
- **Demo, doctor, wizard.** `make demo` adds one session each (24 in all);
  doctor and the wizard list the three from the registry with counts from the
  real layouts (checked against a fake home holding the fixtures).

Decisions to review:
- Gemini message ids are Gemini's own UUIDs (tool results `<id>:tool-results`);
  Continue's are `continue:<sessionId>:<history index>`, so a turn edited in
  place keeps the version first seen.
- Continue messages carry no timestamps; they are stamped from reasoning times
  or the session's creation time, never running backwards.
- Gemini cwd: `.project_root`, then `~/.gemini/projects.json`, then a known
  project path whose sha256 names a legacy dir; otherwise `gemini-<dir>`.
- Foreign sources are not fs-watched; the next full pass (a minute) reads them.

Not done, and why:
- **Aider** keeps `.aider.chat.history.md` inside each repo (no central
  directory), as markdown with no per-message ids or times and token counts
  rounded to "1.2k". Needs a decision on which repos to scan; not guessed.
- **Cursor** chats live in an undocumented SQLite key-value store
  (`state.vscdb`, `cursorDiskKV`) whose shape changes between releases; no
  public format to cite.
- **OpenCode** moved storage twice in a year (JSON tree to v1.1, SQLite from
  v1.2, a v2 restructure in 2026 whose source we could not read); a reader
  would chase a moving target. Worth doing against v2 once its schema is
  readable.

## Outcome: item 6, agent action ledger
- `packages/core/action-ledger.ts` classifies one tool call into
  `fs-read | fs-write | git | network | shell`, the paths, URLs or hosts it
  named, its command, and flags: `destructive`, `force-push`,
  `force-with-lease`, `secrets-in-diff`, `secret-in-command`, `sudo`,
  `curl-pipe-shell`, each with a reason in words. Tool names for Claude Code,
  Codex (`shell` argv, `exec_command`, `apply_patch`), Gemini CLI, OpenCode,
  pi and hermes. Shell text is split with shell-pretty's `splitTopLevel`.
- Destructive is judged by target: `rm -r` of root, home, a home's dot or
  `git` folders, system or top-level directories, `$VAR/`, `.` or `*`;
  `git reset --hard`, `clean -f`, `checkout .`, `restore .`, `branch -D`,
  `stash drop|clear`, `push --delete|--mirror`, `filter-branch`; `dd` onto a
  device, `mkfs`, `shred`, `truncate` outside /tmp, `chmod -R 777`; `>` over
  system files, ssh files or login dotfiles; SQL `DROP`, `TRUNCATE`, `DELETE`
  without WHERE through a database client. `rm -rf dist` and
  `find . -name '*.pyc' -delete` are not flagged.
- Credentials: `findSecrets` / `redactSecrets` in `pii.ts` (vendor token
  shapes plus credential-named assignments whose value looks random). Not
  added to `sanitizePII`, so ingest stores what it stored before; the ledger
  redacts what it keeps.
- Table `action_ledger` (not `agent_actions`, our dispatch queue), keyed on
  `block_id`, indexed by time, session, project, kind, harness and a partial
  index on flagged rows. Filled by `db/action-ledger.ts`: a head cursor at the
  end of every ingest pass, and a newest-first backfill in block-id windows of
  50 000 from our worker every 15 s while no ingest runs (about 47 windows for
  2.35 M blocks). A `LEDGER_RULES_VERSION` bump re-classifies history.
- `GET /api/actions` (filters, keyset paging, `format=csv`), `POST` rebuild;
  page `/actions` under Analyze, linked from a project's Activity tab; rows
  link to `/projects/<p>/<session>#tool-<id>`, which our session viewer now
  scrolls to. `make demo` seeds a `git reset --hard` and a WebFetch.

## Outcome: item 4 (unsandbox behind one boundary)

- Code lives in `apps/web/src/integrations/unsandbox/`. Registration points:
  `integrations/catalog.ts` (ids, names, flag logic; plain data),
  `integrations/index.tsx` (what pages may render), `integrations/server.ts`
  (`gated()` route wrapper, `hostIntegration()` for `/api/boot` and
  `/api/tmux/upload`). `app/api/unsandbox/**/route.ts` are two-line gated
  wrappers; `app/permacomputer/unsandbox/page.tsx` renders `IntegrationPage`.
- Flag, default off: settings key `integration_unsandbox` (Settings →
  Integrations, `POST /api/integrations`), overridden whole by
  `UNFIREHOSE_INTEGRATIONS=unsandbox` (`none` = all off; when set the toggle
  is locked). Off: routes 404, the mesh page, project page, /tmux and the
  viewer render without it and ask none of its endpoints.
- `integrations/boundary.test.ts` fails on any import of the directory from
  outside the registry and its wrappers, and on the directory importing from
  `src/app/` outside its tests.
- Decision: an install that already had keys stored starts with the
  integration off after upgrading; turn it on once in Settings.

## Outcome: item 9, phone on the LAN (2026-10-23)

**Responsive pass.** Below `lg` our sidebar is a drawer behind a ☰ button
in a 56px top bar (closes on navigation, Escape, a tap outside). Measured in
headless Chromium against `make demo`, `main.scrollWidth / clientWidth`:

| Page | 375 before | 375 after | 768 before | 768 after |
|---|---|---|---|---|
| Dashboard | 871 / 87 | 375 / 375 | 871 / 480 | 768 / 768 |
| Tokens | 626 / 87 | 375 / 375 | 626 / 480 | 768 / 768 |
| Projects | 373 / 87 | 375 / 375 | 522 / 480 | 768 / 768 |
| Live | 295 / 87 | 375 / 375 | 480 / 480 | 768 / 768 |

Also clean at 360 and 430. Tables scroll in their own box, chart rows and
stat grids reflow, `StatDivider` becomes a rule when its strip wraps, tap
targets are 40px below `lg`. Hover now has a tap equivalent: uPlot readouts
stay up after a tap (`lib/uplot-touch.ts`), live entries toggle on tap, and
our dashboard model table spells out its column titles in a disclosure.

**QR in Settings → Phone.** `GET /api/lan` lists IPv4 addresses from
`os.networkInterfaces()` (no loopback, link-local, IPv6, or docker/VM
bridges), kinds `lan` / `vpn` / `public`, and probes each `address:port`
locally to say whether our server answers there. Encoder in repo
(`lib/qr.ts`, byte mode, versions 1–10): matched uqr module for module and
decoded with jsQR in 27 cases, checked once outside this repo; neither is a
dependency. Our dashboard is drawn dark on white whatever our theme.

**Decisions for fox.**
- `next dev` and `next start` bind 0.0.0.0 by default, so `make dev`,
  `make demo` and the systemd unit already serve this no-login dashboard
  (commit and push, tmux keystrokes, bootstrap) to the whole LAN today. The
  Phone tab only makes that visible. A safer default is `-H 127.0.0.1`
  with an opt-in, which would also make the tab's "not answering" branch
  the common one.
- The sidebar becomes a drawer below 1024px, not 768px: at 768 a 288px
  column left a portrait tablet 432px of page.
- Settings' own tab strip still scrolls the page sideways at 375 (seven
  tabs); out of this item's scope, a one-class fix (`overflow-x-auto`).
- `next dev` warns "Cross origin request detected" for its HMR socket
  when opened by LAN address; a future Next blocks it unless
  `allowedDevOrigins` lists the address.

## Outcome: item 2, one harness registry (2026-10-23)

`packages/core/harness-registry.ts` lists every harness once, one entry per adapter doc (19). The entries are pure data, so client components import it freely. Where an ingested harness writes is server-side, in `harness-roots.ts`. These lists are now derived from the registry rather than kept by hand:

- what ingest reads (`session-paths`);
- what the wizard, Settings and doctor show (`harness-detect`);
- what the boot panel launches (`harness-models`);
- what a probe recognises in `ps` (`harness-procs`);
- what counts as a native writer (`NOT_NATIVE_DIRS`).

`harness-registry.test.ts` holds the table to the docs and checks that ids, launch keys and process names are unique. It also checks that the ingested set equals the roots map, and that every derived list keeps the values it had before. Item 1 then added Codex, Gemini CLI and Continue as three registry entries.

Decisions: `launch.key` keeps the boot panel's older keys (`open-code`, `gemini`), because saved settings and running tmux sessions use them.

## Outcome: items 7 and 8 (2026-10-23)

- **7. Alert delivery** — Settings → Alerts; webhook (HMAC-signed), ntfy, Slack, Discord from our worker; once per rule, 5 attempts with backoff, per-rule hourly cap drops the excess (`rate_limited`); Send test. Tables `alert_delivery_rules`, `alert_deliveries`. Secrets in `$UNFIREHOSE_DIR/alert-secrets.json` (0600), masked to the client.
  Decisions: secrets in a file (the browser vault is unreadable by the worker; the DB is copied/seeded); over-limit alerts dropped not queued; new rules start from now; localhost/LAN destinations allowed (single-user local app), no redirects, 10 s timeout; the per-project filter matches nothing until alerts are raised per project.
- **8. Training-set export** — project page → Export training set: chat-SFT JSONL (`{"messages":[…]}`, OpenAI tool_calls form; reasoning and metadata off by default), filters for project, model, harness, dates, tool errors, turn counts; preview with redaction counts, then a streamed download (`GET /api/training-export`). Every string passes `redactForExport` (secrets, home-path usernames, then `sanitizePII`), redacted to `__TYPE_N__` tokens, never dropped. Lines checked against `SFT_EXAMPLE_JSON_SCHEMA` with Ajv.
  Decisions: the `password=/token:` rule over-redacts code like `password: process.env.X`; an errored tool result drops its turn by default (session / keep are options); sessions outside min/max turns are skipped, not truncated; should the export schema move into packages/schema (a spec addition)? `packages/core/package.json` exports `./training` → a file that does not exist (left as found).

## Outcome: item 3, GitHub CI and honest deadlines (2026-10-23)

`.github/workflows/ci.yml` runs on pull requests and on pushes to main. Actions are pinned to full SHAs, the job holds `contents: read`, and checkout does not persist credentials. Jobs:

- `typecheck` runs first.
- core, ui and web then run on separate runners under coverage, each enforcing its floor.
- `schema` and `build` also wait for typecheck.
- `scripts` runs after core, ui and web, with their coverage downloaded and `UNFIREHOSE_REQUIRE_COVERAGE=1` set.
- `budgets` runs after scripts.
- `lint` runs on its own.

On a fresh clone the report tests that need coverage now skip, with the reason in their names, instead of failing. CI sets the variable, so there a missing measurement still fails.

The timeouts were reproduced with every suite pinned to 2 cores beside 24 CPU hogs. Each slow test now has a named deadline constant, with a comment giving its idle and loaded times. Nothing was skipped or disabled. The same heavy run is green after the change.

Decisions for fox:

- `npm run lint` fails today, with 16 errors in apps/web that predate this ticket.
- `make quality-budgets` fails today: crap is 20747 against a budget of 19000, and duplication is 3134 against 1200. The GitLab gate is red for the same reason.
- Both are separate CI jobs that nothing else waits on, so they show red until the code is fixed or the budgets are raised. Which should it be?

## Decisions for fox, all items

1. Cursor and OpenCode are still documented only: they store sessions in a shape that changes between releases. Aider is decided and ingested (see "Outcome: Aider").
2. (none)
3. Lint and budget jobs are red on arrival: fix the code, or raise the budgets?
4. Should `DELETE /sessions/:id` (kill session) be fixed inside the boundary? Should an upgrade keep unsandbox off until someone turns it on?
5. Retention window defaults. Is the brotli cold store OK?
6. Wire the secret detectors into ingest as well? Should `npm install` and MCP tool calls count as network actions?
7. Alert secrets live in a 0600 file. Over-limit alerts are dropped, not queued.
8. The `password:` rule over-redacts code. `./training` is exported from core's package.json but points at a file that does not exist.
9. `next dev` already listens on 0.0.0.0, so a dashboard with no login is on the LAN today. The mobile drawer cutoff is 1024 px.
10. Ticket 4004 is marked blocked.

## fox's decisions (2026-10-24)

1. **Aider, Cursor, OpenCode.** Scan Aider history in the roots of projects we already ingest, nowhere else: those are the repos the person demonstrably works in. Skip Cursor and OpenCode until their storage holds still for two releases; a reader we rewrite every month is a liability, not reach.
2. **CI red jobs.** Fix the 16 lint errors now. Set each quality budget to today's measured value, so CI fails only on regression, and ratchet the budgets down as splits land. A budget nobody has ever met teaches people to ignore red.
3. **Unsandbox boundary.** Off by default and off across upgrades: nothing turns it on without the setting or the environment. Kill-session stays broken, with a note in `integrations/unsandbox/terminal.ts`, because the integration is leaving and every hour spent inside the boundary goes to a product that is leaving.
4. **Retention.** Keep everything by default (already the default: no window, nothing moves). Brotli is fine. The knob is for people with small disks, not for us to decide what they lose. Doctor's 10 GB warning is the nudge.
5. **Ledger.** Yes to all three: run the detectors at ingest so alerts fire, count `npm install` as network, and count MCP calls as network. Anything that leaves the box is an action the owner should be able to see.
6. **Alert delivery.** Keep dropping alerts over the hourly cap, and show the dropped count beside the rule. A queue that drains hours later delivers stale alarms, which are worse than a visible count.
7. **Training export.** Keep the over-redacting rule: a training set that leaks a secret cannot be recalled, while one that loses a line of code can be regenerated. The dead `./training` export is gone, and `package-exports.test.ts` checks that every export resolves.
8. **LAN exposure.** Bind 127.0.0.1 by default everywhere: dev, demo and the systemd web unit. The LAN is an opt-in from the Phone tab, with the warning spelled out. A no-login dashboard that can push commits and type into tmux must not be reachable by default from anything that joins the wifi. This one blocks the merge.
9. **Tablet breakpoint at 1024 px.** Fine as shipped.
10. **4004, measured watts.** Pre-aggregate in the sampler. Subtract idle draw and show idle as the node's standing cost. Sum GPUs per node until nvidia-smi gives us a per-process mapping. Per-row joins at request time would put us back where the tokens route was.
11. **4010 follow-ups.** All three accepted as shipped.
12. **npm publishing.** CI is the only publisher. 3970's blocker is closed as moot, and no local token is minted. `make publish` now bumps, commits and tags; pushing the tag publishes. One publishing path, one place a token lives.
13. **Monetization.** Nothing, for now. Fund it from the products that are products and keep unfirehose a gift. Revisit only if someone asks to pay for hosting or support, the two honest things to sell. Reach first, which is exactly what batch three is.

## Outcome: LAN exposure (fox's decision) (2026-10-24)

Decision: our dashboard listens on 127.0.0.1 by default everywhere; the LAN is an opt-in. This answers item 9 in the list above.

- **Launcher.** apps/web's `npm run dev` and `npm run start` run `apps/web/scripts/serve.mjs`, which spawns `next dev|start -H <host>` and forwards signals. Everything that starts the web app goes through it: `make dev` (via turbo), `make demo`, the systemd web unit (`npm run start`) and `scripts/perf/prod-server.sh`. A `-H` given on the command line is passed through untouched. The launcher prints where it listens and, when that is not loopback, what it exposes. It passes `UNFIREHOSE_BOUND_HOST` to the server so the server knows its own bind.
- **Rule** (`apps/web/src/lib/bind-host.mjs`, plain ESM so bare node runs it, shared with the route). The first match wins:
  1. `UNFIREHOSE_HOST`, which decides alone. A value that is not an address or host name falls back to 127.0.0.1 with a warning.
  2. `$UNFIREHOSE_DIR/web-bind.json` containing `{"lan": true}`, which binds `0.0.0.0`.
  3. Otherwise 127.0.0.1.

  A missing, unreadable or malformed file reads as local.
- **Settings → Phone.** `GET /api/lan` now carries `bind`: running host, saved choice, what a restart picks, `restartNeeded`, override, container. `POST /api/lan` saves the choice; the file is written 0600 via a temp file and rename. Opening needs `understood: true`. The POST is refused cross-site (403, by `Sec-Fetch-Site` or a foreign `Origin`), and also while `UNFIREHOSE_HOST` is set or inside a container (409).
  - The tab offers a QR only for addresses where our server answers, and never while it was started on loopback.
  - Otherwise it explains the opt-in, warns in plain words ("Anyone on the same network can read every session, push commits, and type into tmux. There is no login."), and gates the button behind an "I understand" checkbox.
  - After saving it says a restart is needed and how: `make dev` again, or `make service-restart`.
  - Opted in, it offers "Keep it to this machine on next start".
- **Docker.** The image binds 0.0.0.0 inside the container, which the host needs to reach it at all. Compose already published `127.0.0.1:3000:3000`, and `make docker-run` is compose now. The web image sets `UNFIREHOSE_CONTAINER=1`, so the tab points at the port mapping instead of drawing a QR for the container's own address.
- **Other listeners.** Our worker and router open no ports. `make doctor`'s port check binds for a moment to test whether the port is free and closes at once; it was left as is.
- **Mutual exclusion is unchanged.** `make service-start` still looks for `tsx watch.*worker/src/main` or `turbo dev`, and `make dev` still checks the worker unit.
- **Verified.** `npm run dev -- -p 3999` → `ss -ltnp`: `127.0.0.1:3999` only, and the eth0 address refused. After `POST {lan:true, understood:true}` and a restart: `0.0.0.0:3999`, with the tab's probe answering. SIGTERM to the launcher took `next-server` down with it.

Decisions for fox:
- The opt-in binds `0.0.0.0` (IPv4 only), not `::`. The QR is IPv4 anyway.
- There is no origin check on any other mutating route. Only `POST /api/lan` has one. A page on another site can still POST to `localhost:3000` (git push, tmux keystrokes) from the browser on this machine. That is a wider defect than LAN exposure and worth its own ticket.
- The unsandbox bootstrap script (`integrations/unsandbox/NodePage.tsx`) still runs a bare `npx next start` inside the remote container, where the unsandbox port mapping decides. It was left as is.
- `next dev` warns about cross-origin HMR when opened by a LAN address once opted in (`allowedDevOrigins`), as noted under item 9.

## Outcome: Aider (fox's decision)

fox decided: scan only the roots of projects we already ingest. Aider is now
ingested.

- **Where we look.** `db/project-roots.ts` `knownProjectRoots(db)` returns every
  `projects.path` and `last_cwd_seen` that exists, plus the git root above it
  when it is a subdirectory (Aider writes its log in the git root). The walk
  stops below `$HOME`. Nothing crawls the home directory. A repo is searched
  only after some harness we read has worked in it.
- **Registry.** Aider gets `format: 'aider-history'` (in `FOREIGN_FORMATS`) and
  `repoFile: '.aider.chat.history.md'`. It has no entry in `HARNESS_ROOTS`, since
  it has no root of its own. The registry test now requires each ingested
  harness to have exactly one of a `HARNESS_ROOTS` entry or a `repoFile`
  (today that is Aider alone). A comment there explains why.
  `foreignSessionFiles('aider-history', root)` checks one file with a stat
  and never lists a directory.
- **Reader** (`aider-adapter.ts`, `ingestAiderFile` in `db/ingest-foreign.ts`).
  - Each `# aider chat started at` header starts a session in project
    `aider:<slug>`, where the slug comes from the root the file is in.
  - `#### ` lines are prompts. A reply is the text between them. Each
    SEARCH/REPLACE edit becomes an `Edit` tool call (`file_path`,
    `old_string`, `new_string`), and `> Applied edit to <file>` becomes its
    result.
  - Other `> ` lines are kept verbatim as system messages with
    `subtype: aider-output`.
  - The model comes from `Main model:` / `Model:` / `Models:` lines and the
    version from `Aider vX`.
  - Inside a reply, only Aider's own hard-broken lines (trailing two spaces)
    outside a code fence count as markers. A quote or a heading in a reply
    stays part of the reply.
- **Tokens.** `Tokens: 4.4k sent, 2.1k cache write, 3.2k cache hit, 312
  received.` is read as printed, so "4.4k" becomes 4400. A message with any
  rounded figure gets the new column `messages.tokens_approx = 1`. No
  precision is invented. Cache hits and writes are booked beside "sent", not
  subtracted from it, matching Aider's own cost arithmetic.
- **Times.** The header gives local time with no zone. Prompts take their time
  from `.aider.input.history` (matched by text, in order, after the run's
  start). Every other message takes the latest time known before it, so times
  never run backwards.
- **Incremental.** The file is append-only, so it is read from a byte offset
  that always sits on an item's first line, with the open run's state stored
  in `reader_state`. While the file moved within the last 30 s, the newest
  turn (its prompt onward) waits, so its `Tokens:` line lands with its reply.
  A file shorter than our offset (cleared) is read again from the start.
  Message ids are `aider:<session>:<offset from header>`. The session id is
  sha256 of the path, the header's offset and its time, so a cleared and
  rewritten log does not collide with what was read before.
- **Detection.** `detectHarnesses({ projectRoots })`. `/api/onboarding` (wizard,
  Settings) passes our projects' roots, and `make doctor` reads them through
  a read-only handle on the database. With no database, Aider reads as not
  found.
- **Demo, docs.** `make demo` has 25 sessions, one of them Aider's, with rounded,
  approximate counts. The fixture is `test/fixtures/harnesses/aider/demo-api/`
  (two runs, an edit, a `<blank>` input, look-alike markers). The adapter
  doc, the schema READMEs and `docs/jsonl-schema.md` say Supported.

Decisions to review:
- A system message per run of `> ` lines keeps Aider's output (commits,
  "Added x to the chat", warnings) visible in the viewer. The other option was
  to drop it.
- A `Tokens:` line that arrives a pass after its reply has already landed is
  lost. That happens only if Aider paused more than 30 s between the two.
- Aider prints no per-message model in architect mode. Replies are booked to
  the main model.
- `/run` and `/add` stay as prompt text and are not turned into tool calls:
  the person ran them, not the agent, so the action ledger does not count them.

## Outcome: fox's decisions on items 6 and 7 (2026-10-24)

Fox decided: run the secret detectors at ingest and alert; installs and MCP
calls are network actions ("anything that leaves the box is an action the
owner should be able to see"); keep dropping over the hourly cap, but show
what was dropped.

**Credentials seen at ingest raise an alert.**
- The ledger scanner (`db/action-ledger.ts`) now reads tool results in the
  same block-id windows as tool calls. `findSecrets` runs on every result
  behind one case-blind prefilter (`mayHoldSecret`, a superset of every
  pattern, held to each one by `pii-secrets.test.ts`), so most outputs cost
  one regex scan. A call flagged `secrets-in-diff` or `secret-in-command`,
  or a result holding a credential, becomes a row in `secret_sightings`
  (`db/secret-alerts.ts`).
- The ledger gains a flag, `secret-in-output`, on the call whose output held
  one, applied whichever of the two blocks is read first (the backfill walks
  newest first). A credential handed to a network or MCP tool is now
  `secret-in-command` ("sends a credential (private_key) to MCP server
  linear"). `LEDGER_RULES_VERSION` is 2, so history is re-classified.
- A new sighting raises `alerts` row `alert_type = 'secret_exposed'`
  (`metric = 'secret'`, `window_minutes = 0`, `actual_value` = times seen in
  that session, `project_name` = the encoded project). Its `details` name
  the kinds, call or result and which tool, the session UUID, project and
  display name, harness and the line's time. Never the value, a fragment of
  it, the command or the output: a test reads every row we wrote and finds
  no trace of the fixture key. Ingest adds these to `alertsTriggered`, and
  the worker delivers at once, as it does for usage alerts; the worker's
  ledger tick does the same when its head scan raises one.
- Every destination says it in words (`secret-alert.ts`, shared by delivery,
  the Usage page and the alert page): "unfirehose: Anthropic key seen in
  api", with Kind, Where, Project, Session and Seen at fields on Slack and
  Discord, ntfy priority 5. Delivery rules gain a "Credentials seen" scope
  (`match.metric = 'secret'`); a project rule now matches an alert by
  encoded or display name, which also makes the per-project filter useful.
  The Usage page shows credential alerts in their own banner and list rows;
  `/usage/alert/<id>` shows kind, where, session, time and links to the tool
  call and to the session's flagged actions.

**Idempotent, and history does not spam.**
- `secret_sightings.block_id` is UNIQUE: a re-ingest, a backfill pass or a
  ledger rebuild meets the same line and records and raises nothing. The
  table survives a rules bump (only `action_ledger` is emptied).
- One alert per session and kind. Later sightings of that kind in that
  session join it and bump its count; delivery sends once. A kind new to the
  session raises its own. Clearing the alert lets the next sighting raise.
- Only the head scan (the one at the end of an ingest pass) may raise, and
  only for lines whose own timestamp is at or after `secret_alerts_since`,
  a setting written the first time the scanner runs on a database. The
  backfill never raises; it records sightings with `backfilled = 1` and the
  ledger flags them. So upgrading an install with a year of history, or a
  first ingest of an old `~/.claude`, fills `/actions` with flagged history
  and sends nothing. What arrives from then on alerts.
- Text already moved to the cold store by the retention window is not read
  by the backfill.

**Installs and MCP calls are network.** Already true for `npm i/ci/add`,
pnpm, yarn, bun, pip, uv, poetry, cargo, go, gem, apt, brew, dnf and docker
pull/push, and for every `mcp__*` tool. Added: `python -m pip install`,
pipx, uvx, pnpx, conda/mamba/micromamba, composer, bundle, dotnet add/restore,
deno add/install, `npm exec`/`npx`-style `npm x`, bare `yarn`, and options
before the subcommand (`npm --prefix web ci`, `pnpm --filter web install`).
`npm run`, `yarn test`, `cargo test`, `python -m pytest` stay `shell`.

**Dropped over the cap, shown per rule.** Still dropped, never queued.
`GET /api/alerts/delivery` rules now carry `dropped_24h` and
`last_dropped_at`, and `failed_24h` no longer counts drops (it used to lump
them in). Settings → Alerts shows under each rule "3 dropped in the last
24 h over this rule's 10/hour cap, last 5 minutes ago. Dropped alerts are
not sent later; raise the cap if these mattered", or "0 dropped …". Why
24 h rather than "since last success": it sits beside the sent and failed
counts that already use 24 h, it is long enough to show a cap set too low
across a busy day, and "since last success" reads as zero right after one
send even when ten were just dropped. Attempts are kept 30 days, so the
window could grow without a schema change.

Decisions to review:
- Secret alerts start from first run, not from ticket date: an install that
  upgrades a week late alerts from then. A backfill never alerts, even for a
  post-cutoff line found only by an improved detector after a rules bump.
- `secret-in-output` treats every credential a tool printed as exposed,
  since the session went to the model provider. A test fixture key in a
  repo's own tests will alert once per session; the ledger shows which.
- No off switch for secret alerts beyond delivery rules (a rule that does
  not match `secret`). Say if one is wanted.

## Budgets set to today's reading (2026-10-24)

Per fox's decision 2: `CRAP_BUDGET` is now 22097 and `DUPE_BUDGET` is 2002, each measured on this branch with every suite's coverage regenerated.

- **CRAP:** 20728, then 18634 after this batch's tests, then 22097 once the new Aider, energy-attribution and secret-alert code landed.
- **Duplication:** 3680, down to 2002 after folding 23 clones into shared code.

Lint is green (0 errors). From here the two budgets only ratchet down.
