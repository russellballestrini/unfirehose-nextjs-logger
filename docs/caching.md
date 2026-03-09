# Caching Strategy

All server-side caches use **in-memory TTL** — module-level variables that persist across requests within the same Next.js process. No Redis, no disk cache, no CDN. Appropriate for a single-instance local dashboard.

## Cache Inventory

| Route | Variable | TTL | Pattern | Keys | Invalidation |
|-------|----------|-----|---------|------|-------------|
| `/api/mesh` | `meshCache` | 15s | Stale-while-revalidate | Global singleton | Refresh lock prevents concurrent SSH storms |
| `/api/scrobble/preview` | `previewCache` | 5min | Simple TTL | Global singleton | TTL only |
| `/api/projects/[p]/tree` | `treeCache` | 10s | Per-path Map + LRU | `project:path:ref` | LRU cap at 100 entries |
| `/api/projects/[p]/git` | `gitCache` | 5s | Per-project Map | `project` | Cleared on POST/DELETE mutations |
| `/api/llm/providers` | `cache` | 60s | Simple TTL | Global singleton | TTL only |
| `/api/projects` | `cache` | 30s | Simple TTL | Global singleton | TTL only |
| `/api/projects/git-status` | `cache` | 30s | Simple TTL | Global singleton | TTL only |
| `/api/projects/metadata` | `cache` | 60s | Per-project Map | `project` | TTL only |
| `/api/mesh/geoip` | `cache` | 1h | Per-hostname Map | `hostname` | TTL only |
| `/api/mesh/rates` | `cache` | 1h | Simple TTL | Global singleton | TTL only |
| `/api/blog/resume` | `resumeCache` | 15min | Simple TTL | Global singleton | TTL only |

## Patterns

### Simple TTL (most common)

```typescript
let cache: { data: T; ts: number } | null = null;
const CACHE_TTL = 30_000;

export async function GET() {
  if (cache && Date.now() - cache.ts < CACHE_TTL) return NextResponse.json(cache.data);
  const data = await expensiveOperation();
  cache = { data, ts: Date.now() };
  return NextResponse.json(data);
}
```

Used by: projects, git-status, scrobble/preview, llm/providers, rates, resume.

### Per-Key Map

```typescript
const cache = new Map<string, { data: T; ts: number }>();
const CACHE_TTL = 10_000;

// Lookup by composite key
const cached = cache.get(key);
if (cached && Date.now() - cached.ts < CACHE_TTL) return cached.data;
```

Used by: tree (with LRU cap), git (with mutation invalidation), metadata, geoip.

### Stale-While-Revalidate (mesh only)

```typescript
let meshCache: { data: any; ts: number } | null = null;
let refreshing = false;
const MESH_TTL = 15_000;

export async function GET() {
  // Fresh — serve immediately
  if (meshCache && Date.now() - meshCache.ts < MESH_TTL) {
    return NextResponse.json(meshCache.data);
  }
  // Stale — serve stale, refresh in background
  if (meshCache && !refreshing) {
    refreshing = true;
    refreshMesh().then(d => { meshCache = { data: d, ts: Date.now() }; refreshing = false; });
    return NextResponse.json(meshCache.data);
  }
  // Cold start — must wait
  const data = await refreshMesh();
  meshCache = { data, ts: Date.now() };
  return NextResponse.json(data);
}
```

The `refreshing` lock prevents concurrent SSH probe storms when multiple requests hit during a refresh cycle.

## Data Sources (Truth → Cache → Client)

```
Source of Truth          Cache Layer              Client
─────────────          ──────────              ──────
~/.ssh/config          meshCache (15s SWR)      /permacomputer (SWR 30s)
  + SSH probes

SQLite DB              projectsCache (30s)      /projects (SWR 30s)
  projects table

git repos              gitCache (5s/project)    /projects/[p] (SWR 5s)
  status + diff         treeCache (10s/path)

Forge APIs             previewCache (5min)      /scrobble (SWR 60s)
  GitHub/GitLab/CB

HTTP probes            providersCache (60s)     /settings (SWR 60s)
  mesh LLM endpoints

CoinGecko/Frankfurter  ratesCache (1h)          /permacomputer (SWR 30s)

External HTTP          resumeCache (15min)      /blog (on-demand)

~/.ssh/config + IP     geoipCache (1h/host)     /permacomputer (SWR 30s)
```

## Client-Side Caching (SWR)

All pages use `useSWR` with `refreshInterval` for polling. The client-side SWR deduplicates identical requests within 2s by default.

Client-side caches (non-TTL):
- **ANSI style cache** (`tmux/[session]/page.tsx`): Map of compiled CSS strings, never expires
- **Dirty project cache** (`projects/page.tsx`): useRef, busted on git snapshot change

## TTL Rationale

| Data Type | Volatility | TTL | Why |
|-----------|-----------|-----|-----|
| Mesh stats | CPU/memory drift slowly | 15s | Client polls every 30s, 50% hit rate |
| Git status | Changes on save | 5s | Prevents hammering on rapid tab switches |
| File tree | Changes on commit | 10s | Navigation within a tree is rapid |
| Project list | Changes on new session | 30s | New projects appear rarely |
| LLM providers | Availability shifts over minutes | 60s | Probes are slow HTTP requests |
| Scrobble | Visibility rechecked daily | 5min | Forge API calls are expensive |
| Currency rates | Intraday prices | 1h | External API rate limits |
| GeoIP | Static per IP | 1h | IPs don't move |
| Resume | External JSON | 15min | Rarely changes |

## Memory Budget

Each cache entry is small (2-50KB). Even with 100 tree paths cached, total memory is under 5MB. The LRU cap on tree cache bounds the worst case.

## What This Does NOT Include

- **Redis/external cache** — overkill for single-instance local app
- **Disk cache** — in-memory is simpler and fast enough
- **CDN/edge caching** — local dashboard, not deployed to edge
- **SSR caching** — pages are `'use client'`, all data fetched client-side via SWR
- **Background refresh intervals** — considered but deferred (uses resources when nobody's watching)
