# 4007 — uncloseai-cli should name the upstream that throttled it

**Status:** done — implemented 2026-08-26 in `~/git/uncloseai-cli` and here
**Opened:** 2026-08-26
**Raised by:** fox, on the Rate Limits dashboard — "can we see which upstreams
are limiting? uncloseai-cli might need adjustments"

## Problem

uncloseai-cli routes across 469 models on five providers — openrouter, nous,
grok, and our own qwen and hermes boxes. When one of them throttles us, the
error it writes to JSONL is:

```
error: vision call failed: LLM unreachable after 3 attempts [rate_limit]:
HTTP Error 429: Too Many Requests. If the active model has no vision support,
switch with /model or set UNCLOSE_VISION_MODEL to a VL endpoint.
```

The provider that refused is not in it. Nor is the model, the endpoint, or the
Retry-After the provider sent. Measured over our whole history: **115 of 119
uncloseai throttling events cannot name an upstream.** The four that can only
manage it because `openrouter.ai` happened to appear elsewhere in the same
error body.

This matters more for uncloseai-cli than for any other harness precisely
because it is the one that routes. "We were rate limited" is not actionable
when the fix depends on which of five providers said no — spread load, switch
the vision model, back off one endpoint, or ignore it because it was our own
GPU. Right now every one of those looks identical in the log.

### What we tried on our side first

- **`messages.endpoint` / `messages.provider`** — both null on these rows, and
  `provider` says `local` for all uncloseai traffic regardless of where the
  call went (a harness label, not a routing fact — same defect that made
  ox-alpha price as electricity).
- **Inferring from the session's model** — wrong for exactly this case. A
  `vision call failed` used `UNCLOSE_VISION_MODEL`, not the chat model, so the
  nearest assistant message names the wrong one.
- **The `· via nous ·` routing marker** seen in a Claude message describing a
  proposed status line — it does not exist in the JSONL. Searching for `via X`
  across every uncloseai session returns `via bash`, `via pandoc`,
  `via service_call`: prose, not routing.

The information is not recoverable downstream. It has to be recorded at the
point of failure.

## What we need

In the exception path that produces `LLM unreachable after N attempts
[<tag>]`, include what the CLI already has in hand:

```
error: vision call failed: LLM unreachable after 3 attempts [rate_limit]:
  provider=openrouter model=qwen/qwen3.8-27b endpoint=openrouter.ai
  status=429 retry_after=12s
```

Any shape works — our detector reads hostnames, `provider=`/`upstream=` pairs,
and `"provider":"..."` JSON. What matters is that the provider is named.

Ranked by value to us:

1. **provider** — which upstream refused. Alone, this closes the ticket.
2. **model** — which model was being served when it happened.
3. **retry_after** — we already parse it when present; currently always absent,
   so the dashboard's avg retry-after column is empty for every uncloseai row.
4. **endpoint host** — lets us attribute to a specific box for self-hosted.

## Done when

- A `[rate_limit]` line from uncloseai-cli names its provider
- `/rate-limits` shows a real upstream instead of "not reported" for new events
- Retry-after is populated, so backoff advice can be based on what the provider
  actually asked for rather than a guess

## Notes

Nothing is blocked on this. `/rate-limits` already groups by upstream, counts
how many events cannot name one, and states plainly that the gap is in the
harness rather than in the table. It gets more useful the moment the CLI
starts reporting; until then it is honest about what it does not know.

`operation` is already extracted from the existing text (`vision`, `llm`), and
is the most useful thing currently available: 34 of our throttles are vision
calls, which points at `UNCLOSE_VISION_MODEL` without needing any change
upstream.


## Resolution

Implemented on both sides.

**Spec** — `unfirehose/1.0` gained a first-class `throttle` record
(`packages/schema/json-schema/throttle.json`, `docs/throttling.md`, schema
package 1.2.0). Its own type rather than a field on `message`, because a
throttled call produces no message: the request fails before any content
exists to attach it to. The doc records the four downstream approaches that
were tried and why each fails, so nobody retries them.

**uncloseai-cli** — `unfirehose.Session.throttle()` writes the record.
`llm_transport` emits it at both points a refusal is final:

- retry exhaustion, with `recovered: false`
- failover, with `recovered: true` and `failoverTo` — recording both ends
  makes routing pressure visible

`upstream` resolves through the existing `_provider_label` hook, which the
routing layer already maintained and never logged. `retryAfterSeconds` reads
the Retry-After header then the error text. `operation` comes from the `label`
argument callers already pass (`vision`, `planning`), threaded into
`_unclose_chat_attempts`. ERR_AUTH is deliberately not a throttle kind: a 401
is a broken key, and folding it in would report throttling that never happened.

**unfirehose** — ingest handles `type: "throttle"` directly, writing to
`rate_limit_events` with `rule = 'harness-reported'`. The text scanner skips a
block when a harness-reported event covers the same session within 60 seconds,
so the record and the error text it also printed are not counted twice. The
record wins, because it names the upstream and the text never can.

Verified: 3,051 uncloseai-cli tests pass; a written record round-trips to the
dashboard grouped under `upstream: openrouter`.
