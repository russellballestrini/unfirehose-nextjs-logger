# Metrics Schema

## DataPoint (general-purpose)

The `datapoint` type is the primary metric primitive. It follows Datadog/StatsD/OpenTelemetry semantics so metrics can be forwarded to any observability backend.

### Metric Types

| Type | Aggregation | Use Case |
|------|-------------|----------|
| `count` | Monotonic delta, summed over interval | Tokens consumed, messages sent, tool calls |
| `gauge` | Last value wins, can go up or down | Active sessions, memory usage, CPU percent |
| `rate` | Value / interval, per-second normalized | Tokens/sec, cost/min, messages/sec |
| `histogram` | Percentiles within a host (avg, max, p95, p99) | Response latency, tokens per message |
| `distribution` | Percentiles across all hosts globally | Cost per session across mesh nodes |
| `set` | Count of unique values | Unique models used, unique projects active |

### Examples

#### Cost per minute (rate)

```jsonc
{
  "$schema": "unfirehose/1.0",
  "type": "datapoint",
  "metric": "agent.cost.usd",
  "metricType": "rate",
  "value": 0.42,
  "timestamp": "2026-03-14T10:42:00Z",
  "interval": 60,
  "unit": "dollar",
  "tags": {
    "project": "-home-fox-git-myproject",
    "model": "opus-4-6",
    "host": "localhost"
  }
}
```

#### Token counter (count)

```jsonc
{
  "$schema": "unfirehose/1.0",
  "type": "datapoint",
  "metric": "agent.tokens.output",
  "metricType": "count",
  "value": 12000,
  "timestamp": "2026-03-14T10:42:00Z",
  "unit": "token",
  "tags": { "project": "-home-fox-git-myproject", "model": "opus-4-6" }
}
```

#### Active sessions (gauge)

```jsonc
{
  "$schema": "unfirehose/1.0",
  "type": "datapoint",
  "metric": "agent.sessions.active",
  "metricType": "gauge",
  "value": 3,
  "timestamp": "2026-03-14T10:42:00Z",
  "tags": { "host": "cammy" }
}
```

#### Response latency (histogram)

```jsonc
{
  "$schema": "unfirehose/1.0",
  "type": "datapoint",
  "metric": "agent.response.latency_ms",
  "metricType": "histogram",
  "value": [1200, 890, 2100, 450, 1800],
  "timestamp": "2026-03-14T10:42:00Z",
  "unit": "millisecond",
  "tags": { "model": "sonnet-4-6" }
}
```

#### Unique models used (set)

```jsonc
{
  "$schema": "unfirehose/1.0",
  "type": "datapoint",
  "metric": "agent.models.unique",
  "metricType": "set",
  "value": 3,
  "timestamp": "2026-03-14T10:42:00Z",
  "tags": { "project": "-home-fox-git-myproject" }
}
```

#### CPU power draw (gauge, mesh)

```jsonc
{
  "$schema": "unfirehose/1.0",
  "type": "datapoint",
  "metric": "mesh.power.watts",
  "metricType": "gauge",
  "value": 45.2,
  "timestamp": "2026-03-14T10:42:00Z",
  "unit": "watt",
  "tags": { "host": "cammy", "source": "rapl" }
}
```

### Standard Metric Names

| Metric | Type | Unit | Description |
|--------|------|------|-------------|
| `agent.tokens.input` | count | token | Input tokens consumed |
| `agent.tokens.output` | count | token | Output tokens generated |
| `agent.tokens.cache_read` | count | token | Cache read tokens |
| `agent.tokens.cache_write` | count | token | Cache write tokens |
| `agent.cost.usd` | rate | dollar | Equivalent API cost per interval |
| `agent.messages` | count | message | Messages exchanged |
| `agent.sessions.active` | gauge | session | Currently active sessions |
| `agent.response.latency_ms` | histogram | millisecond | Time to first token |
| `agent.tools.calls` | count | call | Tool invocations |
| `agent.models.unique` | set | model | Distinct models used |
| `mesh.cpu.percent` | gauge | percent | CPU utilization |
| `mesh.memory.percent` | gauge | percent | Memory utilization |
| `mesh.power.watts` | gauge | watt | Power consumption |
| `mesh.gpu.utilization` | gauge | percent | GPU utilization |

