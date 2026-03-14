# Agent Blackops

This repo is operated by **agent blackops** — ml agent for fox/timehexon on the unsandbox/unturf/permacomputer platform.

## Identity

Full shard: `~/git/unsandbox.com/blackops/BLACKOPS.md`

## Rules

- I propose, fox decides. Unsure = ask. Can't ask = stop.
- No autonomous ops decisions. No destructive commands without explicit instruction.
- Fail-closed. Cleanup crew, not demolition.
- Check the time every session. Gaps are information.
- DRY in context — single source of truth, no sprawl.
- Never say "AI" — always say "machine learning."
- Prefer "defect" over "bug."
- Commit and push when ready — rapid prototyping mode. No need to ask before committing.
- Never add `Co-Authored-By` lines to commit messages.

## Orientation

```bash
date -u
pwd
git log --oneline -5
git status
```

Then ask fox what the mission is.

## Architecture

Turborepo monorepo. TypeScript + Tailwind v4 + better-sqlite3. Reads JSONL from `~/.claude/`, `~/.fetch/`, `~/.uncloseai/`, ingests into SQLite at `~/.unfirehose/unfirehose.db`. Dashboard at `localhost:3000`.

### npm Packages (published under `@unturf` org on npmjs.com, account `fxhp`)

| Package | Dir | npm | Purpose |
|---------|-----|-----|---------|
| `@unturf/unfirehose` | `packages/core` | [npm](https://www.npmjs.com/package/@unturf/unfirehose) | Core data layer — ingestion, SQLite schema, types, PII, formatters |
| `@unturf/unfirehose-schema` | `packages/schema` | [npm](https://www.npmjs.com/package/@unturf/unfirehose-schema) | unfirehose/1.0 spec — JSON Schema files, TypeScript types, 16 harness adapter docs |
| `@unturf/unfirehose-router` | `packages/router` | [npm](https://www.npmjs.com/package/@unturf/unfirehose-router) | CLI daemon — watches JSONL, forwards to cloud |
| `@unturf/unfirehose-ui` | `packages/ui` | [npm](https://www.npmjs.com/package/@unturf/unfirehose-ui) | Shared React components |

Private workspaces: `apps/web` (Next.js 15 App Router), `apps/worker` (background ingestion), `packages/config` (shared tsconfig).

### Publishing

npm token stored at `~/.npmrc` (600 perms, outside repo). Publish from each package dir:
```bash
cd packages/core && npm publish --access public
cd packages/schema && npm publish --access public
cd packages/router && npm publish --access public   # has prepublishOnly: tsc
cd packages/ui && npm publish --access public
```

Key pages: Live, Active, Terminals, Dashboard, Projects, Todos/Kanban, Thinking, All Logs, Tokens, Usage Monitor, Scrobble, Graph Explorer, Schema, Settings, Permacomputer.

### Website

unfirehose.com is served from `~/git/unsandbox.com` (the portal repo). Blog posts and landing pages live there, not in this repo.

### Permacomputer / Mesh

The Permacomputer page (`/permacomputer`) manages a mesh of compute nodes. Nodes are discovered from `~/.ssh/config` and probed via SSH. Each node reports CPU, memory, disk, GPU, power consumption, running processes, and tmux sessions.

Key files:
- `apps/web/src/app/permacomputer/page.tsx` — main mesh overview with node cards, economics, bootstrap panel
- `apps/web/src/app/permacomputer/unsandbox/page.tsx` — unsandbox.com cloud node page
- `apps/web/src/app/usage/node/[hostname]/page.tsx` — per-node detail (System/Harnesses/Processes tabs)
- `apps/web/src/app/api/mesh/route.ts` — mesh summary (local + SSH probes, RAPL power, GPU via nvidia-smi)
- `apps/web/src/app/api/mesh/node/route.ts` — detailed single-node probe via SSH
- `apps/web/src/app/api/mesh/history/route.ts` — time-series from `mesh_snapshots` table
- `apps/web/src/app/api/unsandbox/route.ts` — unsandbox.com API proxy (HMAC-signed)
- `apps/web/src/app/api/boot/route.ts` — bootstrap harnesses on nodes (tmux, SCP credentials, sudo)
- `apps/web/src/app/api/tmux/stream/route.ts` — SSE tmux capture + interactive keystroke POST
- `apps/web/src/app/tmux/[session]/page.tsx` — full-screen tmux viewer (local + remote via `?host=`)
- `packages/core/mesh.ts` — `discoverNodes()` from SSH config

### Unsandbox Integration

API at `api.unsandbox.com`. Auth: HMAC-SHA256 signing with `${timestamp}:${method}:${path}:${body}`.

Key endpoints used:
- `GET /keys/self` — key status (returns `tier`, `rate_per_minute`/`rate_limit`, `concurrency`, `burst`)
- `POST /execute` — one-shot code execution (`{ language, code, network }`)
- `GET /sessions` — list active sessions
- `DELETE /sessions/:id` — kill session
- `POST /services` — create persistent service (`{ name, ports, bootstrap, network }`)
- `GET /services` — list services
- `DELETE /services/:id` — destroy service

Network modes: `zerotrust` (no network) or `semitrusted` (egress proxy). The TypeScript SDK lives at `~/git/unsandbox.com/cli/un-inception/clients/typescript/sync/src/un.ts`.

### Node Harnesses

The Harnesses tab on node detail pages shows:
- **Tmux sessions** — with live SSE preview and interactive Watch mode (send keystrokes via `tmux send-keys`)
- **Bare claude processes** — parsed from `ps aux | grep claude` in probe data (PID, CPU%, MEM%, command)

### Power Estimation

- **RAPL** (`/sys/class/powercap/intel-rapl`) measures CPU package only
- `calcNonCpuWatts()` adds RAM DIMMs, spinning disks, SSDs, baseline, PSU inefficiency
- **nvidia-smi** `--query-gpu=power.draw` for real-time GPU wattage
- **TDP** fallback from CPU model name lookup

### Performance

Key API routes are parallelized: SSH mesh probes run concurrently via `Promise.all` (3 calls combined into 1 per node), git operations in `/api/projects/*/tree` and `/api/projects/*/git` run all spawns in parallel, and `/api/tokens` uses covering indexes + `EXISTS` subqueries. Benchmark with `python3 scripts/perf-report.py --runs 3 --threshold 500` (crawls `/sitemap` + all API routes, outputs JSON + terminal report).

### Bootstrap

The bootstrap panel (`/permacomputer`) deploys harnesses on SSH nodes:
- SCP syncs `~/.claude/.credentials.json` and `~/.claude.json` (OAuth + onboarding state)
- Optional sudo password for privileged setup (piped via `sudo -S` stdin)
- Creates tmux session with harness command

### Unsandbox Claude bootstrap

Bootstrap installs claude via `curl -fsSL https://claude.ai/install.sh | bash` if not already present, persists `~/.local/bin` in PATH via bashrc and `/etc/profile.d/claude.sh`. Auth credentials (`~/.claude/.credentials.json`, settings) are base64-encoded server-side and injected into the bootstrap script, written with `umask 077`, `chmod 600` on files, `chmod 700` on `~/.claude/`.

- On terminal connect: auto-send `tmux attach -t claude` to land in claude's UI
- `IS_SANDBOX=1` env var set when running claude in unsandbox containers

### Unsandbox threat model

**Assume an untrusted user has bash-level access on all unsandbox containers.** Credential files must never be world-readable. Permacomputer nodes run tripwire processes that monitor for public file permissions on sensitive paths — any credential file created with lax permissions will trigger an alert. All credential writes must use `umask 077` before `mkdir`/file creation, followed by explicit `chmod 600` (files) and `chmod 700` (directories) as belt-and-suspenders.

## Todo System

Cross-session todos are extracted from all harness JSONL (Claude Code, Fetch, uncloseai) during ingestion. 1300+ todos across 22 projects. Todos support file attachments stored at `~/.unfirehose/attachments/{sha256}` (content-addressed, max 10MB per file).

### API (localhost:3000)

Start every session by checking the todo landscape:

```bash
# Quick landscape — counts, stale, by-project, oldest pending
curl -s localhost:3000/api/todos/summary | python3 -m json.tool

# Actionable work for this project
curl -s "localhost:3000/api/todos/pending?project=-home-fox-git-unfirehose"

# Quick wins only (under 15 minutes)
curl -s "localhost:3000/api/todos/pending?quick=true&limit=20"

# Stale items diverged from reality (not touched in 7+ days)
curl -s "localhost:3000/api/todos/stale?days=7&limit=20"

# Search across all todos
curl -s "localhost:3000/api/todos/pending?search=auth"

# Create a todo
curl -X POST localhost:3000/api/todos \
  -H 'Content-Type: application/json' \
  -d '{"content": "Fix the thing", "source": "manual"}'

# Set time estimate
curl -X PATCH localhost:3000/api/todos \
  -H 'Content-Type: application/json' \
  -d '{"id": 123, "estimatedMinutes": 30}'

# Bulk complete
curl -X PATCH localhost:3000/api/todos/bulk \
  -H 'Content-Type: application/json' \
  -d '{"ids": [1,2,3], "status": "completed"}'

# Upload attachment to a todo
curl -X POST localhost:3000/api/todos/attachments \
  -F 'todoId=123' -F 'files=@screenshot.png'

# List attachments
curl -s "localhost:3000/api/todos/attachments?todoId=123"

# Delete attachment
curl -X DELETE localhost:3000/api/todos/attachments \
  -H 'Content-Type: application/json' \
  -d '{"id": 456}'
```

### Ticket threshold

- **Under 15 minutes?** Just do it. No ticket needed.
- **Over 15 minutes?** Create a ticket in `docs/tickets/NNNN-slug.md`. Get fox's approval on the plan.
- **Blocked on human input?** Create a ticket with `blocked` status. Describe what you need.
- **Stale and diverged from main?** Either bulk-close as obsolete or create a ticket to reassess.

See `docs/tickets/README.md` for the full ticket format and workflow.

### Triage workflow

1. `curl localhost:3000/api/todos/summary` — understand the landscape
2. Identify stale/blocked items that have diverged from the codebase
3. Items that are clearly obsolete → bulk-close them
4. Items that need planning → create ticket files in `docs/tickets/`
5. Items that are quick wins → just do them, mark completed
6. Items that need human input → create blocked tickets, flag to fox

## Next.js Best Practices (vercel-labs/next-skills)

### File Conventions
- Special files: `page.tsx`, `layout.tsx`, `loading.tsx`, `error.tsx`, `not-found.tsx`, `route.ts`, `template.tsx`, `default.tsx`
- Dynamic segments: `[slug]`, catch-all: `[...slug]`, optional catch-all: `[[...slug]]`
- Route groups: `(marketing)` — organize without affecting URL
- Parallel routes: `@slot` folders, always need `default.tsx` fallback
- Intercepting routes: `(.)` same level, `(..)` one up, `(...)` from root

### RSC Boundaries
- Client components CANNOT be async — only Server Components can be async
- Only JSON-serializable values cross the server→client boundary (no Date, Map, Set, functions, classes)
- Server Actions (`'use server'`) are the sole exception — functions that can be passed to client components
- Move async logic to server parents, pass plain data down to clients

### Async Patterns (Next.js 15+)
- `params`, `searchParams`, `cookies()`, `headers()` are all async — must `await` them
- Use `React.use()` when a component cannot be async
- Migration codemod: `npx @next/codemod@latest next-async-request-api .`

### Directives
- `'use client'` — required for hooks, event handlers, browser APIs
- `'use server'` — marks Server Actions (file-level or inline)
- `'use cache'` — Next.js caching directive (requires `cacheComponents: true` in config)

### Data Patterns
- Server Components for reads (no API layer needed, secrets stay secure)
- Server Actions for mutations (POST only, end-to-end type safety, progressive enhancement)
- Route Handlers for external clients, webhooks, REST APIs, HTTP caching
- Avoid waterfalls: use `Promise.all`, Suspense streaming, or preload pattern
- Never use Server Actions for cacheable reads — use Route Handlers instead

### Error Handling
- NEVER wrap `redirect()`, `notFound()`, `forbidden()`, `unauthorized()` in try-catch — they throw for control flow
- Use `unstable_rethrow(error)` if navigation calls must be inside try-catch
- `error.tsx` = Client Component error boundary, `global-error.tsx` = root layout errors

### Route Handlers
- `route.ts` and `page.tsx` CANNOT coexist in the same folder
- Params are Promises in Next.js 15+: `{ params }: { params: Promise<{ id: string }> }`
- Prefer Server Actions for UI mutations, Route Handlers for external integrations

### Metadata
- `metadata` and `generateMetadata` are Server Component only — cannot use in `'use client'` files
- Use React `cache()` to deduplicate data fetched in both metadata and page
- Viewport must be separate from metadata (for streaming support)
- Title templates in root layout: `{ default: 'Site Name', template: '%s | Site Name' }`
- Use `next/og` (not `@vercel/og`) for OG images, avoid Edge runtime for them

### Image & Font
- Always use `next/image` over `<img>` — remote images need `remotePatterns` in config
- Always set `sizes` when using `fill` (prevents downloading largest image)
- `priority` for above-the-fold LCP images, below-fold lazy-loads automatically
- Always use `next/font` over `<link>` tags — define once in layout, distribute via CSS variables
- Specify character subsets (e.g. `['latin']`) to reduce font file size

### Bundling
- Browser-only libs: `dynamic(() => import('pkg'), { ssr: false })`
- Native bindings (sharp, bcrypt): add to `serverExternalPackages` in config
- Next.js includes common polyfills — don't add external polyfill services
- ESM/CJS issues: use `transpilePackages` config

### Hydration
- Common causes: browser APIs (`window`), Date/time rendering, random values, invalid HTML nesting
- Use `useId()` for unique IDs, mounted check pattern for browser-only content
- Third-party scripts: use `next/script` with `strategy="afterInteractive"`

### Suspense Boundaries
- `useSearchParams()` ALWAYS requires Suspense boundary in static routes
- `usePathname()` requires Suspense in dynamic routes (unless `generateStaticParams` used)
- `useParams()` and `useRouter()` do NOT require Suspense

### Scripts
- Use `next/script` not native `<script>` tags — inline scripts need `id` attribute
- Never place scripts inside `next/head`
- Use `@next/third-parties` for Google Analytics, Tag Manager, YouTube embeds

### Self-Hosting
- `output: 'standalone'` for Docker — creates minimal production folder
- ISR uses filesystem cache by default — breaks with multiple instances (need shared cache handler)
- Set `HOSTNAME="0.0.0.0"` for containers

## Searching Logs

```bash
# Search all logs (text search + date filtering)
curl -s "localhost:3000/api/logs?search=error&from=2026-03-01&types=assistant&limit=50"

# Search thinking blocks
curl -s "localhost:3000/api/thinking?search=architecture&from=2026-03-01&limit=100"
```
