.PHONY: dev fix-watches persist-watches rescue-tool-results pricing pricing-report

# Refresh the model price ledger from every public oracle and print what
# changed. Same function apps/worker runs daily (and whenever an unpriced
# model shows up in the logs); this is the on-demand form for the morning a
# model ships. Append-only: a price that moved opens a new ledger row and
# closes the old one, an unchanged price is stamped "still true today", and
# the attempt itself is written to pricing_sync_runs whether or not it worked.
# No credentials involved — every feed is public.
#
# To also run it from cron, this line is the whole job:
#   17 6 * * *  cd $(CURDIR) && make -s pricing >> ~/.unfirehose/pricing.log 2>&1
pricing:
	npx tsx scripts/sync-pricing.ts

# Restate a day we were billed for but never captured a per-call price on.
# Dry run by default; add --commit to write. The total must be a figure the
# provider stated — OpenRouter reports usage_daily / usage_weekly on
# /api/v1/key, and a closed day is (weekly - daily) when only two days carry
# traffic. Never invent the number.
#
#   make backfill-cost MODEL=google/gemini-3.8-flash DAY=2026-09-02 TOTAL=7.095105
#   make backfill-cost MODEL=... DAY=... TOTAL=... ARGS=--commit
backfill-cost:
	python3 scripts/backfill-observed-cost.py \
	  --model "$(MODEL)" --day "$(DAY)" --total "$(TOTAL)" $(ARGS)

# Print the book without touching the network: books, register, recent
# changes, per-model price + whether the oracles agree, unpriced models.
pricing-report:
	npx tsx scripts/sync-pricing.ts --report

# Raise inotify watch ceiling for the current boot.
# Fails with "permission denied" if not root — re-run with `sudo make fix-watches`.
# Not a dependency of `dev` so the hot path stays sudo-free.
fix-watches:
	sysctl fs.inotify.max_user_watches=524288

# Persist the watch ceiling across reboots — one-time setup.
# Fails on permission error if not root — re-run with `sudo make persist-watches`.
persist-watches:
	echo 'fs.inotify.max_user_watches=524288' > /etc/sysctl.d/90-inotify.conf
	sysctl --system

# 4GB Node heap — the prior 1GB cap was OOM-killing next dev on this monorepo,
# which presented as random "dev server crashed, hard restart" symptoms.
dev:
	NODE_OPTIONS=--max-old-space-size=4096 npm run dev

# Sweep tool-results spill files into our blob store before Claude Code's
# 30-day cleanupPeriodDays deletes them. Ingest does this per-session already;
# run this to catch files that predate that change or to force a pass after
# ingest downtime. Idempotent.
rescue-tool-results:
	npx tsx scripts/rescue-tool-results.ts
