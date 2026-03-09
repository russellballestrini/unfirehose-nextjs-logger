# 4001: Performance Caching Strategy

**Status:** proposed
**Estimate:** 60-90 minutes total (all 5 routes)
**Created:** 2026-03-09

## Context

After parallelizing all I/O-bound routes, 5 endpoints remain slow (>500ms) due to external I/O: SSH probes, git operations, HTTP health checks. All have **zero server-side caching** despite the codebase already using in-memory TTL caches in 5 other routes.

Current perf baseline (best-of-3):

| Route | Time | Bottleneck |
|-------|------|------------|
| `/api/mesh` | 2.8s | SSH to 4 remote nodes + RAPL sleep |
| `/api/scrobble/preview` | 2.6s | curl to forge APIs (GitHub, GitLab, etc.) |
| `/api/projects/{p}/tree` | 2.0s | git ls-tree + git log + git show |
| `/api/projects/{p}/git` | 2.0s | git status + git diff HEAD (full diff) |
| `/api/llm/providers` | 1.6s | HTTP health probes to mesh LLM endpoints |

## Strategy: In-Memory TTL Cache (same pattern as existing routes)

The codebase already uses this pattern in 5 routes (`/api/projects`, `/api/projects/metadata`, `/api/projects/git-status`, `/api/mesh/geoip`, `/api/mesh/rates`):

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

### Route-by-Route Plan

#### 1. `/api/mesh` — TTL 15s, stale-while-revalidate

- **Cache TTL:** 15s (client polls every 30s, so cache hit rate ~50%)
- **Pattern:** Stale-while-revalidate — serve cached data immediately, trigger background refresh if stale
- **Why 15s:** Mesh data changes slowly (uptime, load avg). 15s staleness is unnoticeable. CPU/memory stats shift gradually.
- **Overlap prevention:** The 30s SWR interval can overlap with a 2.8s response. A `refreshing` lock prevents concurrent SSH storms.
- **Expected:** 2.8s → 0ms (cache hit) / 2.8s (cache miss, same as now)

```typescript
let meshCache: { data: any; ts: number } | null = null;
let refreshing = false;
const MESH_TTL = 15_000;

export async function GET() {
  if (meshCache && Date.now() - meshCache.ts < MESH_TTL) {
    return NextResponse.json(meshCache.data);
  }
  // Serve stale while refreshing in background
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

#### 2. `/api/scrobble/preview` — TTL 5min

- **Cache TTL:** 300s (5 minutes)
- **Why:** Scrobble data changes rarely (project visibility is rechecked every 24h). The batch-cap already bounds work per request. A 5-minute cache means the page loads instantly on revisits.
- **Pattern:** Simple TTL cache (no background refresh needed)
- **Expected:** 2.6s → 0ms (cache hit) / 2.6s (every 5 min)

#### 3. `/api/projects/{p}/tree` — TTL 10s, per-path cache

- **Cache TTL:** 10s, keyed by `project + path + ref`
- **Why:** File trees don't change every second. 10s is enough to make rapid navigation instant (clicking through directories) while staying fresh enough to see recent commits.
- **Pattern:** `Map<string, { data; ts }>` with LRU eviction (cap at 100 entries to bound memory)
- **Invalidation:** POST/DELETE to `/api/projects/{p}/git` (commit/file ops) clears the project's entries
- **Expected:** 2.0s → 0ms (cache hit on re-visit) / 2.0s (cold path)

#### 4. `/api/projects/{p}/git` — TTL 5s, per-project cache

- **Cache TTL:** 5s, keyed by project
- **Why:** Git status changes on every save, but the page only polls on focus. 5s prevents hammering git on rapid tab switches.
- **Pattern:** Simple `Map<string, { data; ts }>` cache
- **Invalidation:** POST mutations in the same route already exist — clear cache on commit/push
- **Expected:** 2.0s → 0ms (cache hit) / 2.0s (after 5s or mutation)

#### 5. `/api/llm/providers` — TTL 60s

- **Cache TTL:** 60s
- **Why:** Provider availability changes on the order of minutes, not seconds. OAuth credential expiry is checked locally (fast). Only the remote HTTP probes are slow.
- **Pattern:** Simple TTL cache
- **Expected:** 1.6s → 0ms (cache hit) / 1.6s (once per minute)

### Summary

| Route | TTL | Pattern | Cold | Warm |
|-------|-----|---------|------|------|
| `/api/mesh` | 15s | stale-while-revalidate + lock | 2.8s | 0ms |
| `/api/scrobble/preview` | 5min | simple TTL | 2.6s | 0ms |
| `/api/projects/{p}/tree` | 10s | per-path Map + LRU | 2.0s | 0ms |
| `/api/projects/{p}/git` | 5s | per-project Map + invalidation | 2.0s | 0ms |
| `/api/llm/providers` | 60s | simple TTL | 1.6s | 0ms |

### What This Does NOT Include

- **Redis/external cache** — overkill for single-instance local app
- **Disk cache** — in-memory is simpler and fast enough
- **CDN/edge caching** — local dashboard, not deployed to edge
- **SSR caching** — pages are `'use client'`, all data fetched client-side via SWR

### Alternative: Background Refresh (not recommended yet)

Instead of TTL caching, a background interval could keep data warm:

```typescript
// In apps/worker or a Next.js instrumentation hook
setInterval(async () => {
  meshCache = await refreshMesh();
}, 15_000);
```

**Pros:** First page load is always instant (cache is pre-warmed).
**Cons:** Uses resources even when nobody's looking at the page. The worker (`apps/worker`) currently only does ingestion — adding HTTP-dependent refreshes mixes concerns.

**Verdict:** Start with TTL caching. If fox opens the permacomputer page frequently and the 2.8s cold start is annoying, upgrade mesh to background refresh later.

### Risk

- **Memory:** Each cache entry is small (2-50KB). Even with 100 tree paths cached, total memory is under 5MB.
- **Staleness:** Worst case is seeing 5-60 second old data. For a monitoring dashboard this is fine. Git mutations invalidate immediately.
- **Correctness:** Cache keys include all query params. Different paths/projects get different cache entries.

## Implementation Order

1. `/api/mesh` (biggest impact, most frequent caller)
2. `/api/llm/providers` (simplest — one global cache var)
3. `/api/projects/{p}/git` (per-project Map, mutation invalidation)
4. `/api/projects/{p}/tree` (per-path Map, LRU cap)
5. `/api/scrobble/preview` (already has partial caching, just add TTL wrapper)
