SLUG = merkle-providence-reverse-rag-whitepaper
HTML = merkle-providence-reverse-rag.html
VENV = venv
PIP = $(VENV)/bin/pip
RST2PDF = $(VENV)/bin/rst2pdf

# Static-host targets that serve $(SLUG).pdf & $(HTML) publicly.
# Each entry must exist as a directory; `make publish` copies both
# files to every entry. Add new entries as new public hosts come
# online — single source of truth for where the paper lives.
PUBLISH_TARGETS = \
    ../apps/web/public \
    ../../unsandbox.com/priv/static

# Files distributed to every PUBLISH_TARGETS entry. Source of truth
# for both lives here in whitepaper/. Editing the host-repo copy is
# a drift bug; edit here & run `make publish` (or
# `make publish-and-commit` for the same plus per-repo auto-commit).
PUBLISH_FILES = $(SLUG).pdf $(HTML)

all: $(SLUG).pdf

$(VENV):
	python3 -m venv $(VENV)
	$(PIP) install --upgrade pip
	$(PIP) install rst2pdf

$(SLUG).pdf: $(SLUG).rst whitepaper.style $(VENV)
	$(RST2PDF) $(SLUG).rst -s whitepaper.style -o $(SLUG).pdf

clean:
	rm -f $(SLUG).pdf

clean-all: clean
	rm -rf $(VENV)

pdf: $(SLUG).pdf

# Sync PDF + landing HTML to every static host in $(PUBLISH_TARGETS).
# Does NOT commit — each host repo owns its commit. A missing host
# fails loud rather than silently mis-syncing.
publish: $(SLUG).pdf
	@for t in $(PUBLISH_TARGETS); do \
		if [ -d "$$t" ]; then \
			for f in $(PUBLISH_FILES); do \
				cp "$$f" "$$t/$$f"; \
				echo "  → $$t/$$f"; \
			done; \
		else \
			echo "  ✗ $$t (not found, skipped)"; \
		fi; \
	done
	@echo ""
	@echo "Files synced to all reachable hosts. Run"
	@echo "  make publish-and-commit"
	@echo "to also auto-commit in each host repo."

# Sync + auto-commit each host repo with a structured message that
# back-references the whitepaper repo's HEAD commit. Stages only
# $(PUBLISH_FILES); never auto-commits unrelated working-tree state
# (uses pathspec discipline).
publish-and-commit: publish
	@WP_HEAD=$$(git rev-parse --short HEAD); \
	WP_SUBJECT=$$(git log -1 --pretty=%s); \
	for t in $(PUBLISH_TARGETS); do \
		if [ ! -d "$$t" ]; then continue; fi; \
		REPO_ROOT=$$(git -C "$$t" rev-parse --show-toplevel); \
		ANY_CHANGE=0; \
		for f in $(PUBLISH_FILES); do \
			REL_PATH=$$(realpath --relative-to="$$REPO_ROOT" "$$t/$$f"); \
			if ! git -C "$$REPO_ROOT" diff --quiet -- "$$REL_PATH" 2>/dev/null; then \
				ANY_CHANGE=1; \
				git -C "$$REPO_ROOT" add "$$REL_PATH"; \
			fi; \
		done; \
		if [ "$$ANY_CHANGE" = "1" ]; then \
			git -C "$$REPO_ROOT" commit -m "public(whitepaper): sync to whitepaper@$$WP_HEAD" \
				-m "$$WP_SUBJECT" \
				-m "Auto-synced via 'make publish-and-commit'. Source of truth:" \
				-m "  ~/git/unfirehose-nextjs-logger/whitepaper @ $$WP_HEAD"; \
			echo "  ✓ $$REPO_ROOT (committed)"; \
		else \
			echo "  = $$REPO_ROOT (no change)"; \
		fi; \
	done
	@echo ""
	@echo "Each host repo now has an auto-commit ready to push."

.PHONY: all clean clean-all pdf publish publish-and-commit
