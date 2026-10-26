/**
 * The mesh sampler, as its own small process.
 *
 * Every fifteen seconds this probes each node — ssh to the remote ones,
 * nvidia-smi and ps on this one — and every five minutes it reads the
 * vLLM cache counters over ssh. That is six to eight child processes a
 * sample. A fork costs what the forking process's resident set costs to
 * map: ~100 ms from the worker at 1 GB, measured 2026-09-17, against 4 ms
 * from a process this size, and the event loop is held for all of it. Run
 * from the worker that was ~6 s of every three minutes spent inside
 * spawn(), on the thread that also ingests and builds every payload.
 *
 * So the worker forks this once, and this forks the rest. It opens its own
 * connection to the database and writes snapshots itself; nothing goes
 * back through the parent. It lives exactly as long as the parent: the
 * IPC channel fork() opens closes when the parent dies, whatever killed
 * it, and 'disconnect' ends this process the same instant.
 */

import { getDb } from '@unturf/unfirehose/db/schema';
import { discoverNodes } from '@unturf/unfirehose/mesh';
import { getLocalStats } from '@unturf/unfirehose/mesh-local';
import { probeRemote } from '@unturf/unfirehose/mesh-remote';
import { insertMeshSnapshots } from '@unturf/unfirehose/db/mesh-snapshots';
import { sampleVllmCache } from '@unturf/unfirehose/vllm-sample';
import { refreshEnergyAttribution, type IdleCache } from '@unturf/unfirehose/energy-attribution';

export const MESH_POLL_INTERVAL_MS = 15_000;
// vLLM prefix-cache counters move over minutes, and each sample is an SSH
// round trip to a box that is busy serving inference. Five minutes gives
// useful windows without pestering the GPUs.
export const VLLM_CACHE_SAMPLE_MS = 5 * 60_000;
// Energy attribution folds samples into 15-minute buckets; once a minute
// keeps the bucket now filling close to live, and the first run waits for
// a round of samples to land.
export const ENERGY_ATTRIBUTION_MS = 60_000;
const ENERGY_FIRST_MS = 20_000;

// Deterministic per-host phase offset within [0, intervalMs) so that
// hundreds of nodes don't stampede the network and SSH targets at the same
// tick. Same host → same offset every restart → snapshots land at
// predictable instants.
export function phaseOffsetMs(host: string, intervalMs: number): number {
  let h = 0;
  for (let i = 0; i < host.length; i++) h = ((h << 5) - h + host.charCodeAt(i)) | 0;
  return Math.abs(h) % intervalMs;
}

async function probeAndPersistNode(host: string): Promise<void> {
  // Straight to the node and straight to the database. This used to fetch
  // /api/mesh?host=… from the web server and then POST the answer back to
  // /api/mesh/history — two HTTP round trips through the process whose job
  // is to answer pages, every fifteen seconds, per node, whether or not
  // anyone had a page open. On a busy box that was most of the dev server's
  // load, and a sample was lost whenever the web server was down.
  try {
    const node = host === 'localhost' ? await getLocalStats() : await probeRemote(host);
    if (!node.reachable) return;
    insertMeshSnapshots(getDb(), [node], [host]);
  } catch (err) {
    console.error(`[sampler] mesh sample for ${host} failed:`, err);
  }
}

// A host added to ~/.ssh/config while the worker ran used to wait for the
// next restart. ryu sat on the mesh for days that way: the node page's live
// probe showed its GPU draw, nothing showed CPU watts, because no snapshot
// row ever landed and every snapshot-served view reported "No sample yet".
// Discovery is one synchronous read of a small file, so it runs every
// minute and the timer set follows it.
export const NODE_DISCOVERY_MS = 60_000;

type HostTimers = { kickoff: NodeJS.Timeout; interval?: NodeJS.Timeout };

function startHost(host: string, span: number): HostTimers {
  const timers: HostTimers = {
    kickoff: setTimeout(() => {
      void probeAndPersistNode(host);
      timers.interval = setInterval(() => { void probeAndPersistNode(host); }, span);
    }, phaseOffsetMs(host, span)),
  };
  return timers;
}

function stopHost(t: HostTimers): void {
  clearTimeout(t.kickoff);
  if (t.interval) clearInterval(t.interval);
}

