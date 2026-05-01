# merkle-providence-reverse-rag-whitepaper

Part of our permacomputer machine learning stack. See companion papers in sibling repos.

## Style

- Prefer "our" for shared things; "a" when something is one of many; avoid "the" — it implies fixed, singular ownership.
- **Never use "AI", always say "machine learning."**
- Use **&** instead of "and" in all permacomputer discourse.
- Use **URI** instead of "URL".
- **Never use em dashes, en dashes, or double hyphens** in prose. Use colons, commas, or periods instead.
- **Avoid "to be" verbs** (is, are, was, were, be, been, being). Prefer active, direct verbs.
- Never add `Co-Authored-By` lines to commits. Single-line commit messages only.

## Build

Requires Python 3 & rst2pdf:

```
make                  # creates venv, installs rst2pdf, builds PDF
make publish          # syncs PDF + landing HTML to every static host
make publish-and-commit  # plus auto-commits in each host repo
make clean            # removes PDF
```

Or use sibling repo venv:
```
~/git/reverse-retrieval-augmented-generation-whitepaper/venv/bin/rst2pdf merkle-providence-reverse-rag-whitepaper.rst -s whitepaper.style -o merkle-providence-reverse-rag-whitepaper.pdf
```

## Source of truth & publish flow

Two files live here as canonical & propagate to public hosts:

- `merkle-providence-reverse-rag-whitepaper.pdf` (built from `.rst`)
- `merkle-providence-reverse-rag.html` (landing page)

`make publish` copies both to every entry in `PUBLISH_TARGETS` (the
list lives in our Makefile so adding a new public host is a one-line
change). Editing the host-repo copy is a drift bug: edit here, run
publish.

`make publish-and-commit` is auto-commit-friendly. It stages only
the files in `PUBLISH_FILES` & writes a structured commit to each
host repo back-referencing this whitepaper's HEAD commit:

```
public(whitepaper): sync to whitepaper@<short-hash>

<whitepaper HEAD subject>

Auto-synced via 'make publish-and-commit'. Source of truth:
  ~/git/unfirehose-nextjs-logger/whitepaper @ <short-hash>
```

**Pre-approved for the agent**: running `make publish-and-commit`
without per-host fox-in-the-loop confirmation is fine. Same blast
radius as `make publish` plus a deterministic file-copy commit
that can be reverted with one `git revert`. Pushing the auto-commits
upstream still goes through fox approval — don't `git push` host
repos unless explicitly asked.

## Companion Papers

| Layer | Repo | Role |
|-------|------|------|
| Infrastructure | `~/git/machine-learning-agent-self-sandbox-algo-whitepaper` | Agents provision their own compute |
| Inference | `~/git/uncloseai.com/book` | HTTP clients across 46 languages |
| Context | `~/git/reverse-retrieval-augmented-generation-whitepaper` | Client-side context injection |
| Providence Cache | `~/git/unfirehose-nextjs-logger/whitepaper` (this paper) | Merkle-cached provenance for small models |
| Interaction | `~/git/categorization-and-feedback-is-all-you-need-whitepaper` | Categorization & feedback state machines |
