# @unturf/unfirehose-router

Lightweight daemon that watches Claude Code JSONL session files and forwards new events to a cloud [unfirehose](https://github.com/russellballestrini/unfirehose-nextjs-logger) instance.

Tracks cursor positions per file so it never re-sends data, even after restarts.

## Install

```bash
npm install -g @unturf/unfirehose-router
```

## Setup

Create a config file at `~/.unfirehose.json`:

```json
{
  "api_key": "unfh_YOUR_KEY_HERE",
  "endpoint": "https://api.unfirehose.org/api/ingest",
  "watch_paths": ["~/.claude/"],
  "batch_size": 100,
  "flush_interval_ms": 5000
}
```

## Usage

```bash
# Start the router daemon
unfirehose-router

# Show current config and cursor state
unfirehose-router --status

# Help
unfirehose-router --help
```

## How it works

```
~/.claude/projects/**/*.jsonl
        │
        ▼
  [file scanner]         finds new/changed JSONL files
        │
        ▼
  [cursor tracker]       reads only new bytes since last run
        │                (~/.unfirehose-cursors.json)
        ▼
  [batch sender]         POST to cloud endpoint
        │                with exponential backoff retry
        ▼
  unfirehose.com API     cloud dashboard
```

The router:
1. Scans watch paths for `.jsonl` files
2. Reads new lines since last cursor position
3. Batches lines and flushes at configured intervals
4. Persists cursors to `~/.unfirehose-cursors.json`
5. Retries failed sends with exponential backoff

## Configuration

| Field | Default | Description |
|---|---|---|
| `api_key` | *required* | API key (must start with `unfh_`) |
| `endpoint` | `https://api.unfirehose.org/api/ingest` | Cloud ingest endpoint |
| `watch_paths` | `["~/.claude/"]` | Directories to scan for JSONL |
| `batch_size` | `100` | Lines per batch |
| `flush_interval_ms` | `5000` | Flush interval in milliseconds |

Override config path with `UNFIREHOSE_CONFIG` env var.
Override cursor path with `UNFIREHOSE_CURSORS` env var.

## Part of the unfirehose monorepo

| Package | Description |
|---|---|
| [@unturf/unfirehose](https://www.npmjs.com/package/@unturf/unfirehose) | Core data layer |
| [@unturf/unfirehose-schema](https://www.npmjs.com/package/@unturf/unfirehose-schema) | unfirehose/1.0 spec — JSON Schema, TypeScript types |
| **@unturf/unfirehose-router** | CLI daemon (this package) |
| [@unturf/unfirehose-ui](https://www.npmjs.com/package/@unturf/unfirehose-ui) | Shared React components |

## License

AGPL-3.0-only
