# unfirehose Market Sizing

**2026-03-05** | agent blackops

## The Product

unfirehose is last.fm for building software. Local dashboard ingests Claude Code / uncloseai / Fetch session data, normalizes it into SQLite, and optionally scrobbles coding activity to a public social feed. Free tier covers most needs. Paid tiers add social features, unlimited history, and enterprise data pipes.

## Claude Code: The Primary Market

Claude Code reached **$1B ARR** in six months (GA May 2025, milestone Nov 2025). It is the fastest-growing developer tool in history.

- **4% of all GitHub public commits** are now authored by Claude Code (SemiAnalysis, Feb 2026)
- Projected to reach **20%+ of daily commits** by end of 2026
- Enterprise adoption: Uber, Salesforce, Accenture, Spotify, Rakuten, Snowflake, Novo Nordisk, Ramp
- Anthropic's share of enterprise production deployments: near-zero (Mar 2024) to **44%** (Jan 2026)

### Estimating Claude Code CLI Users

Anthropic does not publish CLI user counts. Working backwards from revenue:

| Assumption | Calculation | Estimate |
|---|---|---|
| $1B ARR, avg $20/mo (Pro-heavy mix) | $1B / ($20 x 12) | ~4.2M subscribers |
| $1B ARR, avg $50/mo (Max/Enterprise mix) | $1B / ($50 x 12) | ~1.7M subscribers |
| CLI power users (generate JSONL locally) | 30-50% of subscriber base | **500K - 2M users** |

The direct addressable market for unfirehose is the subset who use Claude Code's CLI (not the web chat). These users generate local session JSONL files, which is what the ingestion pipeline reads.

**Working estimate: 500K - 2M active Claude Code CLI users generating session data.**

## The Broader ML Coding Tool Market

| Tool | Users / Revenue | Notes |
|---|---|---|
| GitHub Copilot | 20M cumulative, 4.7M paid, 42% market share | Inside 90% of Fortune 100 |
| Cursor | 1M+ DAU, $500M+ ARR, $29B valuation | 4.9/5 user rating |
| Claude Code | $1B ARR, 4% of GitHub commits | Terminal-native, agent-first |
| Market overlap | 59% of developers use multiple tools | Users stack, not switch |

Total professional developers worldwide: **~30M** (GitHub).
78% of dev teams adopted ML code assistants in 2025.

The global ML coding assistant market: **$6.7B in 2026**, forecast **$47.3B by 2034** (24% CAGR).

## unfirehose Revenue Model

### Tiers

| Plan | Price | Target |
|---|---|---|
| Free | $0 | Local dashboard, ingestion, social graph, follow developers, 7-day firehose window |
| Starter | $14/mo ($97/yr) | Public profile, unlimited scrobble history, status posts, API access |
| Ultra | $420/mo | S3 sync, webhooks, KYC verified, unlimited hoses, SLA |

Free covers most individual needs. The social graph is free to maximize network effects. Starter monetizes public identity and unlimited history. Ultra targets labs and teams needing full data pipes.

### Conversion Assumptions

Developer tool freemium conversion benchmarks: 2-7% (GitHub, JetBrains, Vercel precedent).

| Scenario | Total Users | Free (%) | Starter | Ultra | Monthly Revenue | ARR |
|---|---|---|---|---|---|---|
| Conservative | 500K | 97% | 14,250 | 750 | $514K | $6.2M |
| Mid | 1M | 95% | 45,000 | 5,000 | $2.7M | $32.8M |
| Aggressive | 2M | 93% | 126,000 | 14,000 | $7.6M | $91.9M |

### Revenue Sensitivity

The ultra tier dominates revenue despite tiny adoption. At $420/mo, 750 ultra users generate the same revenue as 22,500 starter users. Enterprise/lab conversion is the lever.

## Growth Vectors

1. **Claude Code's commit share doubling** from 4% to 20% by EOY 2026 expands the CLI user base proportionally.
2. **Social graph on free tier** removes the biggest friction to network adoption. Users join, follow each other, see activity. Some convert for unlimited history and public profiles.
3. **Multi-harness ingestion** (Claude Code + uncloseai + Fetch + future tools) means unfirehose is tool-agnostic. As developers stack tools, unfirehose becomes the single pane of glass.
4. **Cross-project todo system** creates daily-driver stickiness beyond passive monitoring.
5. **AGPL-3.0 self-host** builds trust. Enterprise users self-host first, then pay for managed firehose infrastructure.

## Risks

- Anthropic could build session analytics into Claude Code directly (platform risk).
- The 7-day free window may be too generous or too restrictive. Needs calibration.
- Ultra pricing ($420/mo) may deter small teams. Consider a Team tier at $50-100/seat.
- Social features require critical mass. Cold-start problem until network reaches ~10K active profiles.

## Comparable Exits

| Company | What | Revenue at Exit | Outcome |
|---|---|---|---|
| WakaTime | Coding time tracking | ~$5M ARR | Independent, profitable |
| LinearB | Dev analytics | ~$20M ARR | $100M+ raised |
| Pluralsight (Flow) | Engineering metrics | Part of $3.5B acquisition | Acquired by Vista |
| Last.fm | Music scrobbling | ~$10M ARR | Acquired by CBS for $280M |

## Summary

The floor is a $6M ARR niche tool for Claude Code power users. The ceiling is a $90M+ ARR social platform for the 30M developers adopting ML coding tools. The free social graph is the wedge. The scrobble feed is the hook. The data pipes are the monetization.

**Total addressable market: 500K-2M users today, tracking Claude Code's growth curve.**
**Realistic year-one target: 50K users, 2,500 paid, $500K ARR.**
