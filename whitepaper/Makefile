SLUG = merkle-providence-reverse-rag-whitepaper
VENV = venv
PIP = $(VENV)/bin/pip
RST2PDF = $(VENV)/bin/rst2pdf

# Static-host targets that serve $(SLUG).pdf publicly. Each entry must
# exist as a directory; `make publish` copies the freshly-built PDF to
# every entry & stages it for commit in that repo. Add new entries as
# new public hosts come online — single source of truth for where the
# paper lives. Override with PUBLISH_TARGETS=... for a one-shot custom
# sync.
PUBLISH_TARGETS = \
    ../apps/web/public \
    ../../unsandbox.com/priv/static

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

# Sync the freshly-built PDF to every static host in $(PUBLISH_TARGETS).
# Does NOT commit — each target repo owns its own commit message and
# audit log. Reports per-target status so a missing host fails loud
# rather than silently mis-syncing.
publish: $(SLUG).pdf
	@for t in $(PUBLISH_TARGETS); do \
		if [ -d "$$t" ]; then \
			cp $(SLUG).pdf "$$t/$(SLUG).pdf"; \
			echo "  → $$t/$(SLUG).pdf"; \
		else \
			echo "  ✗ $$t (not found, skipped)"; \
		fi; \
	done
	@echo ""
	@echo "PDF synced to all reachable hosts. Commit each target repo"
	@echo "individually so each carries its own audit message."

.PHONY: all clean clean-all pdf publish
