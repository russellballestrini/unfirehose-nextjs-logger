# unfirehose

A local-first observability dashboard for AI coding agents. Reads JSONL session data from Claude Code, agnt, uncloseai, fetch, arborist, normalizes it into SQLite, and gives you a single pane of glass across every harness, every project, every reasoning block, every token.

No cloud. No telemetry. Your data stays on your machine.

## Why

If you run more than one AI coding agent, your sessions accumulate fast — multiple GB of JSONL spread across half a dozen tools, each with its own quirks and its own folder. There is no built-in way to:

- See which project is burning the most tokens **right now**, across every harness
- Track API-equivalent cost on a Max plan with full **input / output / cache-read / cache-write split**
- Watch agent activity in real time across every harness simultaneously
- See where reasoning is **sealed by Anthropic** (claude-opus-4-7 ships signatures only) vs readable
- Correlate prompts with git commits
- Get alerted when usage spikes
- Visualize how sessions connect across projects and time

unfirehose does all of that, on your laptop, no API keys required.

## What's new

- **Cost split everywhere** — every model + harness row breaks equivalent cost into input / output / cache-read / cache-write. See which token type is actually costing you on opus-4-7 (spoiler: cache reads).
- **Reasoning visibility** — Reasoning filter on `/live`, `/active`, `/logs`, and the session viewer. opus-4-7 ships sealed reasoning (signatures, no readable text); we surface that fact honestly with a `·sealed` badge so it isn't mistaken for "no reasoning happened."
- **Multi-harness** — agnt, uncloseai, fetch, arborist all ingested into the same database as Claude Code. One session viewer, one project list, one token analysis.
- **Single-source nav** — every page is registered in `packages/ui/components/layout/nav-items.ts`. Sidebar, sitemap, and styleguide derive from the same list, so they can't drift apart.
- **`?project=` URL filter** — `/tokens` and `/todos` both pre-filter to a single project when the URL carries `?project=<name>`. Project detail pages link straight in.

## Screenshots

