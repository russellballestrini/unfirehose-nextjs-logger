/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';

// Mock all external deps before importing
const mockPrepare = vi.fn();
const mockTransaction = vi.fn((fn: any) => fn);
const mockDb = {
  prepare: mockPrepare.mockReturnValue({
    run: vi.fn(),
    get: vi.fn().mockReturnValue(null),
  }),
  transaction: mockTransaction,
};

vi.mock('@unturf/unfirehose/db/schema', () => ({
  getDb: vi.fn().mockReturnValue(mockDb),
}));

vi.mock('@unturf/unfirehose/db/ingest', () => ({
  getSetting: vi.fn().mockReturnValue(null),
}));

vi.mock('@unturf/unfirehose/uuidv7', () => ({
  uuidv7: vi.fn().mockReturnValue('test-uuid-v7'),
}));

vi.mock('@unturf/unfirehose/mesh', () => ({
  discoverNodes: vi.fn().mockReturnValue([]),
}));

// Import after mocks
const {
  parseScanPaths,
  scanLocalDir,
  modelFromFilename,
  DEFAULT_SCAN_PATHS,
  GET,
} = await import('./route');

// ─── Unit tests for pure functions ───

describe('parseScanPaths', () => {
  it('parses default paths into dir/pattern/format', () => {
    const paths = parseScanPaths(DEFAULT_SCAN_PATHS);
    expect(paths.length).toBe(6);

    expect(paths[0]).toEqual({ dir: '.unfirehose/training', pattern: '*.jsonl', format: 'jsonl' });
    expect(paths[1]).toEqual({ dir: 'git/uncloseai-cli/checkpoints/cuda', pattern: '*.loss.json', format: 'loss-json' });
    expect(paths[2]).toEqual({ dir: '.uncloseai/sessions/*', pattern: '*.jsonl', format: 'jsonl' });
    expect(paths[3]).toEqual({ dir: '.uncloseai/todos', pattern: '*.json', format: 'json' });
    expect(paths[4]).toEqual({ dir: '.agnt/data/_logs', pattern: '*.log', format: 'log' });
    expect(paths[5]).toEqual({ dir: '.unfirehose', pattern: 'triage.jsonl', format: 'jsonl' });
  });

  it('ignores blank lines and comments', () => {
    const paths = parseScanPaths('foo/*.jsonl\n\n# commented out\nbar/*.log\n  ');
    expect(paths.length).toBe(2);
    expect(paths[0].dir).toBe('foo');
    expect(paths[1].dir).toBe('bar');
  });

  it('detects loss-json format', () => {
    const paths = parseScanPaths('checkpoints/*.loss.json');
    expect(paths[0].format).toBe('loss-json');
  });

  it('detects json format', () => {
    const paths = parseScanPaths('data/*.json');
    expect(paths[0].format).toBe('json');
  });

  it('detects log format', () => {
    const paths = parseScanPaths('logs/*.log');
    expect(paths[0].format).toBe('log');
  });

  it('defaults to jsonl for .jsonl files', () => {
    const paths = parseScanPaths('data/*.jsonl');
    expect(paths[0].format).toBe('jsonl');
  });

  it('handles single literal filename', () => {
    const paths = parseScanPaths('.unfirehose/triage.jsonl');
    expect(paths[0]).toEqual({ dir: '.unfirehose', pattern: 'triage.jsonl', format: 'jsonl' });
  });
});

describe('modelFromFilename', () => {
  it('strips .loss.json', () => {
    expect(modelFromFilename('/path/to/chatty-v8.loss.json')).toBe('chatty-v8');
  });

  it('strips .samples.json', () => {
    expect(modelFromFilename('/path/to/chatty-v8.samples.json')).toBe('chatty-v8');
  });

  it('strips .jsonl', () => {
    expect(modelFromFilename('/path/to/session-abc.jsonl')).toBe('session-abc');
  });

  it('handles complex model names', () => {
    expect(modelFromFilename('megachat-v7-embd384.loss.json')).toBe('megachat-v7-embd384');
  });

  it('preserves .json suffix (not .loss.json or .samples.json)', () => {
    expect(modelFromFilename('/path/to/todo-abc.json')).toBe('todo-abc.json');
  });
});

describe('scanLocalDir', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(tmpdir(), 'scan-test-'));
  });

  it('finds files matching pattern', () => {
    writeFileSync(path.join(tmpDir, 'a.jsonl'), '{}');
    writeFileSync(path.join(tmpDir, 'b.jsonl'), '{}');
    writeFileSync(path.join(tmpDir, 'c.txt'), 'nope');

    const found = scanLocalDir(tmpDir, '*.jsonl');
    expect(found.length).toBe(2);
    expect(found.every(f => f.endsWith('.jsonl'))).toBe(true);
  });

  it('returns empty for missing dir', () => {
    expect(scanLocalDir('/nonexistent/path/xyz', '*.jsonl')).toEqual([]);
  });

  it('matches literal filename (no glob)', () => {
    writeFileSync(path.join(tmpDir, 'triage.jsonl'), '{}');
    writeFileSync(path.join(tmpDir, 'other.jsonl'), '{}');

    const found = scanLocalDir(tmpDir, 'triage.jsonl');
    expect(found.length).toBe(1);
    expect(found[0]).toContain('triage.jsonl');
  });

  it('expands * in dir path', () => {
    // Create tmpDir/sub1/*.jsonl and tmpDir/sub2/*.jsonl
    mkdirSync(path.join(tmpDir, 'sub1'));
    mkdirSync(path.join(tmpDir, 'sub2'));
    writeFileSync(path.join(tmpDir, 'sub1', 'a.jsonl'), '{}');
    writeFileSync(path.join(tmpDir, 'sub2', 'b.jsonl'), '{}');

    const found = scanLocalDir(path.join(tmpDir, '*'), '*.jsonl');
    expect(found.length).toBe(2);
    expect(found.some(f => f.includes('sub1'))).toBe(true);
    expect(found.some(f => f.includes('sub2'))).toBe(true);
  });

  it('handles * in dir with no matching subdirs', () => {
    const found = scanLocalDir(path.join(tmpDir, '*'), '*.jsonl');
    // tmpDir exists but has no subdirs, so no files found
    expect(found).toEqual([]);
  });

  afterEach(() => {
    try { rmSync(tmpDir, { recursive: true }); } catch { /* cleanup */ }
  });
});

// ─── Integration test for GET handler ───

describe('GET /api/training/scan', () => {
  it('returns scan results with local host', async () => {
    const res = await GET();
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.scanned).toBeGreaterThanOrEqual(1);
    expect(data.results[0].host).toBe('local');
    expect(Array.isArray(data.results[0].files)).toBe(true);
    expect(typeof data.total_files).toBe('number');
    expect(typeof data.total_runs).toBe('number');
    expect(typeof data.total_events_ingested).toBe('number');
    expect(Array.isArray(data.probed_proxies)).toBe(true);
  });
});
