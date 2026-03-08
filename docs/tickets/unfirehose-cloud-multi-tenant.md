# unfirehose.com: Multi-Tenant Cloud Dashboard

**Status:** complete
**Project:** unfirehose-nextjs-logger
**Estimated:** multi-week
**Blocked by:** fox approval on architecture

## Context

unfirehose currently runs locally, reading Claude Code JSONL from `~/.claude/` into a local SQLite DB. We want to host a cloud version at unfirehose.com (portal via unsandbox.com) that supports multiple user seats with tiered API keys.

## Existing work on unsandbox.com (Elixir/Phoenix)

Already built and wired up:

- **`Unsandbox.Schemas.UnfirehoseAccount`** — Ecto schema: `account_id`, `email`, `tier` (free/pro/team as strings — we map to ints: 0/14/33), `stripe_customer_id`, `payment_id`
- **`Unsandbox.Storage.UnfirehoseAccounts`** — Full CRUD, upsert by account_id, lapse detection for expired payments (auto-downgrade)
- **`Unsandbox.Webhooks.UnfirehoseSync`** — POSTs tier changes to `https://api.unfirehose.org/webhooks/tier-sync` with HMAC-SHA256 signature, 3 retries with exponential backoff, audit-logged
- **Pricing page** — 3 tiers with crypto (XMR/BTC/LTC/DOGE) + Stripe card/USDC payments:
  - **Free / tier 0** ($0) — 7-day sliding window, rate limited
  - **Solo / tier 14** ($14/mo) — Full access, unlimited history, priority rate limits
  - **Team / tier 33** ($420/mo) — Everything in Solo + unlimited sub-keys for team members
- **Purchase flow** — Routes through `/purchase/custom?product_type=unfirehose&product_tier=pro` etc.
- **Account flow** — User purchases on unsandbox.com, gets an `account_id`, generates their own `unfh-` prefixed keys on unfirehose.com

### What unsandbox.com handles (NOT our problem)
- Payment processing (crypto + Stripe)
- Account creation and tier assignment
- Subscription lapse detection and auto-downgrade
- Webhook delivery to unfirehose on tier changes

### What unfirehose.com must handle (THIS ticket)
- Receive webhook from unsandbox.com to sync tier status
- API key generation (`unfh-` prefix) from account_id
- Team sub-key issuance (team tier)
- Data ingest, storage, and dashboard serving per tenant
- Rate limiting based on tier

## Architecture

### Dual-mode switching

```
MULTI_TENANT=false  (default, local)     MULTI_TENANT=true  (cloud)
-------------------------------------    ----------------------------------
No auth                                  API key auth on all routes
Single SQLite at ~/.unfirehose/unfirehose.db SQLite per tenant: /data/{account_id}.db
Reads JSONL from ~/.claude/              Receives events via POST /api/ingest
No teams, no keys                        Teams, sub-keys, usage tracking
```

### Key decisions (confirmed with fox)

- **Data ingest:** Full local app can route to cloud, PLUS a lightweight local router/daemon that just forwards events with an API key (no local dashboard needed)
- **Database:** SQLite per tenant (one `.db` per account)
- **Codebase:** Same repo, dual mode via `MULTI_TENANT` env flag
- **Local mode** continues to work exactly as today

### Data model (cloud mode)

```sql
-- Shared control plane DB: /data/control.db

-- Tier integers: 0=free, 14=solo ($14/mo), 33=team ($33/mo, unlimited sub-keys)

CREATE TABLE accounts (
  id TEXT PRIMARY KEY,            -- account_id from unsandbox.com
  email TEXT NOT NULL,
  tier INTEGER NOT NULL DEFAULT 0,  -- 0=free, 14=solo, 33=team
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  active INTEGER DEFAULT 1
);

CREATE TABLE api_keys (
  id TEXT PRIMARY KEY,            -- uuidv7
  account_id TEXT NOT NULL REFERENCES accounts(id),
  key_hash TEXT NOT NULL,         -- sha256 of the actual key
  key_prefix TEXT NOT NULL,       -- first 8 chars for display: "unfh_abc1..."
  label TEXT,                     -- "fox-laptop", "ci-server", etc.
  parent_key_id TEXT,             -- NULL for root keys, parent key id for sub-keys
  scopes TEXT DEFAULT 'ingest',   -- comma-sep: ingest, read, admin
  created_at TEXT DEFAULT (datetime('now')),
  last_used_at TEXT,
  revoked_at TEXT
);

CREATE TABLE usage_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id TEXT NOT NULL,
  api_key_id TEXT NOT NULL,
  event_type TEXT NOT NULL,       -- ingest, query
  event_count INTEGER DEFAULT 1,
  bytes INTEGER DEFAULT 0,
  recorded_at TEXT DEFAULT (datetime('now'))
);
```

Each account gets its own SQLite file at `/data/{account_id}.db` using the EXACT same schema as the local `unfirehose.db`. No schema changes needed for tenant data.

Team sub-keys: when `tier >= 33`, the root key holder can generate child keys (`parent_key_id` set). All sub-keys write to the same tenant DB but usage is tracked per key.

### API key format

```
unfh_xxxxxxxxxxxxxxxxxxxxxxxx   (matches unsandbox.com convention)
```

- `unfh_` prefix + 28-char random suffix
- Stored as SHA-256 hash in control.db
- First 8 chars stored as `key_prefix` for display in UI
- Users generate keys on unfirehose.com after linking their account_id from unsandbox

### Webhook receiver (from unsandbox.com)

```
POST /api/webhooks/tier-sync
X-Webhook-Signature: hmac-sha256 hex digest
Content-Type: application/json

{ "account_id": "abc123", "tier": "pro" }
```

