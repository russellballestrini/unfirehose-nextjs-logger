import { NextResponse } from 'next/server';
import { execSync } from 'child_process';
import { readFileSync, readdirSync, existsSync } from 'fs';
import { homedir } from 'os';
import path from 'path';
import { getDb } from '@unturf/unfirehose/db/schema';
import { discoverNodes } from '@unturf/unfirehose/mesh';

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * Scan local and remote homedirs for training data files.
 *
 * Discovers:
 * 1. ~/.unfirehose/training/*.jsonl (generic unfirehose format)
 * 2. ~/git/uncloseai-cli/checkpoints/cuda/*.loss.json (Double Dragon proxy format)
 * 3. Same paths on all SSH mesh nodes
 *
 * Auto-ingests discovered data into training_runs + training_events tables.
 *
 * GET  /api/training/scan — scan and ingest, return results
 * POST /api/training/scan — same, with optional { hosts: ["ai.foxhop.net"] } filter
 */

const SCAN_PATHS = [
  // Generic unfirehose training dir
  { dir: '.unfirehose/training', pattern: '*.jsonl', format: 'jsonl' as const },
  // Double Dragon proxy checkpoints
  { dir: 'git/uncloseai-cli/checkpoints/cuda', pattern: '*.loss.json', format: 'loss-json' as const },
];

interface ScanResult {
  host: string;
  files: { path: string; model: string; format: string; lossPoints: number; samples: number }[];
  ingested: { runs: number; events: number };
  error?: string;
}

function scanLocalDir(baseDir: string, pattern: string): string[] {
  try {
    if (!existsSync(baseDir)) return [];
    const suffix = pattern.replace('*', '');
    return readdirSync(baseDir)
      .filter(f => f.endsWith(suffix))
      .map(f => path.join(baseDir, f));
  } catch { return []; }
}

function modelFromFilename(filepath: string): string {
  const base = path.basename(filepath);
  // Strip .loss.json, .samples.json, .jsonl
  return base.replace(/\.(loss|samples)\.json$/, '').replace(/\.jsonl$/, '');
}

function ingestLossJson(db: any, filepath: string, host: string): { runs: number; events: number } {
  const model = modelFromFilename(filepath);
  const runId = `${host}/${model}`;
  const now = new Date().toISOString();

  let data: [number, number][];
  try {
    const raw = host === 'local'
      ? readFileSync(filepath, 'utf-8')
      : execSync(`ssh -o ConnectTimeout=5 -o StrictHostKeyChecking=no ${host} 'cat ${filepath}'`, { encoding: 'utf-8', timeout: 15000 });
    data = JSON.parse(raw);
    if (!Array.isArray(data)) return { runs: 0, events: 0 };
  } catch { return { runs: 0, events: 0 }; }

  // Ensure run exists
  db.prepare(`
    INSERT OR IGNORE INTO training_runs (run_id, model, config, status, started_at, source)
    VALUES (?, ?, ?, 'completed', ?, 'scan')
  `).run(runId, model, JSON.stringify({ host, path: filepath }), now);

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

function scanRemoteHost(host: string): { files: { path: string; model: string; format: string }[] } {
  const files: { path: string; model: string; format: string }[] = [];

  for (const sp of SCAN_PATHS) {
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

  // Also scan for .samples.json
  try {
    const cmd = `ssh -o ConnectTimeout=5 -o StrictHostKeyChecking=no ${host} 'ls ~/git/uncloseai-cli/checkpoints/cuda/*.samples.json 2>/dev/null'`;
    const output = execSync(cmd, { encoding: 'utf-8', timeout: 10000 }).trim();
    if (output) {
      for (const line of output.split('\n')) {
        if (!line.trim()) continue;
        files.push({ path: line.trim(), model: modelFromFilename(line.trim()), format: 'samples-json' });
      }
    }
  } catch { /* no samples */ }

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

  // 1. Scan local
  const localResult: ScanResult = { host: 'local', files: [], ingested: { runs: 0, events: 0 } };
  for (const sp of SCAN_PATHS) {
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
      }
    }

    // Also scan for samples locally
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
      const remoteScan = scanRemoteHost(host);
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

  const totalRuns = results.reduce((a, r) => a + r.ingested.runs, 0);
  const totalEvents = results.reduce((a, r) => a + r.ingested.events, 0);
  const totalFiles = results.reduce((a, r) => a + r.files.length, 0);

  return NextResponse.json({
    scanned: results.length,
    total_files: totalFiles,
    total_runs: totalRuns,
    total_events_ingested: totalEvents,
    results,
  });
}
