# 3968: Status poller — every platform a person depends on, on one page

**Status:** done
**Project:** unfirehose-nextjs-logger
**Estimated:** 180m
**Todo IDs:** 3968
**Blocked by:** —

## Context

2026-09-03: chatgpt.com down, grok web down, Claude returning 529 all
morning. Our refusals page shows what *we* hit; nothing shows what the
vendors themselves are saying, so "is it me or them" still means opening
six tabs. A poller that reads every status page a person uses — and sits it
beside our own refusal counts — answers that in one place.

### What is out there (probed 2026-09-03 15:04Z)

| vendor | host | backend | machine-readable | robots.txt |
|---|---|---|---|---|
| Anthropic | status.claude.com | Atlassian Statuspage | `/api/v2/status.json`, `/api/v2/summary.json`; `/history.atom` | **Disallow: /api/** — feed allowed |
| OpenAI | status.openai.com | Atlassian Statuspage | same | no robots.txt (404) |
| GitHub | githubstatus.com | Atlassian Statuspage | same | **Disallow: /api/** — feed allowed |
| Cloudflare | cloudflarestatus.com | Atlassian Statuspage | same | allows all |
| xAI / Grok | status.x.ai | unknown — every path returns a Cloudflare challenge page | none found | 404 |
| OpenRouter | status.openrouter.ai | not Statuspage (page mentions "statusPage" JS; `/api/v2` and `/summary.json` 404) | to identify | allows |
| Nous | status.nousresearch.com | does not resolve | — | — |
| ours | undefect.com, unsandbox.com, api.unsandbox.com, my.remarkbox.com, my.makepostsell.com | `/version` JSON (BLACKOPS.md) | yes | ours |

Live right now: Anthropic *minor — Minor Service Outage*, OpenAI *minor —
Partial System Degradation*, GitHub *Partially Degraded*, Cloudflare *Minor
Service Outage*. Four vendors degraded at once is itself a finding.

### Decision needed: the Statuspage JSON is robots-disallowed on two hosts

Atlassian's default robots.txt disallows `/api/`. Our rule: disallowed
means stop and ask. Options:

1. **Feeds only** (`/history.atom`, allowed everywhere). Gives incidents
   with titles and timestamps; current indicator inferred from unresolved
   incidents. Loses per-component state (e.g. "Claude Sonnet 5: degraded").
2. **JSON where allowed, feed where not.** Cloudflare and OpenAI via JSON;
   Anthropic and GitHub via feed. Mixed fidelity.
3. **JSON everywhere.** The endpoint exists for programmatic status
   consumers and Statuspage documents it publicly; the robots line is a
   crawler-indexing default, not an access policy. Still a disallow.

Recommendation: **1 to start**, with the robots check built into the poller
so any target that later disallows its path flips to `blocked_by_robots`
on the page instead of being fetched. Upgrade to 2 only if fox says so.

## Plan

1. **Registry** — `packages/core/status-pages.ts`: targets
   `{ id, name, url, kind: 'statuspage-feed' | 'statuspage-json' | 'version' | 'http', provider? }`.
   Defaults above; user additions/removals in settings `status_targets`.
   `provider` links a vendor to our refusals provider/upstream names
   (anthropic, openai, openrouter, x-ai …).
2. **Poller** — `pollStatusTarget()` returns
   `{ indicator: none|minor|major|critical|unknown|blocked_by_robots|unreachable, description, incidents[], httpStatus, latencyMs }`.
   Fetches robots.txt per host once a day, caches, refuses disallowed paths.
   Timeouts 8s, no retries — a slow status page is data.
3. **Storage** — `status_polls` table, tiered like mesh: 60s raw for 28d,
   hourly rollup forever. Worker timer `STATUS_POLL_INTERVAL_MS = 60_000`.
4. **Alerts** — indicator crossing to major/critical, or our own /version
   unreachable, writes an `alerts` row (`alert_type: status_page`) so the
   existing banner carries it. Auto-resolve note when it clears.
5. **UI** — `/status` under Monitor: one card per target (indicator
   colour, description, latest incident title, 24h indicator strip), sorted
   worst first. On `/rate-limits`, a line per provider with events in the
   window: *"status.claude.com: Minor Service Outage since 13:22Z"* —
   vendor's word next to our count.
6. **API** — `GET /api/status` (current), `GET /api/status/history?target=&hours=`,
   `POST/DELETE /api/status/targets`.

## Notes

- xAI: status.x.ai sits behind a Cloudflare challenge; no feed found. Ship
  it as `unreachable` with a note rather than pretend. If fox knows a
  machine path, add it.
- OpenRouter: identify the vendor (Better Stack? Instatus?) during step 1;
  both expose JSON on allowed paths.
- Never fetch from a browser tab (CORS, and it would leak the viewer's IP
  to every vendor); the worker polls, the page reads our table.
- Eight Forms check: this is intellectual capital made visible — no rent,
  no extraction; polling once a minute per vendor is polite.

## Done — 2026-09-03

Built as a **tab on /rate-limits** ("What vendors admit"), not a page — fox:
to the person waiting, the provider falling over and the provider refusing
us are one event. Our own /version endpoints dropped from scope: unfirehose
measures language models, not our fleet.

- `packages/core/status-pages.ts`: targets (defaults + settings
  `status_targets` add/remove), robots.txt per host cached a day and
  honoured, Atom parsing for Atlassian Statuspage (claude) and incident.io
  (openai — CDATA, `<b>Status: X</b>`), indicator inferred from open
  incidents, `status_polls` raw 28d + hourly worst-light rollup.
- Worker polls every 60s; `POST /api/rate-limits/status {action: poll}` on
  demand. `GET` current + `?history=<id>&hours=24`.
- Refusals tab shows a one-line strip per vendor that appears in the view.
- xAI: fox pointed at status.x.ai; its <head> advertises `/feed.xml` (RSS,
  custom Next.js site, robots absent). Only the root is Cloudflare-walled.
  Parser learned RSS items with `Status:` / `Severity:`; the vendor's own
  severity word decides major. OpenRouter (not Statuspage) still reads
  `unreachable` with a note.
- Option 1 from the robots decision (feeds only) is what shipped.