### Mapping from Legacy Metric

The existing `type: "metric"` (usage rollup) maps to multiple DataPoints:

```
metric.usage.inputTokens    → datapoint { metric: "agent.tokens.input",      metricType: "count" }
metric.usage.outputTokens   → datapoint { metric: "agent.tokens.output",     metricType: "count" }
metric.usage.cacheReadTokens→ datapoint { metric: "agent.tokens.cache_read", metricType: "count" }
metric.messageCount          → datapoint { metric: "agent.messages",          metricType: "count" }
metric.costUsd               → datapoint { metric: "agent.cost.usd",         metricType: "rate", interval: 60 }
```

---

## Legacy Usage Rollup

The `type: "metric"` format is still supported. It pre-aggregates token usage into minute-level windows.

```jsonc
{
  "$schema": "unfirehose/1.0",
  "type": "metric",
  "window": "2026-03-05T10:42",
  "projectId": "-home-fox-git-myproject",
  "usage": {
    "inputTokens": 5000,
    "outputTokens": 12000,
    "inputTokenDetails": { "cacheReadTokens": 45000, "cacheWriteTokens": 2000 }
  },
  "messageCount": 8,
  "costUsd": 0.42
}
```

## Alerts

### Alert Threshold

```jsonc
{
  "$schema": "unfirehose/1.0",
  "type": "alert_threshold",
  "windowMinutes": 5,
  "metric": "output_tokens|input_tokens|total_tokens|cost_usd",
  "thresholdValue": 1000000,
  "enabled": true
}
```

### Alert (triggered)

```jsonc
{
  "$schema": "unfirehose/1.0",
  "type": "alert",
  "triggeredAt": "2026-03-05T10:47:00Z",
  "alertType": "rate_spike|threshold_breach|sustained_high",
  "windowMinutes": 5,
  "metric": "output_tokens",
  "thresholdValue": 1000000,
  "actualValue": 1250000,
  "projectName": "-home-fox-git-myproject",
  "details": {},
  "acknowledged": false
}
```

## Cost Calculation

Pricing as of March 2026:

| Model Family | Input $/MTok | Output $/MTok | Cache Read | Cache Write |
|---|---|---|---|---|
| Opus 4.6/4.5 | $5 | $25 | 10% of input | 125% of input |
| Sonnet 4.6/4.5 | $3 | $15 | 10% of input | 125% of input |
| Haiku 4.5 | $1 | $5 | 10% of input | 125% of input |

**Important**: `inputTokens` in the Anthropic API is **exclusive** of cache tokens. Cache tokens are tracked separately:
- `cacheReadTokens` at 10% of input price
- `cacheWriteTokens` at 125% of input price

Formula:
```
cost = (inputTokens * inputPrice + outputTokens * outputPrice
        + cacheReadTokens * inputPrice * 0.10
        + cacheWriteTokens * inputPrice * 1.25) / 1_000_000
```

## Spike Detection

The usage monitor checks configurable thresholds at 1, 5, 15, and 60 minute windows:

| Window | Use Case |
|--------|----------|
| 1 min | Runaway agent detection |
| 5 min | Abnormal burst |
| 15 min | Sustained high usage |
| 60 min | Hourly budget tracking |

When `actualValue > thresholdValue`, an alert is created. Alerts remain until acknowledged.

## Database Mapping

### usage_minutes (composite PK: minute + project_id)

| JSON Field | DB Column |
|---|---|
| `window` | `minute` |
| `projectId` | `project_id` (FK) |
| `usage.inputTokens` | `input_tokens` |
| `usage.outputTokens` | `output_tokens` |
| `usage.inputTokenDetails.cacheReadTokens` | `cache_read_tokens` |
| `usage.inputTokenDetails.cacheWriteTokens` | `cache_creation_tokens` |
| `messageCount` | `message_count` |

### alerts

| JSON Field | DB Column |
|---|---|
| `triggeredAt` | `triggered_at` |
| `alertType` | `alert_type` |
| `windowMinutes` | `window_minutes` |
| `metric` | `metric` |
| `thresholdValue` | `threshold_value` |
| `actualValue` | `actual_value` |
| `projectName` | `project_name` |
| `acknowledged` | `acknowledged` |
