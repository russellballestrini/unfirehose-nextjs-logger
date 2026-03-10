import { NextResponse } from 'next/server';
import { execSync } from 'child_process';
import { readFileSync, readdirSync, existsSync } from 'fs';
import { homedir } from 'os';
import path from 'path';
import { getDb } from '@unturf/unfirehose/db/schema';
import { getSetting } from '@unturf/unfirehose/db/ingest';
import { uuidv7 } from '@unturf/unfirehose/uuidv7';
import { discoverNodes } from '@unturf/unfirehose/mesh';

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * Scan local and remote homedirs for training data files.
 *
 * Discovers:
 * 1. Paths from settings (training_scan_paths), one per line with glob patterns
 * 2. Live training proxies on port 8088 of SSH mesh nodes
 * 3. Same paths on all SSH mesh nodes via SSH
 *
 * Default scan paths cover:
 *   ~/.unfirehose/training/*.jsonl       — unfirehose training events
 *   ~/git/uncloseai-cli/checkpoints/cuda/*.loss.json — Double Dragon proxy
 *   ~/.uncloseai/sessions/**\/*.jsonl     — uncloseai agent sessions
 *   ~/.uncloseai/todos/*.json            — uncloseai agent todos
 *   ~/.agnt/data/_logs/*.log             — agnt agent logs
 *   ~/.unfirehose/triage.jsonl           — triaged todos from all harnesses
 *
 * Auto-ingests discovered data into training_runs + training_events tables.
 *
 * GET  /api/training/scan — scan and ingest, return results
 * POST /api/training/scan — same, with optional { hosts: ["ai.foxhop.net"] } filter
 */

export const DEFAULT_SCAN_PATHS = [
  '.unfirehose/training/*.jsonl',
  'git/uncloseai-cli/checkpoints/cuda/*.loss.json',
  '.uncloseai/sessions/*/*.jsonl',
  '.uncloseai/todos/*.json',
  '.agnt/data/_logs/*.log',
  '.unfirehose/triage.jsonl',
].join('\n');

interface ScanPath {
  dir: string;
  pattern: string;
  format: 'loss-json' | 'jsonl' | 'json' | 'log';
}

export function parseScanPaths(raw: string): ScanPath[] {
  return raw
    .split('\n')
    .map(l => l.trim())
    .filter(l => l && !l.startsWith('#'))
    .map(line => {
      const dir = path.dirname(line);
      const pattern = path.basename(line);
      let format: ScanPath['format'] = 'jsonl';
      if (pattern.endsWith('.loss.json')) format = 'loss-json';
      else if (pattern.endsWith('.json')) format = 'json';
      else if (pattern.endsWith('.log')) format = 'log';
      return { dir, pattern, format };
    });
}

interface ScanResult {
  host: string;
  files: { path: string; model: string; format: string; lossPoints: number; samples: number }[];
  ingested: { runs: number; events: number };
  error?: string;
}

export function scanLocalDir(baseDir: string, pattern: string): string[] {
  try {
    // If dir contains *, expand by listing parent and descending into each subdir
    if (baseDir.includes('*')) {
      const parts = baseDir.split(path.sep);
      const starIdx = parts.findIndex(p => p.includes('*'));
      const parent = parts.slice(0, starIdx).join(path.sep);
      const rest = parts.slice(starIdx + 1).join(path.sep);
      if (!existsSync(parent)) return [];
      const results: string[] = [];
      for (const sub of readdirSync(parent)) {
        const full = rest ? path.join(parent, sub, rest) : path.join(parent, sub);
        results.push(...scanLocalDir(full, pattern));
      }
      return results;
    }

    if (!existsSync(baseDir)) return [];
    const suffix = pattern.replace('*', '');
    return readdirSync(baseDir)
      .filter(f => f.endsWith(suffix))
      .map(f => path.join(baseDir, f));
  } catch { return []; }
}

export function modelFromFilename(filepath: string): string {
  const base = path.basename(filepath);
  // Strip .loss.json, .samples.json, .jsonl
  return base.replace(/\.(loss|samples)\.json$/, '').replace(/\.jsonl$/, '');
}

