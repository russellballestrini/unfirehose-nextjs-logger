# Training Run — Harness Format

**Provider**: Any (PyTorch, JAX, Keras, llama.cpp, etc.)
**Status**: Supported
**Adapter**: HTTP, stdout, JSONL direct, W&B, MLflow, TFEvents (planned)

## Schema: `unfirehose/1.0/training-run`

Six event types covering the full training lifecycle. All events are JSONL, one per line.

## Event Types

### `run.start`

Emitted when a training run begins.

```jsonl
{"type":"run.start","run_id":"abc","model":"megachat-v7","config":{"n_embd":384,"steps":50000},"ts":"2026-03-09T00:00:00Z"}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `type` | `"run.start"` | yes | Event type |
| `run_id` | string | yes | Unique run identifier |
| `model` | string | yes | Model name or architecture |
| `config` | object | no | Training configuration (hyperparameters, dataset info) |
| `ts` | ISO 8601 | yes | Timestamp |

### `run.loss`

Emitted at each training step (or sampled interval).

```jsonl
{"type":"run.loss","run_id":"abc","step":100,"loss":5.23,"lr":0.001,"ts":"2026-03-09T00:01:00Z"}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `type` | `"run.loss"` | yes | Event type |
| `run_id` | string | yes | Run identifier |
| `step` | integer | yes | Training step number |
| `loss` | number | yes | Loss value |
| `lr` | number | no | Learning rate at this step |
| `ts` | ISO 8601 | yes | Timestamp |

### `run.sample`

Mid-training text samples for monitoring coherence progression.

```jsonl
{"type":"run.sample","run_id":"abc","step":1000,"text":"The king said...","loss":3.4,"ts":"2026-03-09T00:10:00Z"}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `type` | `"run.sample"` | yes | Event type |
| `run_id` | string | yes | Run identifier |
| `step` | integer | yes | Training step |
| `text` | string | yes | Generated sample text |
| `loss` | number | no | Loss at sample time |
| `ts` | ISO 8601 | yes | Timestamp |

### `run.checkpoint`

Emitted when a model checkpoint is saved.

```jsonl
{"type":"run.checkpoint","run_id":"abc","step":5000,"path":"/tmp/ck-5000.bin","size_bytes":12345,"ts":"2026-03-09T01:00:00Z"}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `type` | `"run.checkpoint"` | yes | Event type |
| `run_id` | string | yes | Run identifier |
| `step` | integer | yes | Training step |
| `path` | string | yes | Checkpoint file path |
| `size_bytes` | integer | no | File size in bytes |
| `ts` | ISO 8601 | yes | Timestamp |

### `run.eval`

Evaluation scores from benchmark runs during training.

```jsonl
{"type":"run.eval","run_id":"abc","step":5000,"eval":"hellaswag","score":0.45,"ts":"2026-03-09T01:05:00Z"}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `type` | `"run.eval"` | yes | Event type |
| `run_id` | string | yes | Run identifier |
| `step` | integer | yes | Training step |
| `eval` | string | yes | Evaluation benchmark name |
| `score` | number | yes | Score value |
| `ts` | ISO 8601 | yes | Timestamp |

### `run.end`

Emitted when a training run finishes.

```jsonl
{"type":"run.end","run_id":"abc","final_loss":2.1,"wall_ms":3600000,"ts":"2026-03-09T02:00:00Z"}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `type` | `"run.end"` | yes | Event type |
| `run_id` | string | yes | Run identifier |
| `final_loss` | number | no | Final training loss |
| `wall_ms` | integer | no | Total wall-clock time in milliseconds |
| `ts` | ISO 8601 | yes | Timestamp |

## Adapters

| Adapter | Source | How |
|---------|--------|-----|
| `adapter-http` | Any server with `/loss`, `/checkpoints` endpoints | Poll JSON, emit events |
| `adapter-stdout` | Any training script | Parse `step=N loss=X.XX` from stdout |
| `adapter-jsonl` | Already-formatted logs | Direct ingest (zero-config) |
| `adapter-wandb` | Weights & Biases API | Poll run metrics (planned) |
| `adapter-mlflow` | MLflow tracking server | Poll REST API (planned) |
| `adapter-tfevents` | TensorBoard event files | Read `events.out.tfevents.*` (planned) |

## Ingestion

Events can be ingested in two ways:

**Direct POST** — send events to the API endpoint:

```bash
curl -X POST localhost:3000/api/training \
  -H 'Content-Type: application/json' \
  -d '[
    {"type":"run.start","run_id":"run-001","model":"gpt2-small","ts":"2026-03-09T00:00:00Z"},
    {"type":"run.loss","run_id":"run-001","step":100,"loss":5.23,"ts":"2026-03-09T00:01:00Z"}
  ]'
```

**HTTP adapter** — poll an existing training proxy:

```bash
curl -X POST localhost:3000/api/training/adapter-http \
  -H 'Content-Type: application/json' \
  -d '{"url":"http://training.example.com","model":"gpt2-small"}'
```

## Database Tables

- `training_runs` — one row per run (run_id, model, status, config, timestamps)
- `training_events` — one row per event (step, loss, samples, checkpoints, evals)

## Design Principles

- **Schema is the contract** — any system can emit these 6 event types
- **No framework dependency** — works with PyTorch, JAX, Keras, llama.cpp, anything
- **Same ingestion pipeline** as other harnesses — no special paths
- **Generic first** — nothing vendor-specific in the schema or adapters
