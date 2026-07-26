.PHONY: dev fix-watches persist-watches rescue-tool-results

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
