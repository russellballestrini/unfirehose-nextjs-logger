import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createTestDb } from './test/db-helper';

/**
 * Sampling vLLM's cache counters on every node.
 *
 * This was a route the worker fetched every five minutes through the web
 * server. Now it is a function both call. What these pin: this machine is
 * probed with a local shell and not an ssh handshake to itself; the port that
 * answered last time is tried first and remembered; a model that has never
 * served is not recorded; a node that is down costs nothing but a zero.
 */

const execFile = vi.fn();
vi.mock('child_process', () => ({ execFile: (...a: unknown[]) => execFile(...a) }));
const { sampleVllmCache, fetchVllmMetrics } = await import('./vllm-sample');

const db = createTestDb();
const METRICS = [
  'vllm:prefix_cache_queries_total{model_name="qwen"} 1000',
  'vllm:prefix_cache_hits_total{model_name="qwen"} 400',
  'vllm:prompt_tokens_total{model_name="qwen"} 900',
  'vllm:generation_tokens_total{model_name="qwen"} 70',
  'vllm:request_success_total{finished_reason="stop",model_name="qwen"} 5',
  'vllm:request_success_total{finished_reason="length",model_name="qwen"} 1',
  'vllm:num_requests_running{model_name="qwen"} 2',
  'vllm:num_requests_waiting{model_name="qwen"} 0',
  'vllm:prefix_cache_queries_total{model_name="idle"} 0',
  'vllm:prefix_cache_hits_total{model_name="idle"} 0',
].join('\n');

/** Answer only when the curl in the command names `port`. */
const answerOn = (port: number, body = METRICS) =>
  execFile.mockImplementation((_f: string, args: string[], _o: unknown, cb: (e: unknown, out: string) => void) => {
    const cmd = args[args.length - 1];
    cmd.includes(`:${port}/metrics`) ? cb(null, body) : cb(new Error('refused'), '');
  });
const commands = () => execFile.mock.calls.map((c) => ({ file: c[0] as string, cmd: (c[1] as string[]).at(-1) as string }));
const rows = () => db.prepare('SELECT hostname, model, queries, hits FROM vllm_cache_samples ORDER BY id').all();

beforeEach(() => {
  vi.clearAllMocks();
  db.prepare('DELETE FROM vllm_cache_samples').run();
  db.prepare("DELETE FROM settings WHERE key LIKE 'vllm_metrics_port_%'").run();
});

describe('fetchVllmMetrics', () => {
  it('tries the candidate ports until one answers, and remembers it', async () => {
    answerOn(8080);
    const got = await fetchVllmMetrics(db, 'gpu-box');
    expect(got?.port).toBe(8080);
    expect(db.prepare("SELECT value FROM settings WHERE key = 'vllm_metrics_port_gpu-box'").get()).toEqual({ value: '8080' });
  });

  it('tries the remembered port first next time', async () => {
    // Re-scanning a dozen ports every five minutes would be rude to a box
    // that is busy serving inference.
    db.prepare("INSERT INTO settings (key, value) VALUES ('vllm_metrics_port_gpu-box', '8080')").run();
    answerOn(8080);
    await fetchVllmMetrics(db, 'gpu-box');
    expect(commands()).toHaveLength(1);
    expect(commands()[0].cmd).toContain(':8080/metrics');
  });

  it('reaches this machine with a local shell, not an ssh handshake to itself', async () => {
    answerOn(18888);
    await fetchVllmMetrics(db, 'localhost');
    expect(commands().every((c) => c.file === 'sh')).toBe(true);
  });

  it('reaches another node over ssh with a connect timeout and no prompts', async () => {
    answerOn(18888);
    await fetchVllmMetrics(db, 'gpu-box');
    const [file, args] = execFile.mock.calls[0] as [string, string[]];
    expect(file).toBe('ssh');
    expect(args).toContain('gpu-box');
    expect(args).toContain('BatchMode=yes');
  });

  it('gives up quietly when no port answers', async () => {
    execFile.mockImplementation((_f: string, _a: string[], _o: unknown, cb: (e: unknown, out: string) => void) => cb(new Error('down'), ''));
    expect(await fetchVllmMetrics(db, 'gpu-box')).toBeNull();
  });
});

describe('sampleVllmCache', () => {
  it('records each model that has served, and skips the ones that never have', async () => {
    // An engine with zero queries recorded every five minutes is rows and no
    // information.
    answerOn(18888);
    const out = await sampleVllmCache(db, ['gpu-box']);
    expect(out).toEqual([{ host: 'gpu-box', port: 18888, sampled: 1 }]);
    expect(rows()).toEqual([{ hostname: 'gpu-box', model: 'qwen', queries: 1000, hits: 400 }]);
  });

  it('records an engine whose only movement is prompt tokens, as after a vLLM restart or with prefix caching off', async () => {
    answerOn(18888, [
      'vllm:prefix_cache_queries_total{model_name="fresh"} 0',
      'vllm:prefix_cache_hits_total{model_name="fresh"} 0',
      'vllm:prompt_tokens_total{model_name="fresh"} 55',
      'vllm:generation_tokens_total{model_name="fresh"} 5',
      'vllm:prefix_cache_queries_total{model_name="idle"} 0',
      'vllm:prefix_cache_hits_total{model_name="idle"} 0',
    ].join('\n'));
    const out = await sampleVllmCache(db, ['gpu-box']);
    expect(out[0].sampled).toBe(1);
    expect(db.prepare('SELECT model, queries, prompt_tokens FROM vllm_cache_samples').all())
      .toEqual([{ model: 'fresh', queries: 0, prompt_tokens: 55 }]);
  });

  it('a knownOnly pass skips a host whose port was never found, and reads one whose port was', async () => {
    answerOn(18888);
    // Nothing remembered yet: knownOnly has nobody to ask.
    expect(await sampleVllmCache(db, ['gpu-box'], { knownOnly: true })).toEqual([]);
    expect(commands()).toEqual([]);
    // A full pass finds and remembers the port; the next knownOnly pass is one command.
    await sampleVllmCache(db, ['gpu-box']);
    vi.clearAllMocks(); answerOn(18888);
    expect(await sampleVllmCache(db, ['gpu-box', 'never-seen'], { knownOnly: true })).toEqual([{ host: 'gpu-box', port: 18888, sampled: 1 }]);
    expect(commands()).toHaveLength(1);
  });

  it('stores the token and request counters beside the cache counters', async () => {
    answerOn(18888);
    await sampleVllmCache(db, ['gpu-box']);
    const r = db.prepare('SELECT prompt_tokens, generation_tokens, requests, running, waiting FROM vllm_cache_samples').get();
    expect(r).toEqual({ prompt_tokens: 900, generation_tokens: 70, requests: 6, running: 2, waiting: 0 });
    // The probe must ask the box for those lines; a grep that dropped them is how they went missing.
    expect(commands()[0].cmd).toMatch(/generation_tokens_total/);
  });

  it('reports a down node as sampled zero and carries on with the rest', async () => {
    execFile.mockImplementation((_f: string, args: string[], _o: unknown, cb: (e: unknown, out: string) => void) => {
      const cmd = args.at(-1) as string;
      args.includes('dead') ? cb(new Error('down'), '') : (cmd.includes(':18888/') ? cb(null, METRICS) : cb(new Error('refused'), ''));
    });
    const out = await sampleVllmCache(db, ['dead', 'gpu-box']);
    expect(out.find((r) => r.host === 'dead')).toEqual({ host: 'dead', sampled: 0 });
    expect(out.find((r) => r.host === 'gpu-box')?.sampled).toBe(1);
  });
});