function ingestLossJson(db: any, filepath: string, host: string): { runs: number; events: number } {
  const model = modelFromFilename(filepath);
  const runId = `${host}/${model}`;
  const now = new Date().toISOString();

  // Resurrect soft-deleted runs when new data is found
  const deletedCheck = db.prepare('SELECT deleted_at FROM training_runs WHERE run_id = ?').get(runId) as any;
  if (deletedCheck?.deleted_at) {
    db.prepare('UPDATE training_runs SET deleted_at = NULL WHERE run_id = ?').run(runId);
  }

  let data: [number, number][];
  try {
    const raw = host === 'local'
      ? readFileSync(filepath, 'utf-8')
      : execSync(`ssh -o ConnectTimeout=5 -o StrictHostKeyChecking=no ${host} 'cat ${filepath}'`, { encoding: 'utf-8', timeout: 15000 });
    data = JSON.parse(raw);
    if (!Array.isArray(data)) return { runs: 0, events: 0 };
  } catch { return { runs: 0, events: 0 }; }

  // Ensure run exists with uuid and source metadata
  db.prepare(`
    INSERT OR IGNORE INTO training_runs (run_id, uuid, model, config, status, started_at, source, source_path, source_host)
    VALUES (?, ?, ?, ?, 'completed', ?, 'scan', ?, ?)
  `).run(runId, uuidv7(), model, JSON.stringify({ host, path: filepath }), now, filepath, host === 'local' ? null : host);

  // Check what we already have
  const existing = db.prepare(
    'SELECT COALESCE(MAX(step), -1) as max_step FROM training_events WHERE run_id = ? AND event_type = ?'
  ).get(runId, 'loss') as any;
  const maxStep = existing?.max_step ?? -1;

  const newPoints = data.filter(([step]) => step > maxStep);
  if (!newPoints.length) return { runs: 1, events: 0 };

  const insert = db.prepare(`
    INSERT INTO training_events (run_id, event_type, step, loss, lr, text_content, checkpoint_path, size_bytes, eval_name, eval_score, ts)
    VALUES (?, 'loss', ?, ?, NULL, NULL, NULL, NULL, NULL, NULL, ?)
  `);

  const batch = db.transaction(() => {
    for (const [step, loss] of newPoints) {
      insert.run(runId, step, loss, now);
    }
  });
  batch();

  return { runs: 1, events: newPoints.length };
}

function ingestSamplesJson(db: any, filepath: string, host: string): number {
  const model = modelFromFilename(filepath);
  const runId = `${host}/${model}`;
  const now = new Date().toISOString();

  // Resurrect soft-deleted runs when new data is found
  const deletedCheck2 = db.prepare('SELECT deleted_at FROM training_runs WHERE run_id = ?').get(runId) as any;
  if (deletedCheck2?.deleted_at) {
    db.prepare('UPDATE training_runs SET deleted_at = NULL WHERE run_id = ?').run(runId);
  }

  let data: any[];
  try {
    const raw = host === 'local'
      ? readFileSync(filepath, 'utf-8')
      : execSync(`ssh -o ConnectTimeout=5 -o StrictHostKeyChecking=no ${host} 'cat ${filepath}'`, { encoding: 'utf-8', timeout: 15000 });
    data = JSON.parse(raw);
    if (!Array.isArray(data)) return 0;
  } catch { return 0; }

  // Check existing
  const existing = db.prepare(
    'SELECT COALESCE(MAX(step), -1) as max_step FROM training_events WHERE run_id = ? AND event_type = ?'
  ).get(runId, 'sample') as any;
  const maxStep = existing?.max_step ?? -1;

  const newSamples = data.filter((s: any) => (s.step ?? 0) > maxStep);
  if (!newSamples.length) return 0;

  const insert = db.prepare(`
    INSERT INTO training_events (run_id, event_type, step, loss, lr, text_content, checkpoint_path, size_bytes, eval_name, eval_score, ts)
    VALUES (?, 'sample', ?, ?, NULL, ?, NULL, NULL, NULL, NULL, ?)
  `);

  const batch = db.transaction(() => {
    for (const s of newSamples) {
      insert.run(runId, s.step ?? 0, s.loss ?? null, s.text ?? `[${(s.ids?.length ?? 0)} tokens]`, now);
    }
  });
  batch();

  return newSamples.length;
}

