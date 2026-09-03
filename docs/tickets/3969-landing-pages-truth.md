# 3969: unfirehose.com landing pages — say what ships

**Status:** open
**Project:** unfirehose-nextjs-logger (content lives in ~/git/unsandbox.com — fox approval required to edit)
**Estimated:** 150m
**Todo IDs:** 3969

## Context

The landing pages were written 2026-03-11. 395 commits later the product
they describe has moved, and a few things they promise never existed.
Audit of `unfirehose_{home,clients,screenshots,pricing}.html.heex` against
the codebase, 2026-09-03:

### Claims with no feature behind them → remove

| page | claim | reality |
|---|---|---|
| home | "Repo Archival — register any git repo from any platform. Clone, scan, preserve it. Cross-platform stars and follows included." | no code for stars/follows or cross-platform repo registration; projects come from harness JSONL |
| clients | `pip install unfirehose`, `cargo add unfirehose`, `libunfirehose` | PyPI 404; only `unfirehose-sdks/go` exists on disk. Five "coming soon" markers already on the page — the commands still read as installable |
| screenshots | `training.png`, `usage-infrastructure.png` | training surface removed in 4d0b02e; no such pages in nav |

### True in March, undersold now → rewrite

| page | now says | should say |
|---|---|---|
| home "Works With Your Tools" | lists our own four npm packages | **18 harnesses**: claude-code, uncloseai-cli, agnt, aider, cursor, continue, gemini-cli, hermes-agent, opencode, openai-codex, pi, ollama, vllm, llama.cpp, open-webui, text-generation-webui, fetch — one database, one viewer |
| home "See a Dashboard" cards | Scrobble, Live, Thinking, Permacomputer | add **Refusals** (every throttle/outage across providers + the vendors' own status feeds beside them), **Tokens** (cost split by input/output/cache with a price book), **Usage** (alert rules calibrated from your own history), **Todos** (cross-session kanban with dependency graph) |
| home "What Gets Archived" | thought threads, diffs, todos, repo archival, live feed | thought threads (incl. sealed-reasoning disclosure), tool calls + diffs, todos, refusals, token cost — drop repo archival |
| home hero | "Free forever. Runs on localhost." | still true — keep. Add the rename-resilient project identity line: "rename a repo, keep its history" |
| clients | four SDK cards | one card: `@unturf/unfirehose` (TS) + `go` SDK; everything else: "write JSONL to the unfirehose/1.0 spec — 18 adapter docs" with a link to the schema |
| clients | `git clone …/uncloseai.com` for uncloseai-cli | repo is `uncloseai-cli`; verify the URL |

### Screenshots

All 15 are 2026-03-11. Reshoot from localhost:3000 with `chromium
--headless --screenshot` at 1440×900, dark theme, same filenames; add
`refusals.png` (both tabs) and `tokens.png` cost split; delete
`training.png` and `usage-infrastructure.png`. Needs the dashboard to have
real data in view — it does on this box.

### Pricing

$0 / $14 per seat / $420 per month. The cloud ticket is marked complete;
whether the paid tiers are purchasable today is fox's to confirm. Not
touching prices without that.

### Side finding

npm has `@unturf/unfirehose-schema` and `-ui` at 1.1.2; the repo is at
1.2.0. A publish is owed regardless of this ticket.

## Plan

1. Reshoot screenshots (unfirehose side, no approval needed) and stage
   them in `unsandbox.com/priv/static/images/screenshots/`.
2. Edit the four templates per the tables above. Copywriting rules of
   the house: prefer "our", avoid "the", say "machine learning".
3. `mix compile --warnings-as-errors`, push → CI deploy, verify
   `/version`, walk each page live.
4. Publish schema/ui 1.2.0 to npm from this repo.

## Notes

- Nothing here changes routes; the 410 for /blog stays.
- Terms, privacy, styleguide untouched.
