# 3018: Training Run Observability — Generic Schema + Ingestion

**Status:** open
**Project:** unfirehose
**Estimated:** 4-6h across multiple sessions
**Blocked by:** fox approval on schema design and adapter priority

## Context

The uncloseai-cli training stack (`training_proxy.py`, `loss-chart.py`, `live-loss-dashboard.html`, `evals.py`) produces rich training observability data — loss curves, checkpoints, mid-training samples, eval scores. This data currently lives in an isolated HTML dashboard polling `training.ai.unturf.com`.

Unfirehose already treats `claude-code`, `fetch`, and `uncloseai` as harness types with standardized JSONL ingestion. Training runs should be another harness type — but designed generically so it works with any training system, not just unturf's Double Dragon proxy.

## Schema: `unfirehose/1.0/training-run`

Six event types, all JSONL:

```jsonl
{"type":"run.start",      "run_id":"abc", "model":"megachat-v7", "config":{"n_embd":384,"steps":50000}, "ts":"..."}
{"type":"run.loss",        "run_id":"abc", "step":100,  "loss":5.23, "lr":0.001, "ts":"..."}
{"type":"run.sample",      "run_id":"abc", "step":1000, "text":"The king said...", "loss":3.4, "ts":"..."}
{"type":"run.checkpoint",  "run_id":"abc", "step":5000, "path":"/tmp/ck-5000.bin", "size_bytes":12345, "ts":"..."}
{"type":"run.eval",        "run_id":"abc", "step":5000, "eval":"hellaswag", "score":0.45, "ts":"..."}
{"type":"run.end",         "run_id":"abc", "final_loss":2.1, "wall_ms":3600000, "ts":"..."}
```

## Adapters (industry-generic)

| Adapter | Source | How |
|---------|--------|-----|
| `adapter-http` | Any server with `/loss`, `/checkpoints` endpoints | Poll JSON, emit JSONL |
| `adapter-wandb` | Weights & Biases API | Poll run metrics |
| `adapter-mlflow` | MLflow tracking server | Poll REST API |
| `adapter-tfevents` | TensorBoard event files | Read `events.out.tfevents.*` |
| `adapter-stdout` | Any training script | Parse `step=N loss=X.XX` from stdout |
| `adapter-jsonl` | Already-formatted logs | Direct ingest (zero-config) |

`adapter-stdout` is the universal one — works with PyTorch, JAX, Keras, llama.cpp, anything that prints loss.

## Plan

### Phase 1: Schema + DB (1-2h)
1. Add `training-run` event types to `packages/schema`
2. Add `training_runs` and `training_events` tables to SQLite schema
3. Ingestion pipeline: JSONL → parse → insert (same pattern as existing harnesses)

### Phase 2: Adapter — HTTP proxy (1h)
4. `adapter-http` that polls any `/loss`, `/checkpoints`, `/samples` endpoint
5. Configurable base URL (defaults to `TRAINING_PROXY_URL` env var)
6. Emits standard JSONL that existing ingestion picks up

### Phase 3: Dashboard page (2-3h)
7. `/training` page with:
   - Active + recent runs list
   - Recharts loss curves with EMA smoothing (port from `live-loss-dashboard.html`)
   - Phase detection (random → frequency → structure → coherence → knowledge)
   - Checkpoint timeline
   - Mid-training sample viewer (coherence timeline)
   - Eval score progression
8. Correlate training runs with agent conversations on same node/time window
9. Link to infrastructure node running the training

### Phase 4: Adapter — stdout (1h)
10. `adapter-stdout` that wraps any command, parses loss from output
11. Regex patterns for common formats: `loss: 5.23`, `step 100 loss=5.23`, `train_loss: 5.23`
12. Usage: `unfirehose-adapter-stdout -- python train.py`

### Future
- `adapter-wandb`, `adapter-mlflow`, `adapter-tfevents` as demand arises
- Training cost estimation (GPU-hours × node wattage from mesh data)
- Loss prediction / convergence estimation

## Design Principles

- **Schema is the contract** — any system can emit these 6 event types
- **No proxy dependency** — adapters read from any source
- **Same ingestion pipeline** as existing harnesses — no special paths
- **Generic first** — nothing unturf-specific in the schema or adapters

## Reference Files

- `~/git/uncloseai-cli/microgpt/training_proxy.py` — Double Dragon proxy (endpoints to adapt from)
- `~/git/uncloseai-cli/scripts/live-loss-dashboard.html` — Existing dashboard (UI patterns to port)
- `~/git/uncloseai-cli/scripts/loss-chart.py` — CLI loss viewer (data shape reference)
- `~/git/uncloseai-cli/microgpt/evals.py` — Eval integration (eval schema reference)
- `packages/schema/` — Existing unfirehose schema definitions
- `packages/core/db/schema.ts` — SQLite schema to extend
