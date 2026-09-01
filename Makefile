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