function scanRemoteHost(host: string, scanPaths: ScanPath[]): { files: { path: string; model: string; format: string }[] } {
  const files: { path: string; model: string; format: string }[] = [];

  for (const sp of scanPaths) {
    try {
      const cmd = `ssh -o ConnectTimeout=5 -o StrictHostKeyChecking=no ${host} 'ls ~/${sp.dir}/${sp.pattern} 2>/dev/null'`;
      const output = execSync(cmd, { encoding: 'utf-8', timeout: 10000 }).trim();
      if (!output) continue;
      for (const line of output.split('\n')) {
        if (!line.trim()) continue;
        files.push({ path: line.trim(), model: modelFromFilename(line.trim()), format: sp.format });
      }
    } catch { /* host unreachable or no files */ }
  }

  // Also scan for .samples.json alongside any loss-json paths
  const lossJsonDirs = scanPaths.filter(sp => sp.format === 'loss-json').map(sp => sp.dir);
  for (const dir of lossJsonDirs) {
    try {
      const cmd = `ssh -o ConnectTimeout=5 -o StrictHostKeyChecking=no ${host} 'ls ~/${dir}/*.samples.json 2>/dev/null'`;
      const output = execSync(cmd, { encoding: 'utf-8', timeout: 10000 }).trim();
      if (output) {
        for (const line of output.split('\n')) {
          if (!line.trim()) continue;
          files.push({ path: line.trim(), model: modelFromFilename(line.trim()), format: 'samples-json' });
        }
      }
    } catch { /* no samples */ }
  }

  return { files };
}

export async function GET() {
  return scan();
}

export async function POST(request: Request) {
  let hosts: string[] | undefined;
  try {
    const body = await request.json();
    hosts = body.hosts;
  } catch { /* no body is fine */ }
  return scan(hosts);
}

