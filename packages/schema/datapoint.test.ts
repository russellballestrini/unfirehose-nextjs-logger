import { describe, it, expect } from 'vitest';
import type { DataPoint, MetricType } from './types';

// Structural validator matching the JSON Schema constraints
function validateDataPoint(dp: Record<string, unknown>): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  const required = ['type', 'metric', 'metricType', 'value', 'timestamp'];
  for (const field of required) {
    if (!(field in dp)) errors.push(`missing required field: ${field}`);
  }
  if (dp.type !== 'datapoint') errors.push(`type must be "datapoint", got "${dp.type}"`);
  if (typeof dp.metric !== 'string') errors.push('metric must be a string');

  const validTypes: MetricType[] = ['count', 'gauge', 'rate', 'histogram', 'distribution', 'set'];
  if (!validTypes.includes(dp.metricType as MetricType)) errors.push(`invalid metricType: ${dp.metricType}`);

  if (typeof dp.value !== 'number' && !Array.isArray(dp.value)) {
    errors.push('value must be a number or number[]');
  }
  if (Array.isArray(dp.value) && dp.value.some((v: unknown) => typeof v !== 'number')) {
    errors.push('value array must contain only numbers');
  }

  if (typeof dp.timestamp !== 'string') errors.push('timestamp must be a string');

  if (dp.tags !== undefined) {
    if (typeof dp.tags !== 'object' || dp.tags === null || Array.isArray(dp.tags)) {
      errors.push('tags must be an object');
    } else {
      for (const [k, v] of Object.entries(dp.tags as Record<string, unknown>)) {
        if (typeof v !== 'string') errors.push(`tags.${k} must be a string, got ${typeof v}`);
      }
    }
  }

  if (dp.interval !== undefined) {
    if (typeof dp.interval !== 'number' || dp.interval < 1) errors.push('interval must be >= 1');
  }

  return { valid: errors.length === 0, errors };
}

function expectValid(dp: Record<string, unknown>) {
  const result = validateDataPoint(dp);
  expect(result.errors).toEqual([]);
  expect(result.valid).toBe(true);
}

function expectInvalid(dp: Record<string, unknown>, expectedError: string) {
  const result = validateDataPoint(dp);
  expect(result.valid).toBe(false);
  expect(result.errors.some(e => e.includes(expectedError))).toBe(true);
}

