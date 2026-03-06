# unfirehose.com: Multi-Tenant Cloud Dashboard

**Status:** open
**Project:** unfirehose-nextjs-logger
**Estimated:** multi-week
**Blocked by:** fox approval on architecture

## Context

unfirehose currently runs locally, reading Claude Code JSONL from `~/.claude/` into a local SQLite DB. We want to host a cloud version at unfirehose.com (portal via unsandbox.com) that supports multiple user seats with tiered API keys.

### Business model

- **Tier 1 (individual):** Single user, single API key, personal dashboard
- **Tier 33 (team):** Team account, can issue unlimited sub-keys to track LLM usage per member
- Keys sold through unsandbox.com portal

### Key decisions (confirmed with fox)

- **Data ingest:** Dual mode — full local app can route to cloud, PLUS a lightweight local router/daemon that just forwards events with an API key (no local dashboard needed)
- **Database:** SQLite per tenant (one `.db` per team/user)
- **Codebase:** Same repo, dual mode via `MULTI_TENANT` env flag
- **Local mode** continues to work exactly as today (no auth, single user, `~/.claude/unfirehose.db`)

## Architecture

### Dual-mode switching

```
MULTI_TENANT=false  (default, local)     MULTI_TENANT=true  (cloud)
─────────────────────────────────────     ──────────────────────────────────
No auth                                   API key auth on all routes
Single SQLite at ~/.claude/unfirehose.db  SQLite per tenant: /data/{tenant_id}.db
Reads JSONL from ~/.claude/               Receives events via POST /api/ingest
No teams, no keys                         Teams, sub-keys, usage tracking
```

### Data model (cloud mode)

```sql
-- Shared control plane DB: /data/control.db

CREATE TABLE teams (
  id TEXT PRIMARY KEY,          -- uuidv7
  name TEXT NOT NULL,
  tier INTEGER NOT NULL DEFAULT 1,  -- 1=individual, 33=team
  owner_email TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now')),
  stripe_customer_id TEXT,
  active INTEGER DEFAULT 1
);

CREATE TABLE api_keys (
  id TEXT PRIMARY KEY,          -- uuidv7
  team_id TEXT NOT NULL REFERENCES teams(id),
  key_hash TEXT NOT NULL,       -- sha256 of the actual key
  key_prefix TEXT NOT NULL,     -- first 8 chars for display: "uf_abc123..."
  label TEXT,                   -- "fox-laptop", "ci-server", etc.
  scopes TEXT DEFAULT 'ingest', -- comma-sep: ingest, read, admin
  created_at TEXT DEFAULT (datetime('now')),
  last_used_at TEXT,
  revoked_at TEXT
);

CREATE TABLE team_members (
  team_id TEXT NOT NULL REFERENCES teams(id),
  email TEXT NOT NULL,
  role TEXT DEFAULT 'member',   -- owner, admin, member
  api_key_id TEXT REFERENCES api_keys(id),  -- their personal sub-key
  joined_at TEXT DEFAULT (datetime('now')),
  PRIMARY KEY (team_id, email)
);

CREATE TABLE usage_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  team_id TEXT NOT NULL,
  api_key_id TEXT NOT NULL,
  event_type TEXT NOT NULL,     -- ingest, query, boot
  event_count INTEGER DEFAULT 1,
  recorded_at TEXT DEFAULT (datetime('now'))
);
```

Each team gets its own SQLite file at `/data/{team_id}.db` using the EXACT same schema as the local `unfirehose.db` — sessions, messages, projects, todos, etc. No schema changes needed for tenant data.

### Ingest API (cloud)

```
POST /api/ingest
Authorization: Bearer uf_xxxxxxxxxxxxxxxx

Body: JSONL lines (same format as Claude Code output)
Content-Type: application/x-ndjson

Response: { "accepted": 47, "errors": 0 }
```

The ingest endpoint:
1. Validates API key against control.db
2. Resolves team_id from key
3. Opens/creates tenant SQLite at `/data/{team_id}.db`
4. Runs the existing ingest pipeline (same code as local worker)
5. Logs usage

