# 3971: SDKs vs the unfirehose/1.0 spec

**Status:** blocked
**Project:** unfirehose-nextjs-logger (SDK lives in ~/git/unfirehose-sdks)
**Estimated:** 30m
**Blocked by:** fox — two clicks in GitLab (visibility, and deleting a stray project)
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

## Home: our own GitLab (2026-09-03)

Repo lives at `git.unturf.com/engineering/unturf/unfirehose/unfirehose-sdks`,
inside the unfirehose group beside the dashboard. Module path follows it:
`git.unturf.com/engineering/unturf/unfirehose/unfirehose-sdks/go`. Tagged
`go/v0.1.0` — the module sits in a `go/` subdirectory, so Go requires the
subdirectory as a tag prefix and a bare `v0.1.0` would be invisible.

Verified before committing to this path: GitLab serves the `go-import` meta
tag for public projects, **including for a subdirectory module** — a request
for `/group/project/helpers?go-get=1` returns the project root. So no vanity
domain is needed and the SSH port is irrelevant; Go clones over HTTPS 443.

### Two things only fox can do

1. **Set the project to Public.** While private, `?go-get=1` returns a
   *wrong* meta tag — it falls back to the deepest publicly resolvable path
   and answers `git.unturf.com/engineering/unturf`, which would send Go to
   clone the group. `go get` cannot work until visibility flips.
2. **Delete the stray project** at
   `git.unturf.com/engineering/unturf/unfirehose-sdks` (no group). I created
   it by push-to-create before you said where it belonged; it holds the same
   two commits and nothing else. Deleting needs the web UI or an API token,
   neither of which this session touched.

Then: proxy.golang.org must be able to reach git.unturf.com to cache and
checksum the module. It is internet-facing with valid TLS, so it should —
if it cannot, consumers need `GOPRIVATE=git.unturf.com`.

## Superseded: the github path

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
