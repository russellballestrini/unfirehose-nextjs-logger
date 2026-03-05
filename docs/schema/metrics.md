# Metrics Schema

Pre-computed token usage rollups for dashboards, spike detection, and cost tracking.

## Canonical Format

### Usage Rollup (per minute)

```jsonc
{
  "$schema": "unfirehose/1.0",
  "type": "metric",
  "window": "2026-03-05T10:42",       // minute-level granularity
  "projectId": "-home-fox-git-myproject",
  "usage": {
    "inputTokens": 5000,
    "outputTokens": 12000,
    "inputTokenDetails": { "cacheReadTokens": 45000, "cacheWriteTokens": 2000 }
  },
  "messageCount": 8,
  "costUsd": 0.42                      // equivalent API cost
}
```

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