Must match what `Unsandbox.Webhooks.UnfirehoseSync` sends:
- Verify HMAC-SHA256 signature using `UNFIREHOSE_WEBHOOK_SECRET`
- Map string tier to int: `{"free": 0, "pro": 14, "team": 33}` (unsandbox sends strings, we store ints)
- Upsert account record in control.db
- Enforce tier limits (e.g., revoke sub-keys if downgraded from team to solo)

### Ingest API

```
POST /api/ingest
Authorization: Bearer unfh_xxxxxxxxxxxxxxxx
Content-Type: application/x-ndjson

Body: JSONL lines (same format as Claude Code output)
Response: { "accepted": 47, "errors": 0 }
```

1. Validate API key against control.db
2. Check tier rate limits (free: standard, pro: priority, trust: unlimited)
3. Resolve account_id from key
4. Open tenant SQLite at `/data/{account_id}.db`
5. Run existing ingest pipeline (same code as local worker)
6. Log usage per key

### Lightweight local router

Minimal package (`@unturf/unfirehose-router` or standalone binary):

1. Watches `~/.claude/projects/` for new JSONL writes (inotify/fswatch)
2. Batches events (every 5s or 100 events, whichever first)
3. POSTs to `https://api.unfirehose.org/api/ingest` with API key
4. Retries with exponential backoff on failure
5. Tracks cursor position per file to avoid re-sending

```json
// ~/.unfirehose.json
{
  "api_key": "unfh_xxxxxxxxxxxxxxxx",
  "endpoint": "https://api.unfirehose.org/api/ingest",
  "watch_paths": ["~/.claude/"],
  "batch_size": 100,
  "flush_interval_ms": 5000
}
```

Installable via: `npx @unturf/unfirehose-router` or a single compiled binary.

### Auth middleware (cloud mode)

```typescript
// middleware.ts (Next.js)
if (process.env.MULTI_TENANT === 'true') {
  // API routes: validate Bearer token (unfh_ key)
  // Web routes: validate session cookie (set after key-based login)
  // Resolve account_id, inject tenant DB connection
}
```

### Tenant DB resolution

```typescript
// packages/core/db/tenant.ts
function getTenantDb(accountId: string): BetterSqlite3.Database {
  // LRU pool of open connections
  // Opens /data/{accountId}.db, runs migrations if needed
  // Same schema as local unfirehose.db
}
```

In cloud mode, `getDb()` becomes `getTenantDb(accountId)` — all existing API routes work unchanged.

### Tier enforcement

| Feature | Free (0) | Solo (14) | Team (33) |
|---------|----------|-----------|-----------|
| Data window | 7 days | Unlimited | Unlimited |
| Ingest rate | 100 events/min | 10K events/min | Unlimited |
| API keys | 1 | 5 | Unlimited sub-keys |
| Dashboard | Read-only | Full | Full + team view |
| Backfill | No | Yes | Yes |
| Price | $0 | $14/mo | $420/mo |

## Milestones

### M0: Foundation
- [x] `MULTI_TENANT` env flag, conditional middleware
- [x] Control plane DB: `control.db` with accounts, api_keys, usage_log tables
- [x] `unfh_` key generation, SHA-256 hashing, validation
- [x] Tenant DB pool (LRU cache of per-account SQLite connections)
- [x] `getDb()` → `getTenantDb()` in cloud mode

### M1: Webhook + Ingest
- [x] `POST /api/webhooks/tier-sync` — receive from unsandbox.com, verify HMAC signature
- [x] `POST /api/ingest` — accept JSONL, validate key, write to tenant DB
- [x] Rate limiting per key based on tier
- [x] Usage logging per key

### M2: Lightweight router
- [x] `@unturf/unfirehose-router` package — file watcher + batch POST
- [x] `~/.unfirehose.json` config
- [x] Cursor tracking (resume after restart)
- [x] Exponential backoff retry

### M3: Dashboard auth
- [x] Key-based login flow (paste unfh_ key to access dashboard)
- [x] Session cookies for web UI
- [x] API key management page (create, revoke, label, list)
- [x] Team sub-key management (team tier only)

### M4: Tier features
- [x] 7-day sliding window enforcement for free tier (prune on ingest)
- [x] Account info API (`/api/account` — tier, limits, usage stats)
- [x] Team usage aggregation (per sub-key breakdown)
- [x] Data export/delete (GDPR)

## Required env vars (cloud mode)

```bash
MULTI_TENANT=true                    # Enable cloud mode
AUTH_SECRET=<random-64-chars>        # Signs JWT session cookies
UNFIREHOSE_WEBHOOK_SECRET=<shared>   # HMAC key shared with unsandbox.com
CONTROL_DB_PATH=/data/control.db     # Control plane DB (default)
TENANT_DB_DIR=/data/tenants          # Per-tenant DBs (default)
```

## Open questions

1. **Domain:** `api.unfirehose.org` (already in webhook config) vs `unfirehose.com`?
2. **Deployment:** Fly.io? Hetzner? Need persistent disk for SQLite files + Litestream backup.
3. **Login flow:** Key-paste only? Or also link unsandbox.com session via OAuth?
4. **Free tier enforcement:** Delete data after 7 days or just hide it in queries?

## Notes

- unsandbox.com handles ALL payment/billing — we just receive tier webhooks
- The `unfh_` key prefix is already the convention from the unsandbox side
- SQLite per tenant = easy isolation, export, delete, backup (Litestream to S3)
- Existing ingest pipeline (`packages/core/db/ingest.ts`) reused as-is
- Tenant DBs use same migrations as local — new features work in both modes
