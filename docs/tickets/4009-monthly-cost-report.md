# 4009: Monthly cost report — CSV and PDF for expense claims

**Status:** open — plan awaiting fox
**Project:** unfirehose-nextjs-logger
**Estimated:** ~1 day (free tier); branded tier depends on decision 4
**Todo IDs:** none (roadmap item 13, proposed by fox 2026-10-22)

## Context

An expense claim wants one document per month: what was spent, on what, with
a total that reconciles. Everything that goes into it is already in our
database or settings; nothing assembles it for a month or exports it.

Sources, as they exist today:

| Line | Source | Basis |
|---|---|---|
| Model API spend | `messages` priced through our ledger (`costForUsageRows`, `pricing.ts`), `observed_cost_usd` where a provider stated a figure | per call, by model / provider / project |
| Subscriptions | `/api/usage/plan` (`PLAN_COST` by `rateLimitTier`) | flat monthly |
| Extra usage (card charges) | `lib/extra-usage.ts` | as billed |
| Self-hosted electricity | `mesh_snapshots` (+ `_15m` past 28 days) watts integrated × per-node rate (`getKwhRate`, `electricity_rate_<host>`) — the same integral the dashboard uses | measured |
| ISP / hosting | per-node econ in settings (`mesh-score.ts`, `getEffectiveIspCost` splits a shared uplink) | flat monthly |

Each line carries its basis — **stated** (provider's own figure), **priced**
(our ledger × tokens), **measured** (watts × rate), **flat** (configured) —
because an approver asks "where does this number come from" and the answer
differs per line.

## Plan

1. **Core builder** — `packages/core/cost-report.ts`:
   `buildMonthlyCostReport(db, { month: 'YYYY-MM', tz })` → `{ month, period,
   lines[], totals, byProject, byModel, generatedAt, ledgerAsOf }`. Pure over
   the database plus the settings it is handed; month boundaries in the
   user's timezone, passed in by the route (`lib/local-time` converts
   timestamps but has no month boundaries yet; this adds them). Tests against
   `createTestDb` with seeded messages, snapshots and settings, including a
   month that crosses the 28-day rollup boundary.
2. **Route** — `GET /api/reports/monthly?month=2026-10&format=json|csv|pdf`.
   CSV is one row per line item plus a totals row, RFC 4180, `Content-Disposition:
   attachment; filename=unfirehose-costs-2026-10.csv`. Past months are
   immutable once closed → store the built report (precomputed-payload
   pattern) so a re-export matches what was filed; the current month builds
   live.
3. **Page** — `/reports`: month picker (defaults to last month), summary
   (total, by category, by project, by model), a line-item table, and
   "Download CSV" / "Download PDF". Added to the nav and sitemap; documented
   in llms.txt (its test will insist).
4. **PDF** — see decision 1.
5. **Docs** — llms.txt, CLAUDE.md key pages, a short section in
   `docs/architecture/precomputed-payloads.md` if stored.

## Decisions for fox

1. **How to make the PDF.**
   - (a) A print stylesheet on `/reports` + the browser's "Save as PDF". Zero
     dependencies, looks like the page, can't be fetched by curl/cron.
   - (b) Server-side with `pdf-lib` (pure JS, no native build, ~1 MB) — a
     real `?format=pdf` download, scriptable from cron.
   - Recommend **(b)**: an expense claim is a file you attach, and a cron that
     mails last month's report on the 1st becomes possible.
2. **Project grouping** — bill by project (folded project list, as the
   Projects page) as well as by model? An approver often wants "which client".
   Recommend yes, as a second table.
3. **Currency** — USD only, or convert using `packages/ui` `useCurrency`'s
   rates? Converted figures need the rate and its date printed. Recommend USD
   with an optional converted column.
4. **Branded (paid) version** — this is AGPL software running on the user's
   own machine, so a local feature flag is an honour system, not a paywall.
   Options: (a) branding (logo, company name, address, claim reference) is
   free here and the *paid* thing is unfirehose cloud generating and
   mailing it; (b) a signed licence key checked locally; (c) branded
   templates sold as a separate package. Needs your call before any of it
   is built — the free tier above does not depend on it.
5. **What counts as a cost** — include subscriptions and ISP (true monthly
   spend) or only usage-driven lines? Recommend all, each in its own
   category so a claim can tick only what it covers.

## Done when

- `/reports` shows any past month and the current month to date, totals
  reconciling with the Tokens page for the same window.
- CSV and PDF download for that month; a closed month re-exports byte-identical.
- Core builder and route tested; `make typecheck` and the llms.txt test pass.
