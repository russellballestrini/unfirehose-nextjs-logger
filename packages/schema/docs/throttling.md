# Throttling Schema

## Why this is its own record type

A throttled call usually produces **no message**. The request failed before any
content existed to attach it to, so a field on `message` would have nothing to
sit on. `type: "throttle"` is written as its own JSONL line.

## Why `upstream` is the field that matters

A harness that calls one provider does not need this schema — you already know
who refused. A harness that **routes across providers** does, and it is the
only place the information exists.

uncloseai-cli reaches 469 models across openrouter, nous, grok, and two
self-hosted boxes. Its throttle output was:

```
error: vision call failed: LLM unreachable after 3 attempts [rate_limit]:
HTTP Error 429: Too Many Requests
```

Across the entire history that produced **214 of 230 throttling events that
cannot name an upstream**. "We were rate limited" is not actionable when the
remedy depends on which of five providers said no — spread load, switch the
vision model, back off one endpoint, or ignore it because it was our own GPU.
All four look identical in that line.

### It cannot be recovered downstream

Every approach was tried against real data before this schema was written:

| Approach | Why it fails |
|---|---|
| `message.endpoint` | Null on these rows — the call never became a message |
| `message.provider` | Says `local` for all uncloseai traffic: a harness label, not a routing fact |
| Nearest assistant model | Wrong for exactly this case — a failed `vision` call used the vision model, not the chat model the session was on |
| A `via <provider>` marker in the text | Does not exist. Searching every session returns `via bash`, `via pandoc`, `via service_call` — prose, not routing |

The provider is known at the moment of failure and nowhere afterwards.
**Record it there or lose it.**

## Fields, ranked by value

1. **`upstream`** — which provider refused. Alone, this makes the record useful.
2. **`model`** — the model of the *failing* call. Not the session default.
3. **`retryAfterSeconds`** — lets backoff follow what the provider actually
   asked for instead of a guess.
4. **`endpoint`** — attributes a self-hosted throttle to a specific box.

`operation` (`chat`, `vision`, `embed`) is worth setting even when `upstream`
is unknown: it narrows the fix without any routing information. In our data 34
throttles were vision calls, which points at the vision model directly.

## `kind` — four conditions, four responses

These all get called "rate limiting" and the difference decides what to do.
Retrying harder fixes none of them and makes `concurrency` actively worse.

| kind | Means | Response |
|---|---|---|
| `rate_limit` | Too many requests per unit time | Slow down, or spread across providers |
| `concurrency` | Too many calls in flight at once | Queue them — do not retry harder |
| `quota` | Plan or credit exhausted | Waiting does not help until it resets |
| `overloaded` | Provider out of capacity | Not caused by our usage; failover or wait |

## One event per failed call

Emit one `throttle` per call that was refused, not one per retry attempt. Use
`attempts` to record how many were made. Counting retries as separate events
overstates how often a provider actually refused — a single throttle with a
3-attempt backoff is one event with `attempts: 3`, not three events.

Set `recovered: true` when a later attempt or a failover succeeded. That
separates a throttle absorbed by backoff from one that cost the user a turn.

## Example

```jsonc
{
  "$schema": "unfirehose/1.0",
  "type": "throttle",
  "sessionId": "0550a881-519c-4011-93eb-af5db7ba21f7",
  "timestamp": "2026-08-26T00:17:03.812Z",
  "kind": "rate_limit",
  "upstream": "openrouter",
  "endpoint": "https://openrouter.ai/api/v1/chat/completions",
  "model": "qwen/qwen3.8-27b",
  "operation": "vision",
  "httpStatus": 429,
  "retryAfterSeconds": 12,
  "attempts": 3,
  "recovered": false,
  "message": "HTTP Error 429: Too Many Requests",
  "harness": "uncloseai",
  "cwd": "/home/fox/git/contra"
}
```

## Failover

When the harness reroutes after a refusal, set `failoverTo`:

```jsonc
{
  "type": "throttle",
  "kind": "rate_limit",
  "upstream": "openrouter",
  "failoverTo": "nous",
  "recovered": true,
  "attempts": 1
}
```

Repeated failover away from one provider is a signal about that provider, and
it is only visible if both ends of the hop are recorded.

## Consumer behaviour

A consumer MUST render a missing `upstream` as *unknown*, never as a blank or
an absent row. The distinction between "nothing throttled us" and "something
throttled us and did not say who" is the whole point of the field, and
collapsing them reports a clean bill of health that was never measured.
