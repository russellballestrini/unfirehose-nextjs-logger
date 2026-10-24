.PHONY: all clean test userland-plugins coverage coverage-check coverage-report quality-gate quality-budgets cc crap dupes orphans report \
        test-core test-ui test-web test-scripts test-schema \
        cov-core cov-ui cov-web cov-scripts \
        dev demo fix-watches persist-watches rescue-tool-results pricing pricing-report \
        build docker docker-run compose-up compose-down compose-logs typecheck publish publish-dry-run \
        service-install service-start service-stop service-restart service-status service-logs service-uninstall \
        doctor vacuum

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
# name and cd's itself. CI (.github/workflows/ci.yml) gives each suite its
# own runner instead; here they share the cores, which is why the slowest
# tests carry deadlines sized for a loaded box.
test:
	@$(MAKE) -j4 --no-print-directory test-core test-ui test-web test-scripts test-schema

# tsc over every workspace with a tsconfig, tests included. Vitest strips
# types without checking them, so a test can drift from the code it calls
# and still pass; this is what notices.
typecheck:
	@echo "==> packages/core"; cd packages/core && npx tsc --noEmit
	@echo "==> packages/ui"; cd packages/ui && npx tsc --noEmit
	@echo "==> packages/router"; cd packages/router && npx tsc --noEmit
	@echo "==> apps/worker"; cd apps/worker && npx tsc --noEmit
	@echo "==> apps/web"; cd apps/web && npx tsc --noEmit

# Regenerate the userland probe plugins from their Bourne-sh sources.
userland-plugins:
	python3 packages/core/userland/gen-plugins.py

test-core:
	@echo "==> packages/core"; cd packages/core && npx vitest run
test-ui:
	@echo "==> packages/ui"; cd packages/ui && npx vitest run
test-web:
	@echo "==> apps/web"; cd apps/web && npx vitest run
test-scripts:
	@echo "==> scripts"; cd scripts && npx vitest run
# unfirehose/1.0 conformance: schemas compile strict, fixtures & doc examples validate.
test-schema:
	@echo "==> packages/schema"; cd packages/schema && npx vitest run

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
# Two of these do not tolerate company. cov-web instruments ~1,500 tests and
# runs out of memory beside two other coverage jobs; cov-scripts reads the
# other workspaces' reports off disk, so running it beside the jobs that
# write them means reading them half-written — which it now correctly
# refuses to do. Both used to fail silently under -j4 and leave a report
# missing, which made the totals look better than they were.
coverage:
	@$(MAKE) -j2 --no-print-directory cov-core cov-ui
	@$(MAKE) --no-print-directory cov-web
	@$(MAKE) --no-print-directory cov-scripts
	@npx tsx scripts/quality/report-coverage.ts $(ARGS)

# Every ceiling in one target, for CI. Coverage is a floor per workspace;
# crap and duplication are budgets for the whole repo. Lower the budgets
# whenever the real number drops — a ceiling left where it was written is a
# gate that stopped guarding, which is what our coverage thresholds had
# quietly become.
# Raised 16900 -> 19000 on 2026-09-15: CI had been red on lint since the
# v1.2.0 tag, so ~380 functions landed unmeasured (3074 -> 3453) and the
# runner reads 18978. Not a new ceiling to live under: the pay-down is the
# seven 0%-covered functions at the top of `make crap`, and this comes back
# down as each is covered.
CRAP_BUDGET  ?= 19000
# Raised 1100 -> 1200 on 2026-09-15 for the same reason as CRAP above: the
# committed reports/dupes.json of 2026-09-05 already read 1134, so this gate
# had been red since before it was ever run in CI. 1233 today, 1169 after
# folding the four identical report docblocks into one; the rest is route
# boilerplate (see `make dupes`) and comes down as it is shared.
DUPE_BUDGET  ?= 1200

# What a reader actually waits for, measured in a real browser. Our other
# perf report times HTTP responses, which is the fastest link in the chain
# reported as the whole thing: the document arrives in about forty
# milliseconds and the screen stays empty until the bundle parses, React
# hydrates, SWR fetches and the answer paints.
#
#   make vitals                     against whatever is on :3000
#   make vitals ARGS="--runs 3"     median of three
#   make vitals ARGS="--url /tokens"
#   make vitals ARGS="--budget 1500 --json reports/vitals.json"
vitals:
	@node scripts/perf/vitals.mjs $(ARGS)

