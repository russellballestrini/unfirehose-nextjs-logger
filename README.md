# unfirehose

A local-first dashboard for Claude Code power users. Reads your `~/.claude/` session data, normalizes it into SQLite, and gives you a single pane of glass across every project, every agent, every token.

No cloud. No telemetry. Your data stays on your machine.

## Why

Claude Code writes session logs to `~/.claude/projects/` as JSONL files. If you run multiple projects and agents, that directory grows fast — 3GB+, hundreds of sessions, tens of thousands of messages. There's no built-in way to:

- See which project is burning the most tokens right now
- Track equivalent API cost on a Max plan
- Watch agent activity in real time across all projects
- Explore thinking blocks and tool call patterns
- Correlate prompts with git commits
- Get alerted when usage spikes

This tool does all of that.

## Screenshots

See [gallery below](#gallery) or browse [`screenshots/v1/`](screenshots/v1/).

## Features

### Dashboard
Time-range filtered overview (1h to 28d) with:
- Session, message, model, and cost summary cards
- Daily activity chart
- Hour-of-day distribution with automatic sleep detection (bell curve centers on your active hours)
- Day-of-week activity breakdown
- Day x Hour hotspot overlay — see exactly when your agents run hottest
- Model usage donut with per-model cost breakdown
- Dual UTC/local time display on all hour axes

### Live Tailing
SSE-powered real-time view of active sessions. Watch your agents work as they stream responses, make tool calls, and think.

### Usage Monitor
Operational monitoring with:
- Per-minute token timeline (auto-buckets: minute/hour/day based on window)
- Per-project usage breakdown with stacked bars
- Agent Standup — 30-day activity summary per project with recent prompts
- Prompts correlated with git commits (green badge = committed, yellow = uncommitted, orange = unpushed)
- Configurable alert thresholds (per-minute, 5min, 15min, hourly windows)
- Alert history with drill-down detail pages

### Projects
- Project cards with session count, message volume, and 30-day cost
- Expandable project detail with git info, remotes, recent commits, CLAUDE.md preview
- Commit SHAs linked to all upstream remotes (supports multi-remote mirrors across Gitea, GitHub, GitLab)
- Per-project session browser with git branch context
- Full session viewer with message timeline, tool calls, thinking blocks, and token usage

### Thinking Explorer
Browse and search thinking blocks across all sessions. See what your agents are actually reasoning about.

### Token Analysis
Deep token breakdown by model with:
- Input, output, cache read, cache write splits
- Per-model equivalent API cost at 2026 rates
- Tool call frequency analysis
- Content block type distribution

### All Logs
Raw JSONL log browser with filtering and search. When you need to see exactly what happened.

### Blog / Microblog
Built-in jsonblog.org compatible posting system. Write status updates, link external sources, export as `blah.json`. Pulls profile data from JSON Resume if available.

### Settings
Configure alert thresholds, display preferences, and integration settings.

## Stack

| Layer | Tech |
|-------|------|
| Framework | Next.js 15 (App Router) |
| Language | TypeScript |
| Styling | Tailwind CSS v4 |
| Database | better-sqlite3 (local, ~250MB normalized from ~3GB JSONL) |
| Charts | Recharts |
| Data fetching | SWR with auto-refresh |
| Real-time | Server-Sent Events (SSE) |
| File watching | `fs.watch` on JSONL files for auto-ingest |

~11K lines of TypeScript across 42 commits. No external services. No API keys. No Docker. Just `npm install && npm run dev`.

## Quickstart

```bash
git clone https://github.com/russellballestrini/unfirehose.git
cd unfirehose
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

The first load triggers an ingestion of your `~/.claude/` session data into SQLite at `~/.claude/unfirehose.db`. Subsequent ingestions are incremental (byte offset tracking) and triggered automatically by file watcher on JSONL changes.

### Requirements

- Node.js 18+
- An existing `~/.claude/` directory (you need to have used Claude Code at least once)
- That's it

## Architecture

```
~/.claude/projects/          JSONL session files (source of truth)
        │
        ▼
  [file watcher]             fs.watch on active JSONL files
        │
        ▼
  ~/.claude/unfirehose.db   SQLite (normalized: projects → sessions → messages → content_blocks)
        │
        ▼
  Next.js API routes         20+ endpoints serving dashboard, usage, projects, sessions, tokens, alerts
        │
        ▼
  React frontend             SWR auto-refresh, SSE live tailing, Recharts visualization
```

### Database Schema

- **projects** — one row per unique project directory
- **sessions** — one row per session UUID, with git branch snapshot
- **messages** — every JSONL entry (user, assistant, system) with token usage
- **content_blocks** — normalized from message content arrays (text, thinking, tool_use, tool_result)
- **usage_minutes** — pre-aggregated per-minute token rollups for fast spike detection
- **alerts** — triggered alert log with acknowledgment tracking
- **ingest_offsets** — byte offset per file for incremental ingestion

Deduplication via `UNIQUE INDEX ON messages(message_uuid) WHERE NOT NULL` and `INSERT OR IGNORE`.

## Pricing Model

Shows equivalent API cost even on Max plan ($200/mo). Uses 2026 Anthropic API rates:

| Model | Input | Output | Cache Read | Cache Write |
|-------|-------|--------|------------|-------------|
| Opus 4.6/4.5 | $5/MTok | $25/MTok | $0.50/MTok | $6.25/MTok |
| Sonnet 4.6/4.5 | $3/MTok | $15/MTok | $0.30/MTok | $3.75/MTok |
| Haiku 4.5 | $1/MTok | $5/MTok | $0.10/MTok | $1.25/MTok |

## API Routes

| Endpoint | Purpose |
|----------|---------|
| `GET /api/dashboard` | Time-filtered dashboard stats (range=1h/3h/6h/24h/7d/14d/28d) |
| `GET /api/usage` | Token timeline and per-project usage |
| `GET /api/tokens` | Model breakdown with cost calculation |
| `GET /api/stats` | Pre-computed stats cache |
| `GET /api/projects` | Project list with metadata |
| `GET /api/projects/activity` | 30-day agent standup with git-correlated prompts |
| `GET /api/projects/metadata` | Git info, remotes, commits, CLAUDE.md |
| `GET /api/sessions/:id` | Full session replay data |
| `GET /api/live` | SSE stream for real-time tailing |
| `GET /api/alerts` | Alert history and thresholds |
| `GET /api/thinking` | Thinking block search |
| `GET /api/logs` | Raw JSONL log browser |
| `POST /api/ingest` | Trigger manual re-ingestion |
| `GET /api/blog/blah.json` | jsonblog.org feed export |

## Who This Is For

- Claude Code Max plan users running multiple projects and agents
- Developers who want to understand their agent's behavior patterns
- Teams doing daily standups across agent workstreams
- Anyone who wants to see where the tokens go

## Contributing

PRs welcome. The codebase is straightforward Next.js — pick a page, read the API route, improve something.

```bash
npm run test        # run tests
npm run lint        # eslint
npm run build       # production build
```

## License

AGPL-3.0-only

## Origin

Built in ~48 hours by humans and agents working together. 42 commits from first `create-next-app` to full observability platform. The code speaks for itself.

---

## Gallery

### Dashboard
![Dashboard — activity charts, hour distribution, day-of-week, hotspots, model usage](screenshots/v1/dashboard-activity-overview.png)

### Live Session Tailing
![Live view — SSE real-time tailing of active sessions](screenshots/v1/live-session-tailing.png)

### Usage Monitor
![Usage Monitor — token timeline and per-project usage breakdown](screenshots/v1/usage-monitor.png)

### Token Usage Breakdown
![Token Usage — donut charts, model breakdown, tool call frequency](screenshots/v1/token-usage-breakdown.png)

### Projects
![Projects — grid view with session counts and cost per project](screenshots/v1/projects-grid.png)

### Thinking Stream
![Thinking Stream — browse extended thinking blocks with timestamps](screenshots/v1/thinking-stream.png)

### Settings
![Settings — plan tiers, scrobble toggle, alert configuration](screenshots/v1/settings-plans-scrobble.png)
