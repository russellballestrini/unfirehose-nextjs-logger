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
make        # creates venv, installs rst2pdf, builds PDF
make clean  # removes PDF
```

Or use sibling repo venv:
```
~/git/reverse-retrieval-augmented-generation-whitepaper/venv/bin/rst2pdf merkle-providence-reverse-rag-whitepaper.rst -s whitepaper.style -o merkle-providence-reverse-rag-whitepaper.pdf
```

## Companion Papers

| Layer | Repo | Role |
|-------|------|------|
| Infrastructure | `~/git/machine-learning-agent-self-sandbox-algo-whitepaper` | Agents provision their own compute |
| Inference | `~/git/uncloseai.com/book` | HTTP clients across 46 languages |
| Context | `~/git/reverse-retrieval-augmented-generation-whitepaper` | Client-side context injection |
| Providence Cache | `~/git/unfirehose-nextjs-logger/whitepaper` (this paper) | Merkle-cached provenance for small models |
| Interaction | `~/git/categorization-and-feedback-is-all-you-need-whitepaper` | Categorization & feedback state machines |