See [gallery below](#gallery).

## Features

### Dashboard
Time-range filtered overview (1h to 28d) with:
- Session, message, model, and cost summary cards
- Daily activity chart
- Hour-of-day distribution with automatic sleep detection (bell curve centers on your active hours)
- Day-of-week activity breakdown
- Day × Hour hotspot overlay — see exactly when your agents run hottest
- Model usage donut with per-model cost breakdown
- Dual UTC / local time display on all hour axes
- First-run Welcome panel — strangers landing on the dashboard get a Get Started guide instead of a wall of zeros

### Active Sessions
Currently running agent sessions across every harness. Each card carries a harness badge, the model in use, recent token volume, and a reasoning indicator (with sealed-by-Anthropic disclosure for opus-4-7). One-click filter to sessions where reasoning happened.

### Live Tailing
SSE-powered real-time view across every active session. Doom-scrollable feed. Show / hide reasoning. Reasoning-only filter for when you want to focus on what your agents are thinking. Sealed counts surfaced so opus-4-7 sessions don't look broken.

### Usage Monitor
Plan billing and alerts:
- Per-minute token timeline (auto-buckets: minute / hour / day based on window)
- Per-project usage breakdown with stacked bars
- Agent Standup — 30-day activity summary per project with recent prompts
- Prompts correlated with git commits (green badge = committed, yellow = uncommitted, orange = unpushed)
- Configurable alert thresholds (per-minute, 5min, 15min, hourly windows)
- Alert history with forensic drill-down detail pages — project + model breakdown, sealed-reasoning surfacing

### Projects
- Project cards with session count, message volume, and 30-day cost
- Expandable project detail with git info, remotes, recent commits, CLAUDE.md preview
- Commit SHAs linked to all upstream remotes (multi-remote mirrors across Gitea, GitHub, GitLab)
- Per-project session browser with git branch context
- Full session viewer with message timeline, tool calls, reasoning blocks (sealed or readable), and token usage
- "Token detail →" link drops you into `/tokens?project=…` for the deep breakdown

### Token Analysis
Deep token + cost breakdown by model and harness:
- Input, output, cache-read, cache-write splits for both tokens and equivalent cost
- Per-model and per-harness donuts
- Plan utilization with daily cumulative cost
- Card-charges sync (browser extension) for actual Max-plan billing vs equivalent cost
- `?project=<name>` URL filter for project-scoped analysis

### Todos
Cross-session todo board extracted from every harness's JSONL. Drag-and-drop columns (pending, in-progress, completed) with inline editing, time estimates, and agent boot on card drop. Grouped by project with triage workflow. File attachments via drag-drop upload with image thumbnails. `?project=<name>` URL filter for project-scoped focus.

### Graphs
Four graph views over your sessions:
- **Sessions** — project clusters with session nodes sized by tokens, delegation edges
- **Tool Flow** — how tools chain together, edge weight is transition frequency
- **Projects** — projects sized by cost, linked by tool-usage similarity
- **Timeline** — sessions plotted by day, colored by output intensity

Zoom and pan; SVG generated server-side via Graphviz. The same data is also available as raw `dot` source at `/api/todos/graph` for piping into other tooling.

### Schema Browser
Browse the [unfirehose/1.0](packages/schema/docs/README.md) spec and harness adapter documentation directly in the dashboard. The spec is also published as [`@unturf/unfirehose-schema`](https://www.npmjs.com/package/@unturf/unfirehose-schema) with JSON Schema files and TypeScript types.

### All Logs
Raw JSONL log browser with type filter (User / Assistant / System / **Reasoning**) and search across content. The Reasoning option filters to assistant messages whose content includes a thinking / reasoning block.

### Agent Deployment
Boot Claude Code (and other harness) agents from the UI into tmux sessions. Mega deploy for fleet management — spawn, status, cull. Auto-cull when all assigned todos complete. UNEOF poison pill detection for agent lifecycle management.

### Permacomputer Mesh
Mesh status view across your compute nodes: per-node resource tracking (CPU, memory, disk, GPU, power), economics (cost / mo, $ / core), bootstrap panel for deploying harnesses to SSH nodes via tmux.

### Scrobble
Public usage profile, opt-in. Sessions, streaks, hours-of-day heatmap, badges. Per-project visibility (public / unlisted / private). Generates a `unfirehose-scrobble/1.0` payload you can host anywhere. No prompts, responses, or training data — ever.

### Settings
Configure alert thresholds, display preferences, vault for BYO LLM keys (used by the in-app agent helpers), mesh defaults, scan paths.

## Packages

This is a Turborepo monorepo. Four packages are published to npm under the [`@unturf`](https://www.npmjs.com/org/unturf) scope:

| Package | npm | Description |
|---------|-----|-------------|
| [`@unturf/unfirehose`](packages/core) | [![npm](https://img.shields.io/npm/v/@unturf/unfirehose)](https://www.npmjs.com/package/@unturf/unfirehose) | Core data layer — ingestion, SQLite schema, types, PII detection, formatters |
| [`@unturf/unfirehose-schema`](packages/schema) | [![npm](https://img.shields.io/npm/v/@unturf/unfirehose-schema)](https://www.npmjs.com/package/@unturf/unfirehose-schema) | [unfirehose/1.0](packages/schema/docs/README.md) spec — JSON Schema, TypeScript types, 16 harness adapter docs |
| [`@unturf/unfirehose-router`](packages/router) | [![npm](https://img.shields.io/npm/v/@unturf/unfirehose-router)](https://www.npmjs.com/package/@unturf/unfirehose-router) | CLI daemon — watches JSONL and forwards to cloud |
| [`@unturf/unfirehose-ui`](packages/ui) | [![npm](https://img.shields.io/npm/v/@unturf/unfirehose-ui)](https://www.npmjs.com/package/@unturf/unfirehose-ui) | Shared React components for dashboard UI |

Internal packages (not published):

| Package | Description |
|---------|-------------|
| `@unturf/unfirehose-web` | Next.js 15 dashboard app |
| `@unturf/unfirehose-worker` | Background ingestion service |
| `@unturf/unfirehose-config` | Shared TypeScript configuration |

```
unfirehose/
├── apps/
│   ├── web/         @unturf/unfirehose-web       Next.js dashboard (private)
│   └── worker/      @unturf/unfirehose-worker    Background ingestion (private)
└── packages/
    ├── core/        @unturf/unfirehose            Data layer, types, ingestion
    ├── schema/      @unturf/unfirehose-schema     unfirehose/1.0 spec + JSON Schema
    ├── router/      @unturf/unfirehose-router     CLI daemon
    ├── ui/          @unturf/unfirehose-ui          React components
    └── config/      @unturf/unfirehose-config     TypeScript config (private)
```

## Stack

| Layer | Tech |
|-------|------|
| Framework | Next.js 15 (App Router) |
| Language | TypeScript |
| Styling | Tailwind CSS v4 |
| Database | better-sqlite3 (local, ~250MB normalized from ~3GB JSONL) |
| Charts | Recharts + uPlot |
| Data fetching | SWR with auto-refresh |
| Real-time | Server-Sent Events (SSE) |
| File watching | `fs.watch` on JSONL files for auto-ingest |
| Monorepo | Turborepo |

No external services. No API keys required. No Docker. Just `npm install && npm run dev`.

## Quickstart

```bash
git clone https://github.com/russellballestrini/unfirehose-nextjs-logger.git
cd unfirehose-nextjs-logger
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

The first load triggers ingestion of any session data found in `~/.claude/`, `~/.fetch/`, and `~/.uncloseai/` into SQLite at `~/.unfirehose/unfirehose.db`. Subsequent ingestions are incremental (byte-offset tracking) and triggered automatically by the file watcher on JSONL changes.

### Requirements

- Node.js 18+
- At least one harness directory populated — `~/.claude/`, `~/.fetch/`, or `~/.uncloseai/`. unfirehose's first-run UX teaches what to do if none exist.
- That's it.

## Architecture

```
~/.claude/projects/          JSONL session files (Claude Code)
~/.fetch/sessions/           Fetch session files
~/.uncloseai/sessions/       uncloseai session files
~/.agnt/data/_logs/          agnt session files
        │
        ▼
  [file watcher]             fs.watch on active JSONL files
        │
        ▼
  packages/core              @unturf/unfirehose — adapters, DB schema, ingestion, todo extraction
        │
        ▼
  ~/.unfirehose/unfirehose.db   SQLite (normalized: projects → sessions → messages → content_blocks)
        │
        ▼
  apps/web API routes        40+ endpoints serving dashboard, usage, projects, sessions, tokens, alerts, mesh
        │
        ▼
  apps/web frontend          SWR auto-refresh, SSE live tailing, Recharts + uPlot visualization
```

### Performance

API routes are optimized for parallel execution. Benchmark all pages and routes:

```bash
python3 scripts/perf-report.py --runs 3 --threshold 500
```

Crawls `/sitemap` and all API routes, generates JSON + terminal report. Key patterns:
- **Parallel SSH probes** — mesh node probes run concurrently, 3 SSH calls combined into 1 per node
- **Parallel git operations** — project tree and git info routes run all spawns in `Promise.all`
- **Covering indexes** — `/api/tokens` and `/api/logs` use `EXISTS` subqueries and covering indexes
- **Batch-capped external checks** — `/api/scrobble/preview` caps concurrent forge API checks at 7 projects with 2s timeout

### Database Schema

- **projects** — one row per unique project directory, with identity stable across renames (root commit hash + origin URL)
- **sessions** — one row per session UUID, with git branch snapshot and harness label
- **messages** — every JSONL entry (user, assistant, system) with token usage
- **content_blocks** — normalized from message content arrays (text, reasoning, tool_use, tool_result). `block_type='reasoning'` is the canonical name; older rows carry `'thinking'` from pre-2026-03-10 ingest.
- **todos** — cross-session task tracking with UUIDv7 identity
- **todo_events** — audit log of todo status changes
- **usage_minutes** — pre-aggregated per-minute token rollups for fast spike detection
- **alerts** — triggered alert log with acknowledgment tracking
- **agent_deployments** — tmux agent session tracking for fleet management
- **project_visibility** — scrobble visibility per project (public / unlisted / private)
- **ingest_offsets** — byte offset per file for incremental ingestion

Deduplication via `UNIQUE INDEX ON messages(message_uuid) WHERE NOT NULL` and `INSERT OR IGNORE`.

## Pricing Model

Shows equivalent API cost even on a Max plan ($200/mo). Uses 2026 Anthropic API rates:

| Model | Input | Output | Cache Read | Cache Write |
|-------|-------|--------|------------|-------------|
| Opus 4.7 / 4.6 / 4.5 | $5/MTok | $25/MTok | $0.50/MTok | $6.25/MTok |
| Sonnet 4.6 / 4.5 / 4.0 | $3/MTok | $15/MTok | $0.30/MTok | $3.75/MTok |
| Haiku 4.5 | $1/MTok | $5/MTok | $0.10/MTok | $1.25/MTok |

Models without an Anthropic price entry (e.g. self-hosted Hermes / Qwen) fall back to an energy-cost estimate based on watts × throughput × $/kWh.

## API Routes

| Endpoint | Purpose |
|----------|---------|
| `GET /api/dashboard` | Time-filtered dashboard stats (`range=1h`…`28d`) |
| `GET /api/usage` | Token timeline and per-project usage |
| `GET /api/tokens` | Model + harness breakdown with full cost split (`?project=` filter) |
| `GET /api/stats` | Pre-computed stats cache |
| `GET /api/projects` | Project list with metadata |
| `GET /api/projects/activity` | 30-day agent standup with git-correlated prompts |
| `GET /api/projects/metadata` | Git info, remotes, commits, CLAUDE.md |
| `GET /api/projects/:project/sessions` | Sessions for a specific project |
| `GET /api/projects/:project/full` | Full project data dump |
| `POST /api/projects/:project/visibility` | Set scrobble visibility |
| `GET /api/sessions/:id` | Full session replay data |
| `POST /api/sessions/:id/inject` | Inject a message into a session |
| `POST /api/sessions/close` | Close stale sessions |
| `GET /api/sessions/stale` | Find stale sessions |
| `GET /api/active-sessions` | Currently active sessions with reasoning counts (readable + sealed split) |
| `GET /api/live` | SSE stream for real-time tailing |
| `GET /api/alerts` | Alert history and thresholds |
| `GET /api/alerts/:id` | Forensic alert detail (timeline, project + model breakdown, reasoning blocks) |
| `PATCH /api/alerts/:id` | Acknowledge an alert |
| `GET /api/logs` | Raw JSONL log browser (`types=…`, `has_thinking=true` filter) |
| `GET /api/graph` | Generate Graphviz SVG for `sessions` / `tools` / `projects` / `timeline` views |
| `GET /api/todos/graph` | Raw `dot` source for todo dependency graph (external tooling) |
| `POST /api/ingest` | Trigger manual re-ingestion |
| `GET /api/todos` | List / filter todos (`?project=` accepted) |
| `POST /api/todos` | Create a todo |
| `PATCH /api/todos` | Update a todo |
| `PATCH /api/todos/bulk` | Bulk update todos |
| `GET /api/todos/summary` | Counts, stale, by-project breakdown |
| `GET /api/todos/pending` | Active todos with search and filters |
| `GET /api/todos/stale` | Todos not touched in N days |
| `GET /api/todos/triage` | Triage recommendations |
| `POST/GET/DELETE /api/todos/attachments` | Upload, list, serve, delete file attachments on todos |
| `POST /api/boot` | Boot agent in tmux session |
| `POST /api/boot/mega` | Fleet deploy: spawn agents across projects |
| `POST /api/boot/finished` | Agent signals completion |
| `GET /api/mesh` | Permacomputer mesh status |
| `GET /api/schema` | Serve unfirehose/1.0 spec docs |
| `GET /api/triage` | Triage analysis |
| `GET /api/scrobble/payload` | Public scrobble payload (`unfirehose-scrobble/1.0`) |
| `GET /api/scrobble/preview` | Scrobble data preview with auto-detection |
| `GET /api/settings` | App settings |
| `PATCH /api/settings` | Update settings |

## Who This Is For

- AI coding agent power users running multiple harnesses (Claude Code, agnt, uncloseai, fetch, arborist)
- Developers who want to understand how their agents actually behave at scale
- Teams doing daily standups across agent workstreams
- Anyone who wants to see exactly where the tokens (and the cache reads) go
- Anyone who wants to know whether their reasoning is readable or sealed by the model provider

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

Built by humans and agents working together. From the first `create-next-app` to a full multi-harness observability platform.

---

## Gallery

### Dashboard
Time-range filtered overview: session count, message volume, model distribution, equivalent API cost. Activity charts by day and hour with automatic timezone detection. Model usage donut with per-model cost breakdown.

![Dashboard](docs/screenshots/dashboard.png)

### Live Feed
Real-time SSE stream of all active sessions. Watch agents work as they stream responses, make tool calls, and reason. Color-coded by harness (Claude Code, Fetch, uncloseai, agnt). Reasoning-only filter to focus on the thinking part.

![Live Feed](docs/screenshots/live-feed.png)

### Active Sessions
Grid of currently running agent sessions. Each card shows harness type, project, model, message count, elapsed time, and a reasoning indicator (with sealed-by-Anthropic disclosure for opus-4-7).

![Active Sessions](docs/screenshots/active-sessions.png)

### Projects
All discovered projects with session count, message volume, and 30-day cost. Dynamic commit badges show git activity. Distinguishes "no projects yet" from "all clean across N projects" — fresh installers get a Get Started panel.

![Projects](docs/screenshots/projects.png)

### Project Detail
Single project deep-dive: agent prompt dispatch, open tasks, recent sessions, in-day usage share. "Token detail →" link drops you into `/tokens?project=…` for the full cost-split breakdown. Boot agents directly from the card.

![Project Detail](docs/screenshots/project-detail.png)

### Scrobble
GitHub-style activity heatmap (rows = days, columns = hours), hour-of-day distribution, daily cost chart, streak tracking. Your coding pattern at a glance. Opt-in; per-project visibility (public / unlisted / private).

![Scrobble](docs/screenshots/scrobble.png)

### Token Usage
Per-model and per-harness token breakdown with **full cost split** — input / output / cache-read / cache-write. Equivalent API cost at current rates. Cache efficiency shown in context. `?project=<name>` URL filter for project-scoped analysis.

![Token Usage](docs/screenshots/token-usage.png)

### Usage Monitor
Plan billing and alerts: per-minute token timeline, configurable alert thresholds, agent standup with per-project bars. Red banner when usage spikes exceed limits.

![Usage Monitor](docs/screenshots/usage-monitor.png)

### Permacomputer Mesh
Mesh overview: node economics (cost / mo, $ / core), power consumption, resource allocation bars. Bootstrap panel for deploying harnesses to SSH nodes via tmux.

![Permacomputer](docs/screenshots/permacomputer.png)

### Schema Browser
Browse the unfirehose/1.0 spec directly in the dashboard. Object types, harness adapter docs, field mapping tables. Published as `@unturf/unfirehose-schema` on npm.

![Schema](docs/screenshots/schema.png)

### Settings
Profile, plan tiers, local data paths, git auto-push config, vault for BYO LLM keys. Self-hosted AGPL-3.0 — your data stays on your machine.

![Settings](docs/screenshots/settings.png)