async function scan(filterHosts?: string[]) {
  const db = getDb();
  const results: ScanResult[] = [];
  const home = homedir();

  // Load scan paths from settings, fall back to defaults
  const rawPaths = getSetting('training_scan_paths') ?? DEFAULT_SCAN_PATHS;
  const scanPaths = parseScanPaths(rawPaths);

  // 1. Scan local
  const localResult: ScanResult = { host: 'local', files: [], ingested: { runs: 0, events: 0 } };
  for (const sp of scanPaths) {
    const dir = path.join(home, sp.dir);
    const found = scanLocalDir(dir, sp.pattern);
    for (const f of found) {
      const model = modelFromFilename(f);
      if (sp.format === 'loss-json') {
        const r = ingestLossJson(db, f, 'local');
        localResult.ingested.runs += r.runs;
        localResult.ingested.events += r.events;

        // Count points for response
        try {
          const data = JSON.parse(readFileSync(f, 'utf-8'));
          localResult.files.push({ path: f, model, format: sp.format, lossPoints: Array.isArray(data) ? data.length : 0, samples: 0 });
        } catch {
          localResult.files.push({ path: f, model, format: sp.format, lossPoints: 0, samples: 0 });
        }
      } else {
        // jsonl, json, log — count lines for display
        let lineCount = 0;
        try {
          const content = readFileSync(f, 'utf-8');
          lineCount = content.split('\n').filter(l => l.trim()).length;
        } catch { /* unreadable */ }
        localResult.files.push({ path: f, model, format: sp.format, lossPoints: lineCount, samples: 0 });
      }
    }

    // Also scan for samples locally alongside loss-json dirs
    if (sp.format === 'loss-json') {
      const samplesDir = dir;
      const samplesFiles = scanLocalDir(samplesDir, '*.samples.json');
      for (const sf of samplesFiles) {
        const count = ingestSamplesJson(db, sf, 'local');
        localResult.ingested.events += count;
      }
    }
  }
  results.push(localResult);

  // 2. Scan remote nodes
  let hosts: string[] = [];
  try {
    hosts = discoverNodes().filter((h: string) => h !== 'localhost' && !h.includes('*'));
  } catch { /* no SSH config */ }

  if (filterHosts) {
    hosts = hosts.filter(h => filterHosts.includes(h));
  }

  for (const host of hosts) {
    const nodeResult: ScanResult = { host, files: [], ingested: { runs: 0, events: 0 } };
    try {
      const remoteScan = scanRemoteHost(host, scanPaths);
      for (const f of remoteScan.files) {
        if (f.format === 'loss-json') {
          const r = ingestLossJson(db, f.path, host);
          nodeResult.ingested.runs += r.runs;
          nodeResult.ingested.events += r.events;

          // Get point count from remote
          try {
            const raw = execSync(
              `ssh -o ConnectTimeout=5 -o StrictHostKeyChecking=no ${host} 'python3 -c "import json; d=json.load(open('"'"'${f.path}'"'"')); print(len(d))" 2>/dev/null'`,
              { encoding: 'utf-8', timeout: 10000 }
            ).trim();
            nodeResult.files.push({ path: f.path, model: f.model, format: f.format, lossPoints: parseInt(raw) || 0, samples: 0 });
          } catch {
            nodeResult.files.push({ path: f.path, model: f.model, format: f.format, lossPoints: 0, samples: 0 });
          }
        } else if (f.format === 'samples-json') {
          const count = ingestSamplesJson(db, f.path, host);
          nodeResult.ingested.events += count;
        }
      }
    } catch (e: any) {
      nodeResult.error = e.message;
    }
    results.push(nodeResult);
  }

  // 3. Poll live training proxies via HTTP on each SSH host (port 8088)
  //    Catches in-flight runs that haven't written .loss.json yet
  const probePort = 8088;
  const probeTimeout = 5000;
  const probed = new Set<string>();

  for (const host of hosts) {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), probeTimeout);
      const indexRes = await fetch(`http://${host}:${probePort}/loss`, { signal: ctrl.signal });
      clearTimeout(timer);
      if (!indexRes.ok) continue;

      const index = await indexRes.json();
      const liveModels = Object.keys(index.live ?? {});
      if (!liveModels.length) continue;

      probed.add(host);

      for (const m of liveModels) {
        const runId = `${host}/${m}`;

        // Skip soft-deleted
        const del = db.prepare('SELECT deleted_at FROM training_runs WHERE run_id = ?').get(runId) as any;
        if (del?.deleted_at) continue;

        // Fetch live loss points
        try {
          const ctrl2 = new AbortController();
          const timer2 = setTimeout(() => ctrl2.abort(), probeTimeout);
          const lossRes = await fetch(`http://${host}:${probePort}/loss/${encodeURIComponent(m)}`, { signal: ctrl2.signal });
          clearTimeout(timer2);
          if (!lossRes.ok) continue;

          const lossData = await lossRes.json();
          const points: [number, number][] = lossData.points ?? [];
          if (!points.length) continue;

          const now = new Date().toISOString();

          // Ensure run exists — mark as 'running' since it's live (resurrect if soft-deleted)
          db.prepare(`
            INSERT INTO training_runs (run_id, uuid, model, config, status, started_at, source, source_host)
            VALUES (?, ?, ?, ?, 'running', ?, 'live-proxy', ?)
            ON CONFLICT(run_id) DO UPDATE SET status = 'running', deleted_at = NULL
          `).run(runId, uuidv7(), m, JSON.stringify({ host, port: probePort }), now, host);

          // Insert only new loss points
          const existing = db.prepare(
            'SELECT COALESCE(MAX(step), -1) as max_step FROM training_events WHERE run_id = ? AND event_type = ?'
          ).get(runId, 'loss') as any;
          const maxStep = existing?.max_step ?? -1;
          const newPoints = points.filter(([step]) => step > maxStep);

          if (newPoints.length) {
            const insert = db.prepare(`
              INSERT INTO training_events (run_id, event_type, step, loss, lr, text_content, checkpoint_path, size_bytes, eval_name, eval_score, ts)
              VALUES (?, 'loss', ?, ?, NULL, NULL, NULL, NULL, NULL, NULL, ?)
            `);
            const batch = db.transaction(() => {
              for (const [step, loss] of newPoints) insert.run(runId, step, loss, now);
            });
            batch();
          }

          let samplesIngested = 0;
          let checkpointsIngested = 0;

          // Fetch checkpoints
          try {
            const cpCtrl = new AbortController();
            const cpTimer = setTimeout(() => cpCtrl.abort(), probeTimeout);
            const cpRes = await fetch(`http://${host}:${probePort}/checkpoints`, { signal: cpCtrl.signal });
            clearTimeout(cpTimer);
            if (cpRes.ok) {
              const cpData = await cpRes.json();
              const checkpoints: any[] = (cpData.checkpoints ?? []).filter((cp: any) => !cp.model || cp.model === m);
              const maxCpStep = (db.prepare(
                'SELECT COALESCE(MAX(step), -1) as max_step FROM training_events WHERE run_id = ? AND event_type = ?'
              ).get(runId, 'checkpoint') as any)?.max_step ?? -1;
              const newCps = checkpoints.filter((cp: any) => (cp.step ?? 0) > maxCpStep);
              if (newCps.length) {
                const cpInsert = db.prepare(`
                  INSERT INTO training_events (run_id, event_type, step, loss, lr, text_content, checkpoint_path, size_bytes, eval_name, eval_score, ts)
                  VALUES (?, 'checkpoint', ?, NULL, NULL, ?, ?, ?, NULL, NULL, ?)
                `);
                const cpBatch = db.transaction(() => {
                  for (const cp of newCps) {
                    cpInsert.run(runId, cp.step ?? 0, cp.type ?? null, cp.path ?? cp.filename ?? '', cp.size_bytes ?? cp.size ?? null, now);
                    checkpointsIngested++;
                  }
                });
                cpBatch();
              }
            }
          } catch { /* no checkpoints */ }

          // Fetch samples
          try {
            const sCtrl = new AbortController();
            const sTimer = setTimeout(() => sCtrl.abort(), probeTimeout);
            const sRes = await fetch(`http://${host}:${probePort}/samples/${encodeURIComponent(m)}`, { signal: sCtrl.signal });
            clearTimeout(sTimer);
            if (sRes.ok) {
              const sData = await sRes.json();
              const samples: any[] = sData.samples ?? [];
              const maxSampleStep = (db.prepare(
                'SELECT COALESCE(MAX(step), -1) as max_step FROM training_events WHERE run_id = ? AND event_type = ?'
              ).get(runId, 'sample') as any)?.max_step ?? -1;
              const newSamples = samples.filter((s: any) => (s.step ?? 0) > maxSampleStep);
              if (newSamples.length) {
                const sInsert = db.prepare(`
                  INSERT INTO training_events (run_id, event_type, step, loss, lr, text_content, checkpoint_path, size_bytes, eval_name, eval_score, ts)
                  VALUES (?, 'sample', ?, ?, NULL, ?, NULL, NULL, NULL, NULL, ?)
                `);
                const sBatch = db.transaction(() => {
                  for (const s of newSamples) {
                    sInsert.run(runId, s.step ?? 0, s.loss ?? null, s.text ?? s.content ?? '', now);
                    samplesIngested++;
                  }
                });
                sBatch();
              }
            }
          } catch { /* no samples */ }

          // Add to existing host result or create new one
          let hostResult = results.find(r => r.host === host);
          if (!hostResult) {
            hostResult = { host, files: [], ingested: { runs: 0, events: 0 } };
            results.push(hostResult);
          }
          hostResult.ingested.runs += 1;
          hostResult.ingested.events += newPoints.length + checkpointsIngested + samplesIngested;
          hostResult.files.push({
            path: `live-proxy://${host}:${probePort}/loss/${m}`,
            model: m,
            format: 'live-proxy',
            lossPoints: points.length,
            samples: samplesIngested,
          });
        } catch { /* model fetch failed */ }
      }
    } catch { /* host not running a proxy on this port */ }
  }

  const totalRuns = results.reduce((a, r) => a + r.ingested.runs, 0);
  const totalEvents = results.reduce((a, r) => a + r.ingested.events, 0);
  const totalFiles = results.reduce((a, r) => a + r.files.length, 0);

  return NextResponse.json({
    scanned: results.length,
    total_files: totalFiles,
    total_runs: totalRuns,
    total_events_ingested: totalEvents,
    probed_proxies: [...probed],
    results,
  });
}