### Lightweight local router

Minimal package (`@unfirehose/router` or standalone binary) that:

1. Watches `~/.claude/projects/` for new JSONL writes (inotify/fswatch)
2. Batches events (every 5s or 100 events, whichever comes first)
3. POSTs to `https://unfirehose.com/api/ingest` with API key
4. Retries with exponential backoff on failure
5. Tracks cursor position per file to avoid re-sending

```
~/.unfirehose.json
{
  "api_key": "uf_xxxxxxxxxxxxxxxx",
  "endpoint": "https://unfirehose.com/api/ingest",
  "watch_paths": ["~/.claude/"],
  "batch_size": 100,
  "flush_interval_ms": 5000
}
```

Should be installable via: `npx @unfirehose/router` or a single Go/Rust binary.

### Auth middleware (cloud mode)

```typescript
// middleware.ts (Next.js)
if (process.env.MULTI_TENANT === 'true') {
  // Check session cookie or API key header
  // Resolve tenant_id
  // Inject tenant DB connection into request context
}
```

Routes in cloud mode require auth. The existing page components stay identical — only the DB connection changes (from the single local DB to the tenant's DB).

### Tenant DB resolution

```typescript
// packages/core/db/tenant.ts
function getTenantDb(teamId: string): BetterSqlite3.Database {
  // Pool of open connections, LRU eviction
  // Opens /data/{teamId}.db, runs migrations if needed
  // Same schema as local unfirehose.db
}
```

### API key format

```
uf_live_xxxxxxxxxxxxxxxxxxxxxxxx   (production)
uf_test_xxxxxxxxxxxxxxxxxxxxxxxx   (test/dev)
```

- 32-char random suffix
- Stored as SHA-256 hash in control.db
- First 8 chars stored as prefix for key management UI

## Milestones

### M0: Foundation (this ticket)
- [ ] `MULTI_TENANT` env flag and conditional auth middleware
- [ ] Control plane DB schema + migrations (teams, api_keys, team_members)
- [ ] API key generation, validation, and hashing
- [ ] Tenant DB pool (open per-tenant SQLite, LRU cache)
- [ ] `getDb()` becomes tenant-aware in cloud mode

### M1: Ingest API
- [ ] `POST /api/ingest` — accepts JSONL, validates key, writes to tenant DB
- [ ] Rate limiting per key
- [ ] Usage logging
- [ ] Lightweight router package (`@unfirehose/router`) — file watcher + batch POST

### M2: Dashboard auth
- [ ] Login/signup flow (email + magic link or OAuth)
- [ ] Session cookies for web UI
- [ ] API key management page (create, revoke, list)
- [ ] Team management (invite members, assign sub-keys)

### M3: Billing integration
- [ ] Stripe integration via unsandbox.com portal
- [ ] Tier enforcement (individual vs team)
- [ ] Usage metering for billing

### M4: Team features
- [ ] Cross-member usage aggregation
- [ ] Team dashboard view
- [ ] Admin role permissions
- [ ] Sub-key usage breakdown

## Open questions

1. **Session management:** Cookie-based for web, API key for programmatic. Use next-auth or roll our own?
2. **Deployment target:** Fly.io? Hetzner? Need persistent disk for SQLite files.
3. **Backup strategy:** Litestream to S3 for tenant DBs?
4. **Domain routing:** unfirehose.com direct or through unsandbox.com proxy?
5. **Rate limits:** Per key? Per team? What thresholds?

## Notes

- The local router must be extremely lightweight — no Next.js, no React, just a file watcher and HTTP client
- SQLite per tenant keeps data isolated and makes it easy to export/delete (GDPR)
- The existing ingest pipeline in `packages/core/db/ingest.ts` does all the heavy lifting — cloud mode just needs to route data to the right DB file
- Tenant DBs use the same migrations as local, so any new feature works in both modes automatically
