.PHONY: all clean test coverage coverage-check coverage-report cc crap dupes orphans report \
        test-core test-ui test-web test-scripts \
        cov-core cov-ui cov-web cov-scripts \
        dev fix-watches persist-watches rescue-tool-results pricing pricing-report

# Everything a change should pass before it is pushed.
all: test

# Suites that emit coverage, in dependency order. apps/worker and
# packages/router have none yet — adding one here is the whole wiring.
COVERED := packages/core packages/ui apps/web scripts

# Vitest writes coverage-final.json per workspace; every report below reads
# those rather than re-running anything, so looking twice costs nothing.
COVERAGE_REPORTERS := --coverage.reporter=text-summary --coverage.reporter=json --coverage.reporter=html

# Measuring and gating are different jobs. `make coverage` measures, so it
# must not stop at the first workspace under its threshold — the report is
# the point, and a run that aborts leaves the later workspaces unmeasured.
# `make coverage-check` is the gate, and honours what each vitest.config
# declares.
NO_THRESHOLDS := --coverage.thresholds.lines=0 --coverage.thresholds.statements=0 \
                 --coverage.thresholds.functions=0 --coverage.thresholds.branches=0

# The four suites are independent, so they run at once. Serially this was a
# minute and a half of mostly-idle waiting. Target names cannot carry the
# workspace path — make reads a slash as a directory — so each has a short
# name and cd's itself.
test:
	@$(MAKE) -j4 --no-print-directory test-core test-ui test-web test-scripts

test-core:
	@echo "==> packages/core"; cd packages/core && npx vitest run
test-ui:
	@echo "==> packages/ui"; cd packages/ui && npx vitest run
test-web:
	@echo "==> apps/web"; cd apps/web && npx vitest run
test-scripts:
	@echo "==> scripts"; cd scripts && npx vitest run

cov-core:
	@echo "==> packages/core"; cd packages/core && npx vitest run --coverage $(COVERAGE_REPORTERS) $(NO_THRESHOLDS)
cov-ui:
	@echo "==> packages/ui"; cd packages/ui && npx vitest run --coverage $(COVERAGE_REPORTERS) $(NO_THRESHOLDS)
cov-web:
	@echo "==> apps/web"; cd apps/web && npx vitest run --coverage $(COVERAGE_REPORTERS) $(NO_THRESHOLDS)
cov-scripts:
	@echo "==> scripts"; cd scripts && npx vitest run --coverage $(COVERAGE_REPORTERS) $(NO_THRESHOLDS)

# Run every suite under coverage, then print what they reached. HTML lands
# in <workspace>/coverage/index.html for line-by-line reading.
#   make coverage
#   make coverage ARGS="--worst 40 --json reports/coverage.json"
coverage:
	@$(MAKE) -j4 --no-print-directory cov-core cov-ui cov-web cov-scripts
	@npx tsx scripts/quality/report-coverage.ts $(ARGS)

# Every ceiling in one target, for CI. Coverage is a floor per workspace;
# crap and duplication are budgets for the whole repo. Lower the budgets
# whenever the real number drops — a ceiling left where it was written is a
# gate that stopped guarding, which is what our coverage thresholds had
# quietly become.
CRAP_BUDGET  ?= 21100
DUPE_BUDGET  ?= 1950

quality-gate: coverage-check
	@npx tsx scripts/quality/report-crap.ts --budget $(CRAP_BUDGET)
	@npx tsx scripts/quality/report-dupes.ts --budget $(DUPE_BUDGET)

# The gate: fail where a workspace sits under the thresholds its own
# vitest.config sets.
coverage-check:
	@for d in $(COVERED); do \
	  echo "==> $$d"; (cd $$d && npx vitest run --coverage $(COVERAGE_REPORTERS)) || exit 1; \
	done

# Print the last coverage run without repeating it.
coverage-report:
	npx tsx scripts/quality/report-coverage.ts $(ARGS)

# Cyclomatic complexity — how many paths run through each function. Reads
# source only, so it works on code no test has ever touched.
#   make cc
#   make cc ARGS="--min 20 --dir apps/web"
cc:
	npx tsx scripts/quality/report-cc.ts $(ARGS)

# CRAP: complexity squared times uncovered cubed, plus complexity. Ranks
# what is both hard to change and unprotected while you change it. Needs a
# coverage run first — `make coverage`.
#   make crap
#   make crap ARGS="--threshold 60 --top 50"
crap:
	npx tsx scripts/quality/report-crap.ts $(ARGS)

# Copy-paste, matched on structure so renamed variables cannot hide it.
#   make dupes
#   make dupes ARGS="--min 100 --dir apps/web"
dupes:
	npx tsx scripts/quality/report-dupes.ts $(ARGS)

# Files and exports nothing reaches, walked out from every real entry point.
#   make orphans
#   make orphans ARGS=--exports
orphans:
	npx tsx scripts/quality/report-orphans.ts $(ARGS)

# All four, with a machine-readable copy of each under reports/.
report: coverage
	@npx tsx scripts/quality/report-coverage.ts --json reports/coverage.json >/dev/null
	@npx tsx scripts/quality/report-cc.ts --json reports/cc.json
	@npx tsx scripts/quality/report-crap.ts --json reports/crap.json
	@npx tsx scripts/quality/report-dupes.ts --json reports/dupes.json
	@npx tsx scripts/quality/report-orphans.ts --json reports/orphans.json
	@echo "\nreports/{coverage,cc,crap,dupes,orphans}.json"

clean:
	rm -rf reports packages/*/coverage apps/*/coverage

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