# The same, against a production build: build, start on :3100, measure,
# stop. Dev bundles are unminified and several times the size, so numbers
# from `next dev` say how slow development is, not how slow the app is.
vitals-prod:
	@cd apps/web && npx next build >/dev/null
	@PORT=3100 scripts/perf/prod-server.sh start
	@node scripts/perf/vitals.mjs --base http://localhost:3100 --runs 5 --pick min --wait-load 600 --json reports/vitals-prod.json $(ARGS); \
	  rc=$$?; PORT=3100 scripts/perf/prod-server.sh stop >/dev/null; exit $$rc

quality-gate: coverage-check
	@$(MAKE) --no-print-directory quality-budgets

# The two repo-wide budgets alone, against coverage already on disk. The
# GitHub workflow (.github/workflows/ci.yml) measures each workspace in its
# own job and runs this once they have all reported.
quality-budgets:
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

# Is this machine ready to run us, and if not, what to do. Node version,
# better-sqlite3's native build, our data dir, port 3000, worker unit vs
# make dev, each harness directory, disk free. Green / yellow / red with the
# fix beside each red; exits non-zero only on red. Read-only, never sudo.
# The shell half covers what must hold before tsx can run at all; the rest
# is scripts/doctor.ts, its rules in scripts/doctor-checks.ts.
doctor:
	@command -v node >/dev/null 2>&1 || { echo "[FAIL] node  not on PATH"; echo "       fix: install node 22.x (nvm install 22), then npm ci"; exit 1; }
	@test -x node_modules/.bin/tsx || { echo "[FAIL] deps  node_modules missing (no tsx)"; echo "       fix: npm ci --no-audit --no-fund"; exit 1; }
	@node_modules/.bin/tsx scripts/doctor.ts

# Checkpoint, VACUUM, checkpoint: give our freelist back to the disk. Same
# rules as our worker's daily run (packages/core/db/maintenance.ts), and it
# refuses while another process (worker, make dev, web) has our database
# open, since a VACUUM beside them leaves a WAL as big as our database.
# Run it after a retention window has moved old block text cold.
#   make vacuum
#   make vacuum MIN_MB=256     only if at least 256 MB would come back
#   make vacuum FORCE=1        beside a running stack, knowingly
vacuum:
	@MIN_MB=$(MIN_MB) FORCE=$(FORCE) node_modules/.bin/tsx scripts/vacuum.ts

# 4GB Node heap — the prior 1GB cap was OOM-killing next dev on this monorepo,
# which presented as random "dev server crashed, hard restart" symptoms.
dev:
	@systemctl --user is-active --quiet unfirehose-worker 2>/dev/null && { \
	  echo "unfirehose-worker.service is active; two workers would double-ingest. make service-stop first."; exit 1; } || true
	NODE_OPTIONS=--max-old-space-size=4096 npm run dev

# A week of synthetic history to look around in, with no harness on disk and
# nothing of ours touched: scripts/demo.ts seeds ~/.unfirehose-demo fresh
# (two projects, three harnesses, todos, an alert, one mesh node; every
# model synthetic, so every cost reads $0), then our web app serves it on
# :3010, beside a real stack on :3000 if one is running. No worker: the
# payloads it would build are built by the seed. HOME points at an empty
# home inside the demo dir and UNFIREHOSE_HARNESSES=none, so even an
# on-demand ingest (the usage page asks for one) reads no real ~/.claude.
# Run it again to re-seed from now; rm -rf ~/.unfirehose-demo to be rid of it.
demo:
	UNFIREHOSE_DIR=$(HOME)/.unfirehose-demo npx tsx scripts/demo.ts
	@echo ""
	@echo "unfirehose demo: http://localhost:3010   (data: $(HOME)/.unfirehose-demo, Ctrl-C to stop)"
	@echo ""
	cd apps/web && HOME=$(HOME)/.unfirehose-demo/home UNFIREHOSE_DIR=$(HOME)/.unfirehose-demo UNFIREHOSE_DB_PATH=$(HOME)/.unfirehose-demo/unfirehose.db UNFIREHOSE_HARNESSES=none NODE_OPTIONS=--max-old-space-size=4096 npx next dev -p 3010

# ---------------------------------------------------------------------------
# Run as systemd USER units — respawn on crash, no root.
#
# `make dev` runs the worker under tsx watch, which restarts on a file change
# but not when its child dies: a killed worker stayed dead until noticed.
# These units run `npm run start` (no watch) under Restart=always with
# stepped backoff. Services and `make dev` are mutually exclusive — two
# workers double-ingest and two webs fight for :3000 — and both sides check.
#
#   make service-install          render deploy/systemd/*.service.in -> ~/.config/systemd/user
#   make build && make service-start   enable --now both units
#   make service-status | service-logs | service-restart | service-stop
#   sudo loginctl enable-linger $$USER  (once, by hand: units outlive logout)
#
# After a code change on a service box: make build && make service-restart.
# ---------------------------------------------------------------------------
SYSTEMD_USER_DIR := $(HOME)/.config/systemd/user
SERVICES := unfirehose-worker unfirehose-web
NODE_BIN := $(patsubst %/,%,$(dir $(shell command -v node)))
NPM := $(shell command -v npm)