describe('DataPoint schema validation', () => {
  // --- Valid metric types ---

  it('validates count metric (token counter)', () => {
    const dp: DataPoint = {
      type: 'datapoint',
      metric: 'agent.tokens.output',
      metricType: 'count',
      value: 12000,
      timestamp: '2026-03-14T10:42:00Z',
      unit: 'token',
      tags: { project: '-home-fox-git-myproject', model: 'opus-4-6' },
    };
    expectValid(dp);
  });

  it('validates gauge metric (active sessions)', () => {
    const dp: DataPoint = {
      type: 'datapoint',
      metric: 'agent.sessions.active',
      metricType: 'gauge',
      value: 3,
      timestamp: '2026-03-14T10:42:00Z',
      tags: { host: 'cammy' },
    };
    expectValid(dp);
  });

  it('validates rate metric (cost per minute)', () => {
    const dp: DataPoint = {
      type: 'datapoint',
      metric: 'agent.cost.usd',
      metricType: 'rate',
      value: 0.42,
      timestamp: '2026-03-14T10:42:00Z',
      interval: 60,
      unit: 'dollar',
      tags: { project: '-home-fox-git-myproject', model: 'opus-4-6' },
    };
    expectValid(dp);
  });

  it('validates histogram metric (latency batch)', () => {
    const dp: DataPoint = {
      type: 'datapoint',
      metric: 'agent.response.latency_ms',
      metricType: 'histogram',
      value: [1200, 890, 2100, 450, 1800],
      timestamp: '2026-03-14T10:42:00Z',
      unit: 'millisecond',
      tags: { model: 'sonnet-4-6' },
    };
    expectValid(dp);
  });

  it('validates distribution metric (cost across nodes)', () => {
    const dp: DataPoint = {
      type: 'datapoint',
      metric: 'agent.cost.per_session',
      metricType: 'distribution',
      value: [0.42, 1.20, 0.08, 3.50],
      timestamp: '2026-03-14T10:42:00Z',
      unit: 'dollar',
    };
    expectValid(dp);
  });

  it('validates set metric (unique models)', () => {
    const dp: DataPoint = {
      type: 'datapoint',
      metric: 'agent.models.unique',
      metricType: 'set',
      value: 3,
      timestamp: '2026-03-14T10:42:00Z',
    };
    expectValid(dp);
  });

  it('validates mesh power gauge', () => {
    const dp: DataPoint = {
      type: 'datapoint',
      metric: 'mesh.power.watts',
      metricType: 'gauge',
      value: 45.2,
      timestamp: '2026-03-14T10:42:00Z',
      unit: 'watt',
      tags: { host: 'cammy', source: 'rapl' },
    };
    expectValid(dp);
  });

  it('validates minimal datapoint (no optional fields)', () => {
    expectValid({
      type: 'datapoint',
      metric: 'test.minimal',
      metricType: 'count',
      value: 1,
      timestamp: '2026-03-14T10:42:00Z',
    });
  });

  // --- Cost metric mapping from legacy ---

  it('maps legacy metric.costUsd to rate datapoint', () => {
    // Legacy: { type: "metric", costUsd: 0.42, window: "2026-03-05T10:42" }
    // Maps to:
    const dp: DataPoint = {
      type: 'datapoint',
      metric: 'agent.cost.usd',
      metricType: 'rate',
      value: 0.42,
      timestamp: '2026-03-05T10:42:00Z',
      interval: 60,
      unit: 'dollar',
    };
    expectValid(dp);
    expect(dp.metricType).toBe('rate');
    expect(dp.interval).toBe(60);
  });

  it('maps legacy token counts to count datapoints', () => {
    // Legacy metric.usage.inputTokens → agent.tokens.input count
    const input: DataPoint = {
      type: 'datapoint',
      metric: 'agent.tokens.input',
      metricType: 'count',
      value: 5000,
      timestamp: '2026-03-05T10:42:00Z',
      unit: 'token',
    };
    const output: DataPoint = {
      type: 'datapoint',
      metric: 'agent.tokens.output',
      metricType: 'count',
      value: 12000,
      timestamp: '2026-03-05T10:42:00Z',
      unit: 'token',
    };
    const cacheRead: DataPoint = {
      type: 'datapoint',
      metric: 'agent.tokens.cache_read',
      metricType: 'count',
      value: 45000,
      timestamp: '2026-03-05T10:42:00Z',
      unit: 'token',
    };
    expectValid(input);
    expectValid(output);
    expectValid(cacheRead);
  });

  // --- Rejection cases ---

  it('rejects missing metric field', () => {
    expectInvalid({
      type: 'datapoint',
      metricType: 'count',
      value: 1,
      timestamp: '2026-03-14T10:42:00Z',
    }, 'missing required field: metric');
  });

  it('rejects missing metricType', () => {
    expectInvalid({
      type: 'datapoint',
      metric: 'test',
      value: 1,
      timestamp: '2026-03-14T10:42:00Z',
    }, 'missing required field: metricType');
  });

  it('rejects missing value', () => {
    expectInvalid({
      type: 'datapoint',
      metric: 'test',
      metricType: 'gauge',
      timestamp: '2026-03-14T10:42:00Z',
    }, 'missing required field: value');
  });

  it('rejects missing timestamp', () => {
    expectInvalid({
      type: 'datapoint',
      metric: 'test',
      metricType: 'gauge',
      value: 1,
    }, 'missing required field: timestamp');
  });

  it('rejects invalid metricType', () => {
    expectInvalid({
      type: 'datapoint',
      metric: 'test',
      metricType: 'sparkline',
      value: 1,
      timestamp: '2026-03-14T10:42:00Z',
    }, 'invalid metricType');
  });

  it('rejects string value', () => {
    expectInvalid({
      type: 'datapoint',
      metric: 'test',
      metricType: 'gauge',
      value: 'not a number',
      timestamp: '2026-03-14T10:42:00Z',
    }, 'value must be a number');
  });

  it('rejects non-string tag values', () => {
    expectInvalid({
      type: 'datapoint',
      metric: 'test',
      metricType: 'gauge',
      value: 1,
      timestamp: '2026-03-14T10:42:00Z',
      tags: { count: 42 },
    }, 'tags.count must be a string');
  });

  it('rejects interval < 1', () => {
    expectInvalid({
      type: 'datapoint',
      metric: 'test',
      metricType: 'rate',
      value: 1,
      timestamp: '2026-03-14T10:42:00Z',
      interval: 0,
    }, 'interval must be >= 1');
  });

  it('rejects wrong type field', () => {
    expectInvalid({
      type: 'metric',
      metric: 'test',
      metricType: 'gauge',
      value: 1,
      timestamp: '2026-03-14T10:42:00Z',
    }, 'type must be "datapoint"');
  });
});
