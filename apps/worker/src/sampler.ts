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

export const MESH_POLL_INTERVAL_MS = 15_000;
// vLLM prefix-cache counters move over minutes, and each sample is an SSH
// round trip to a box that is busy serving inference. Five minutes gives
// useful windows without pestering the GPUs.
export const VLLM_CACHE_SAMPLE_MS = 5 * 60_000;

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
    insertMeshSnapshots(getDb(), [node]);
  } catch (err) {
    console.error(`[sampler] mesh sample for ${host} failed:`, err);
  }
}

function startStaggeredMeshSampler(hosts: string[]): Array<NodeJS.Timeout> {
  const timers: Array<NodeJS.Timeout> = [];
  const span = MESH_POLL_INTERVAL_MS;
  for (const host of hosts) {
    const offset = phaseOffsetMs(host, span);
    const t = setTimeout(() => {
      void probeAndPersistNode(host);
      timers.push(setInterval(() => { void probeAndPersistNode(host); }, span));
    }, offset);
    timers.push(t);
  }
  console.log(`[sampler] mesh: ${hosts.length} nodes staggered across ${span / 1000}s window`);
  return timers;
}

function main() {
  // Snapshot the node list at startup; if hosts change at runtime, the worker
  // will pick them up on restart (acceptable for a periodically-restarted dev
  // worker and a Salt-managed prod worker).
  const hosts = discoverNodes();
  const timers = hosts.length > 0 ? startStaggeredMeshSampler(hosts) : [];

  const vllm = setInterval(() => {
    sampleVllmCache(getDb(), hosts)
      .then((nodes) => {
        const n = nodes.reduce((a, x) => a + x.sampled, 0);
        if (n > 0) console.log(`[sampler] vllm cache: sampled ${n} model(s)`);
      })
      .catch((err) => console.error('[sampler] vllm cache sample failed:', err));
  }, VLLM_CACHE_SAMPLE_MS);

  const stop = (why: string) => {
    for (const t of timers) { clearTimeout(t); clearInterval(t); }
    clearInterval(vllm);
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
