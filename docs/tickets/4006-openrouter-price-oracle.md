# 4006 — OpenRouter as our price oracle

**Status:** done
**Opened:** 2026-08-25
**Closed:** 2026-08-25

## Problem

`packages/core/pricing.ts` carries a hand-maintained `PRICING` table of Anthropic
models. Anything absent from that table costs `$0.00`. Two consequences, both
live on our dashboard right now:

### 1. Our largest consumer reports free

28-day window, from `~/.unfirehose/unfirehose.db`:

| model | input | output | cache read | cache write | reported |
|---|---|---|---|---|---|
| `claude-opus-5` | 151K | 28.5M | 12,136M | 144M | **$0.00** |

`claude-opus-5` was never added to `PRICING`. At `anthropic/claude-opus-5` rates
that window is worth roughly **$7,700**. Our Model Usage panel renders it as
free, directly under `fable-5` at `$14,389.64`. Every cost number that sums
`calcCost` — dashboard, tokens, scrobble, usage/plan, project detail — is wrong
by that amount.

A hand-maintained table fails in exactly one direction: silently, and always on
our newest model, which is also our most expensive one. This is not a missed row.
It is the wrong data structure.

### 2. Self-host energy math bills prefill at decode speed

`selfHostCost` does `totalTokens / hw.tokensPerSecond`, applying a single
decode-rate constant to input, output, and cache tokens alike.

`Lorbus/Qwen3.6-27B-int4-AutoRound` logged 1,091.9M input + 15.0M output in 28
days. Current math: `1106.9M / 70 tok/s` = 15.8M seconds = **183 days of
continuous GPU time inside a 28-day window.** Physically impossible.

Prefill is compute-bound and batched — thousands of tok/s. Decode is
memory-bandwidth-bound and serial — tens of tok/s. Treating them as one rate
overstates local cost by roughly the ratio between them, which is exactly the
number that decides whether moving work off Claude looks worth it.

### 3. Local and cloud costs share a column but not a unit

`Lorbus/Qwen3.6-27B-int4-AutoRound` shows `$623.31` — an *electricity* figure —
in the same column as `fable-5`'s `$14,389.64`, an Anthropic *invoice* figure.
Reading down that column implies local inference is a meaningful fraction of our
Claude spend. It is not the same quantity, and the comparison it invites is
backwards.

## Approach

**OpenRouter (`GET https://openrouter.ai/api/v1/models`) becomes our price
oracle.** Public endpoint, no auth, no credential handling — clean under
Operation Voyeur. 418 models, and it already carries every model we log:
`anthropic/claude-opus-5`, `anthropic/claude-fable-5`, `qwen/qwen3.6-27b`,
`qwen/qwen3.8-27b`, `stealth/ox-alpha`, `x-ai/grok-4.20`.

1. **`model_pricing` table**, synced daily by `apps/worker`. Prices survive
   restarts and offline periods; a failed fetch changes nothing.
2. **`pricing.ts` stays pure** — no DB, no network. It is a published npm export
   and client-reachable. The catalog is injected into a module-level map;
   the hardcoded table remains as cold-start fallback.
3. **Alias resolution** maps our logged names onto OpenRouter ids —
   `claude-opus-5` → `anthropic/claude-opus-5`, `claude-opus-4-8` →
   `anthropic/claude-opus-4.8`, `Lorbus/Qwen3.6-27B-int4-AutoRound` →
   `qwen/qwen3.6-27b`. Context-window tags (`[1m]`) and quantization suffixes
   (`-int4-AutoRound`, `-AWQ`) are stripped before matching.
4. **Split prefill from decode** in the energy model. Separate
   `prefillTokensPerSecond` and `tokensPerSecond` per hardware entry.
5. **Two costs, never conflated:**
   - `costUSD` — what we actually pay. Market rate for cloud, electricity for local.
   - `marketUSD` — what these tokens would cost on OpenRouter regardless of who served them.
   - `avoidedUSD` — `marketUSD − costUSD`, and only for self-hosted rows.

   That third number is the Prime Mission's measuring instrument. Every token
   moved onto our own hardware should show up there. Today it shows up nowhere.