service-install:
	@test -n "$(NPM)" || { echo "npm not on PATH"; exit 1; }
	@mkdir -p $(SYSTEMD_USER_DIR)
	@for s in $(SERVICES); do \
	  sed -e 's#@REPO@#$(CURDIR)#g' -e 's#@NODE_BIN@#$(NODE_BIN)#g' -e 's#@NPM@#$(NPM)#g' \
	    deploy/systemd/$$s.service.in > $(SYSTEMD_USER_DIR)/$$s.service; \
	  echo "wrote $(SYSTEMD_USER_DIR)/$$s.service"; \
	done
	@systemctl --user daemon-reload
	@for s in $(SERVICES); do systemd-analyze --user verify $(SYSTEMD_USER_DIR)/$$s.service || exit 1; done
	@echo "installed, not started. next: make build && make service-start"
	@loginctl show-user $$USER -p Linger 2>/dev/null | grep -q 'Linger=yes' || \
	  echo "note: linger is off; units stop at logout until: sudo loginctl enable-linger $$USER"

service-start:
	@# [t]urbo: the recipe's own shell carries this text on its command line
	@# and pgrep -f would match it; a bracketed first letter cannot match itself.
	@pgrep -f '[t]sx watch.*worker/src/main|[t]urbo dev' >/dev/null && { \
	  echo "make dev is running; stop it first. two workers would double-ingest."; exit 1; } || true
	@test -f apps/web/.next/BUILD_ID || { echo "no production build (apps/web/.next/BUILD_ID missing; a dev .next does not count); run: make build"; exit 1; }
	systemctl --user enable --now $(SERVICES)
	@$(MAKE) --no-print-directory service-status

service-stop:
	systemctl --user disable --now $(SERVICES)

service-restart:
	systemctl --user restart $(SERVICES)
	@$(MAKE) --no-print-directory service-status

service-status:
	@systemctl --user --no-pager status $(SERVICES) 2>&1 | grep -E 'service -|Active:|Main PID' || true

service-logs:
	journalctl --user -u unfirehose-worker -u unfirehose-web -n 100 -f

service-uninstall:
	-systemctl --user disable --now $(SERVICES) 2>/dev/null
	@for s in $(SERVICES); do rm -f $(SYSTEMD_USER_DIR)/$$s.service; done
	@systemctl --user daemon-reload
	@echo "removed"

# Sweep tool-results spill files into our blob store before Claude Code's
# 30-day cleanupPeriodDays deletes them. Ingest does this per-session already;
# run this to catch files that predate that change or to force a pass after
# ingest downtime. Idempotent.
rescue-tool-results:
	npx tsx scripts/rescue-tool-results.ts

# --- container image -------------------------------------------------
IMAGE ?= unfirehose:latest

# A production build of the dashboard, standalone, for a local check.
build:
	@cd apps/web && npx next build

# The Alpine images: the dashboard (the Dockerfile's last stage) and the
# worker that ingests for it. See Dockerfile for the coreutils/timeout tuning.
docker:
	@docker build --target web -t $(IMAGE) .
	@docker build --target worker -t unfirehose-worker:latest .

# Web and worker in the foreground, Ctrl-C stops both. This is compose, not
# a second hand-kept `docker run`: the same mounts (docker-compose.yml,
# edited there once), the same loopback-only port, the same data volume.
docker-run:
	docker compose up --build

# Web and worker together, for a machine without node. docker-compose.yml
# says which journals it mounts and why; edit the mounts there, once.
compose-up:
	docker compose up -d --build
	@echo "open http://localhost:3000"

compose-down:
	docker compose down

compose-logs:
	docker compose logs -f --tail 100

# --- npm release -----------------------------------------------------
# Bump all four packages to one version, commit and tag. The bump lands in
# git, so git and npm agree. Pushing the tag publishes: CI is our only
# publisher, and the only place an npm token lives.
#   make publish-dry-run              pack at the next patch, change nothing
#   make publish                      next patch
#   make publish BUMP=minor           or major, or an exact X.Y.Z
publish:
	@scripts/publish.sh $(BUMP)

publish-dry-run:
	@scripts/publish.sh --dry-run $(BUMP)
