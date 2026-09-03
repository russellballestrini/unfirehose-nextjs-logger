# 3971: SDKs vs the unfirehose/1.0 spec

**Status:** blocked
**Project:** unfirehose-nextjs-logger (SDK lives in ~/git/unfirehose-sdks)
**Estimated:** 30m
**Blocked by:** fox — creating the public repo is an outward-facing decision
**Todo IDs:** 3971

## Audit, 2026-09-03

Spec objects in `@unturf/unfirehose-schema@1.2.0`: session, message,
content-block, usage, todo, todo-event, metric, datapoint, project,
tool-definition, alert-threshold, **throttle**, training-run-event.

| SDK | covers | gap |
|---|---|---|
| Go (`unfirehose-sdks/go`) | all of the above except throttle | **fixed** — LogThrottle added, 7eebd58 |
| TypeScript (`@unturf/unfirehose`) | reads and ingests every object | **no writer** — it is a consumer, not a client |

### Defect found and fixed: nothing the Go SDK wrote was ever ingested

It emitted `~/.unfirehose/canonical/{harness}/{id}.jsonl`. Discovery scans
`~/.{name}/unfirehose/` and `EXCLUDED_HARNESS_DIRS` contains
`unfirehose` — our own data directory. Every session it wrote was
invisible to the dashboard it was written for. Now writes
`~/.{harness}/unfirehose/{project-slug}/{id}.jsonl`, verified end to end:
a probe session ingested as its own harness and its throttle showed on the
refusals page with `upstream=nous, 502`.

`CANONICAL_ROOT` in `packages/core/db/ingest.ts:24` is a dead constant
pointing at that same unread path. Worth deleting so nobody implements
against it again.

## Blocked: the repo is not published

- `~/git/unfirehose-sdks` has **zero git remotes**; the work is local only.
- `github.com/russellballestrini/unfirehose-sdks` does not resolve;
  `proxy.golang.org` 404s the module.
- So `go get github.com/russellballestrini/unfirehose-sdks/go` fails for
  every reader. The clients page card now says "Source not yet published"
  (1d8feb56) instead of printing a command that cannot work.

**Needs fox:** create the public repo (GitHub, or git.unturf.com with a
matching module path), push, tag. Then the card goes back to a real
`go get` and I re-add it.

## Open question: a TypeScript writer

`@unturf/unfirehose` reads. Anyone wanting to WRITE unfirehose from
TypeScript has no SDK — they hand-roll JSONL, which the clients page now
documents honestly under "Build Your Own". A thin writer mirroring the Go
logger would be ~200 lines and would make the TS card mean what a reader
expects a client SDK to mean.