/**
 * Bring the running timer set in line with a discovered host list: start
 * what is new, stop what is gone, and leave the rest untouched so a host
 * that stayed keeps its phase. The start/stop hooks are injected so a test
 * can watch the bookkeeping without real timers.
 */
export function reconcileMeshHosts<T>(
  active: Map<string, T>,
  discovered: readonly string[],
  start: (host: string) => T,
  stop: (timers: T) => void,
): { added: string[]; removed: string[] } {
  const want = new Set(discovered);
  const added: string[] = [];
  const removed: string[] = [];
  for (const [host, timers] of [...active]) {
    if (!want.has(host)) { stop(timers); active.delete(host); removed.push(host); }
  }
  for (const host of discovered) {
    if (!active.has(host)) { active.set(host, start(host)); added.push(host); }
  }
  return { added, removed };
}

function main() {
  const span = MESH_POLL_INTERVAL_MS;
  const active = new Map<string, HostTimers>();
  const hosts = () => [...active.keys()];
  const discover = (why: string) => {
    const { added, removed } = reconcileMeshHosts(active, discoverNodes(), (h) => startHost(h, span), stopHost);
    if (!added.length && !removed.length) return;
    const delta = [...added.map((h) => `+${h}`), ...removed.map((h) => `-${h}`)].join(' ');
    console.log(`[sampler] mesh: ${active.size} nodes staggered across ${span / 1000}s window (${why}: ${delta})`);
  };
  discover('startup');
  const rediscover = setInterval(() => discover('ssh config changed'), NODE_DISCOVERY_MS);

  // Two cadences (ticket 4013): engines we already know answer every 15 s,
  // the mesh tick, so token deltas and energy deltas share bucket edges;
  // discovery of a new engine, eight ports per host, stays at five minutes.
  const vllm = setInterval(() => {
    sampleVllmCache(getDb(), hosts())
      .then((nodes) => {
        const n = nodes.reduce((a, x) => a + x.sampled, 0);
        if (n > 0) console.log(`[sampler] vllm cache: sampled ${n} model(s)`);
      })
      .catch((err) => console.error('[sampler] vllm cache sample failed:', err));
  }, VLLM_CACHE_SAMPLE_MS);
  const vllmFast = setInterval(() => {
    sampleVllmCache(getDb(), hosts(), { knownOnly: true })
      .catch((err) => console.error('[sampler] vllm fast sample failed:', err));
  }, MESH_POLL_INTERVAL_MS);

  // Measured energy, attributed (ticket 4004): here, beside the samples it
  // reads, so no page or payload build joins snapshots to messages. The
  // idle cache outlives ticks; a tick then reads the quarter hour it
  // rebuilds, not a week of samples.
  const idleCache: IdleCache = new Map();
  const energyTick = () => {
    try {
      const r = refreshEnergyAttribution(getDb(), { idleCache });
      if (r.chunks > 1) console.log(`[sampler] energy attribution: ${r.buckets} node bucket(s) through ${r.through}`);
    } catch (err) {
      console.error('[sampler] energy attribution failed:', err);
    }
  };
  const energyKickoff = setTimeout(energyTick, ENERGY_FIRST_MS);
  const energy = setInterval(energyTick, ENERGY_ATTRIBUTION_MS);

  const stop = (why: string) => {
    for (const t of active.values()) stopHost(t);
    active.clear();
    clearInterval(rediscover);
    clearInterval(vllm);
    clearInterval(vllmFast);
    clearTimeout(energyKickoff);
    clearInterval(energy);
    console.log(`[sampler] ${why}, stopping`);
    process.exit(0);
  };
  process.on('disconnect', () => stop('parent gone'));
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => stop(signal));
  // Belt and braces for a parent that was SIGKILLed before the channel
  // closed: an orphan's parent pid becomes 1.
  setInterval(() => { if (process.ppid === 1) stop('orphaned'); }, 5_000).unref();

  process.on('uncaughtException', (err) => console.error('[sampler] uncaughtException (continuing):', err));
  process.on('unhandledRejection', (reason) => console.error('[sampler] unhandledRejection (continuing):', reason));
}

// Forked by the worker (see startSampler in main.ts); importable by tests.
if (process.env.UNFIREHOSE_SAMPLER_CHILD === '1') main();