6. **Test fixtures price at zero explicitly** (`mock-1m`, `fake-model-1`,
   `<synthetic>`) — marked `synthetic`, distinct from "we do not know."

## Files

- `packages/core/pricing.ts` — catalog registry, alias resolution, prefill/decode split, dual cost
- `packages/core/pricing-sync.ts` — OpenRouter fetch, DB upsert, hydrate (server only)
- `packages/core/db/schema.ts` — `model_pricing` table
- `apps/web/src/app/api/pricing/route.ts` — inspect catalog / force sync
- `apps/worker/src/main.ts` — hydrate on boot, sync daily
- `apps/web/src/app/api/dashboard/route.ts`, `api/tokens/route.ts` — surface `marketUSD` / `avoidedUSD`

## Result

28-day window, measured before and after:

| model | before | after | market | saved |
|---|---|---|---|---|
| `claude-opus-5` | **$0.00** | **$7,694.23** | $7,694.23 | — |
| `claude-fable-5` | $14,389.64 | $14,609.74 | $14,609.74 | — |
| `claude-opus-4-8` | $4,549.84 | $4,555.15 | $4,555.15 | — |
| `Lorbus/Qwen3.6-27B-int4-AutoRound` ⚡ | $623.31 | **$22.78** | $397.34 | **$374.56** |
| `stealth/ox-alpha` | $0.00 ⚡local | **$23.58** | $23.58 | — |
| `mock-1m`, `fake-model-1` | $0.00 | **—** `synthetic` | — | — |

**$7,342 of real spend was invisible.** `claude-opus-5` alone accounted for it.

Self-hosted Qwen went the other way: it was never a $623 line, it was a **$22.78**
electricity line against **$397.34** of market rate. Our own hardware saved
**$374.56** over that window, and the dashboard now says so in its own column
instead of burying an energy figure among invoices.

Two oracles live: OpenRouter 418 models, Nous 372. Nous resells consistently
below list (`claude-opus-5` $5/$25 vs $4/$20; `hermes-4-70b` $0.13 vs $0.05),
so the preference order is a real lever, not decoration.

### A third defect, found on the way

fox flagged `stealth/ox-alpha` badged `⚡local` when it runs on OpenRouter and
Nous. Root cause was in `db/schema.ts`, not in the cost math: a backfill stamped
`provider='local'` onto every uncloseai-harness message. That encodes "our
harness served it" and was being read as "our GPU served it" — 4,206 messages
and 63M tokens of cloud inference filed as electricity.

The backfill no longer asserts it, and `isSelfHosted` now decides from endpoint
and model identity, treating a quantized artifact (`-int4-AutoRound`, `-AWQ`,
`.gguf`) as ours and a bare catalog id (`qwen/qwen3.6-27b`) as hosted. Rows
already stamped are left alone; nothing trusts the column alone any more.

### Coverage

20 of 25 models with real tokens now price. The 5 that do not (8.3M tokens
total) are genuinely absent from both oracles — Hermes-3 **8B** (they carry only
70B and 405B), NousCoder-14B, VibeThinker-3B, and a bare `qwen` string too vague
to resolve. They render `—`, never `$0.00`. `GET /api/pricing` lists them so the
gap stays visible instead of silently reading as free.

Deliberately NOT pinned: Hermes-3 8B to the 70B rate. It would have produced a
market number we cannot defend.

## Done when

- No model with tokens reports `$0.00` unless it is genuinely free or synthetic
- `costSource` distinguishes `openrouter` / `table` / `energy` / `synthetic` / `unknown`
- Self-host cost reflects a GPU-time figure that fits inside the wall-clock window
- Dashboard shows what local inference saved us, not what it cost in the wrong unit
- Sync degrades closed: no network, no crash, previous prices retained
