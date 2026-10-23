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
