/**
 * Sample vLLM's prefix-cache counters on every node.
 *
 * This was POST /api/inference/cache, and the worker reached it by fetching
 * the web server every five minutes — a probe over ssh routed through the
 * process whose job is to answer pages. It lives here now, where the route
 * and the worker both call it, and the worker no longer needs a web server
 * up to take a sample.
 *
 * vLLM's metrics port is not fixed and is not the API port. On our 4090 it
 * is 18888; the OpenAI-compatible API answers elsewhere entirely, and the
 * public URL 403s /metrics at the proxy. So the probe tries a candidate list
 * and remembers which port answered — re-scanning a dozen ports on every
 * sample would be rude to a box that is busy serving inference.
 */
import { execFile } from 'child_process';
import type Database from 'better-sqlite3';
import { sshBaseOpts } from './ssh-mux';
import { parseVllmCacheMetrics } from './vllm-metrics';

const CANDIDATE_PORTS = [18888, 8000, 8080, 8089, 8001, 9090, 9091, 5001];
const PORT_KEY = (host: string) => `vllm_metrics_port_${host}`;
const LOCAL = new Set(['localhost', '127.0.0.1', '::1']);

/** Only the six lines we want, out of an exposition that runs to hundreds of KB. */
const METRICS_CMD = (port: number) =>
  `curl -s --max-time 5 http://127.0.0.1:${port}/metrics ` +
  `| grep -E '^vllm:(prefix_cache_(hits|queries)_total|kv_cache_usage_perc|cache_config_info)'`;

/**
 * Run a shell command on a host — over ssh, or directly when the host is
 * this machine. It used to ssh to localhost to curl a local port: an ssh
 * handshake to reach the same box, at 90% CPU per call.
 */
function run(host: string, cmd: string, timeout = 12_000): Promise<string> {
  const local = LOCAL.has(host);
  const file = local ? 'sh' : 'ssh';
  const args: string[] = local
    ? ['-c', cmd]
    : [...sshBaseOpts(), host, cmd];
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout) => (err && !stdout ? reject(err) : resolve(String(stdout))));
  });
}

function rememberedPort(db: Database.Database, host: string): number | null {
  try {
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(PORT_KEY(host)) as { value: string } | undefined;
    const n = row ? parseInt(row.value, 10) : NaN;
    return Number.isFinite(n) ? n : null;
  } catch { return null; }
}

function rememberPort(db: Database.Database, host: string, port: number): void {
  try {
    db.prepare(`INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
      .run(PORT_KEY(host), String(port));
  } catch { /* a cache miss next time is not worth failing a probe over */ }
}

/** Fetch the metrics lines from a host, trying the remembered port first. */
export async function fetchVllmMetrics(db: Database.Database, host: string): Promise<{ body: string; port: number } | null> {
  const known = rememberedPort(db, host);
  const ports = known ? [known, ...CANDIDATE_PORTS.filter((p) => p !== known)] : CANDIDATE_PORTS;
  for (const port of ports) {
    try {
      const body = await run(host, METRICS_CMD(port));
      if (body && body.includes('vllm:')) {
        if (port !== known) rememberPort(db, host, port);
        return { body, port };
      }
    } catch { /* wrong port, or the node is down — try the next */ }
  }
  return null;
}

export interface VllmSampleResult { host: string; port?: number; sampled: number }

/** Sample every host and record what is live. */
export async function sampleVllmCache(db: Database.Database, hosts: string[]): Promise<VllmSampleResult[]> {
  const insert = db.prepare(`
    INSERT INTO vllm_cache_samples (hostname, model, queries, hits, kv_usage, kv_size_tokens, prefix_caching)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  return Promise.all(hosts.map(async (host) => {
    const got = await fetchVllmMetrics(db, host);
    if (!got) return { host, sampled: 0 };
    // A model with no queries at all is an engine that has never served —
    // recording it every five minutes adds rows and no information.
    const live = parseVllmCacheMetrics(got.body).filter((s) => s.queries > 0);
    for (const s of live) {
      insert.run(host, s.model, s.queries, s.hits, s.kvUsage ?? null, s.kvCacheSizeTokens ?? null,
        s.prefixCachingEnabled == null ? null : (s.prefixCachingEnabled ? 1 : 0));
    }
    return { host, port: got.port, sampled: live.length };
  }));
}
