import { NextRequest, NextResponse } from 'next/server';
import { execSync } from 'child_process';
import { unlinkSync } from 'fs';
import { getDb } from '@unturf/unfirehose/db/schema';
import { uuidv7 } from '@unturf/unfirehose/uuidv7';

/* eslint-disable @typescript-eslint/no-explicit-any */

const PROXY_PORT = 8088;
const PROXY_TIMEOUT = 5000;

/**
 * Refresh a live-proxy run's data from the training proxy.
 * Called inline during detail GET so the 5s SWR poll always gets fresh data.
 */
async function refreshFromProxy(db: any, run: any) {
  const host = run.source_host;
  const model = run.model;
  const runId = run.run_id;
  const now = new Date().toISOString();

  const maxStep = (field: string) => {
    const row = db.prepare(
      'SELECT COALESCE(MAX(step), -1) as v FROM training_events WHERE run_id = ? AND event_type = ?'
    ).get(runId, field) as any;
    return row?.v ?? -1;
  };

  // Loss
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), PROXY_TIMEOUT);
    const res = await fetch(`http://${host}:${PROXY_PORT}/loss/${encodeURIComponent(model)}`, { signal: ctrl.signal });
    clearTimeout(t);
    if (res.ok) {
      const data = await res.json();
      const pts: [number, number][] = data.points ?? [];
      const ms = maxStep('loss');
      const fresh = pts.filter(([s]) => s > ms);
      if (fresh.length) {
        const ins = db.prepare(`
          INSERT INTO training_events (run_id, event_type, step, loss, lr, text_content, checkpoint_path, size_bytes, eval_name, eval_score, ts)
          VALUES (?, 'loss', ?, ?, NULL, NULL, NULL, NULL, NULL, NULL, ?)
        `);
        db.transaction(() => { for (const [s, l] of fresh) ins.run(runId, s, l, now); })();
      }
    }
  } catch { /* proxy unreachable */ }

  // Checkpoints
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), PROXY_TIMEOUT);
    const res = await fetch(`http://${host}:${PROXY_PORT}/checkpoints`, { signal: ctrl.signal });
    clearTimeout(t);
    if (res.ok) {
      const data = await res.json();
      const cps: any[] = (data.checkpoints ?? []).filter((cp: any) => !cp.model || cp.model === model);
      const ms = maxStep('checkpoint');
      const fresh = cps.filter((cp: any) => (cp.step ?? 0) > ms);
      if (fresh.length) {
        const ins = db.prepare(`
          INSERT INTO training_events (run_id, event_type, step, loss, lr, text_content, checkpoint_path, size_bytes, eval_name, eval_score, ts)
          VALUES (?, 'checkpoint', ?, NULL, NULL, ?, ?, ?, NULL, NULL, ?)
        `);
        db.transaction(() => {
          for (const cp of fresh) ins.run(runId, cp.step ?? 0, cp.type ?? null, cp.path ?? '', cp.size_bytes ?? null, now);
        })();
      }
    }
  } catch { /* */ }

  // Samples
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), PROXY_TIMEOUT);
    const res = await fetch(`http://${host}:${PROXY_PORT}/samples/${encodeURIComponent(model)}`, { signal: ctrl.signal });
    clearTimeout(t);
    if (res.ok) {
      const data = await res.json();
      const samples: any[] = data.samples ?? [];
      const ms = maxStep('sample');
      const fresh = samples.filter((s: any) => (s.step ?? 0) > ms);
      if (fresh.length) {
        const ins = db.prepare(`
          INSERT INTO training_events (run_id, event_type, step, loss, lr, text_content, checkpoint_path, size_bytes, eval_name, eval_score, ts)
          VALUES (?, 'sample', ?, ?, NULL, ?, NULL, NULL, NULL, NULL, ?)
        `);
        db.transaction(() => {
          for (const s of fresh) ins.run(runId, s.step ?? 0, s.loss ?? null, s.text ?? s.content ?? '', now);
        })();
      }
    }
  } catch { /* */ }
}

interface TrainingEvent {
  type?: string;        // schema uses "type": "run.start" etc.
  event_type?: string;  // also accept event_type for flexibility
  run_id: string;
  ts: string;
  model?: string;
  config?: Record<string, any>;
  source?: string;
  step?: number;
  loss?: number;
  lr?: number;
  text?: string;         // schema field name
  text_content?: string; // db field name
  path?: string;         // schema field name
  checkpoint_path?: string; // db field name
  size_bytes?: number;
  eval?: string;         // schema field name
  eval_name?: string;    // db field name
  score?: number;        // schema field name
  eval_score?: number;   // db field name
  final_loss?: number;
  wall_ms?: number;
  status?: string;
}

export async function GET(request: NextRequest) {
  const url = new URL(request.url);
  const runId = url.searchParams.get('run_id');
  const statusFilter = url.searchParams.get('status');
  const limit = Math.min(parseInt(url.searchParams.get('limit') ?? '100'), 500);
  const offset = parseInt(url.searchParams.get('offset') ?? '0');

  try {
    const db = getDb();

    // Single run detail
    if (runId) {
      const run = db.prepare('SELECT * FROM training_runs WHERE run_id = ?').get(runId) as any;
      if (!run) {
        return NextResponse.json({ error: 'run not found' }, { status: 404 });
      }

      // Live-refresh from proxy for running runs (makes 5s polling work)
      if (run.status === 'running' && run.source === 'live-proxy' && run.source_host) {
        await refreshFromProxy(db, run);
      }

      const events = db.prepare(
        'SELECT * FROM training_events WHERE run_id = ? ORDER BY step ASC, ts ASC'
      ).all(runId);

      const eventCounts = db.prepare(`
        SELECT event_type, COUNT(*) as count
        FROM training_events
        WHERE run_id = ?
        GROUP BY event_type
      `).all(runId) as { event_type: string; count: number }[];

      return NextResponse.json({
        run,
        events,
        event_counts: Object.fromEntries(eventCounts.map(r => [r.event_type, r.count])),
      });
    }

    // List runs with aggregated data (exclude soft-deleted)
    const params: any[] = [];
    let where = 'r.deleted_at IS NULL';

    if (statusFilter) {
      where += ' AND r.status = ?';
      params.push(statusFilter);
    }

    const runs = db.prepare(`
      SELECT
        r.*,
        latest.loss AS latest_loss,
        latest.step AS latest_step,
        COALESCE(ec.event_count, 0) AS event_count,
        ec.event_types
      FROM training_runs r
      LEFT JOIN (
        SELECT run_id, loss, step
        FROM training_events
        WHERE event_type IN ('loss', 'run.loss')
          AND id IN (
            SELECT MAX(id) FROM training_events
            WHERE event_type IN ('loss', 'run.loss')
            GROUP BY run_id
          )
      ) latest ON latest.run_id = r.run_id
      LEFT JOIN (
        SELECT
          run_id,
          COUNT(*) AS event_count,
          GROUP_CONCAT(DISTINCT event_type) AS event_types
        FROM training_events
        GROUP BY run_id
      ) ec ON ec.run_id = r.run_id
      WHERE ${where}
      ORDER BY r.started_at DESC
      LIMIT ? OFFSET ?
    `).all(...params, limit, offset);

    const total = db.prepare(
      `SELECT COUNT(*) as count FROM training_runs r WHERE ${where}`
    ).get(...params) as { count: number };

    return NextResponse.json({
      runs,
      total: total.count,
      limit,
      offset,
    });
  } catch (err: any) {
    console.error('Training GET error:', err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest) {
  const url = new URL(request.url);
  const runId = url.searchParams.get('run_id');
  const deleteSource = url.searchParams.get('delete_source') === 'true';
  if (!runId) {
    return NextResponse.json({ error: 'run_id required' }, { status: 400 });
  }
  try {
    const db = getDb();

    // Get run info before soft-deleting (need source_path/source_host for file deletion)
    const run = db.prepare('SELECT * FROM training_runs WHERE run_id = ?').get(runId) as any;
    if (!run) {
      return NextResponse.json({ error: 'run not found' }, { status: 404 });
    }

    // Soft delete — set deleted_at timestamp
    db.prepare("UPDATE training_runs SET deleted_at = datetime('now') WHERE run_id = ?").run(runId);

    // Optionally delete source files
    let sourceDeleted = false;
    if (deleteSource) {
      const host = run.source_host;
      const sourcePath = run.source_path;
      if (sourcePath) {
        try {
          if (!host || host === 'local') {
            unlinkSync(sourcePath);
            // Also try to delete corresponding .samples.json
            const samplesPath = sourcePath.replace(/\.loss\.json$/, '.samples.json');
            try { unlinkSync(samplesPath); } catch { /* no samples file */ }
          } else {
            execSync(
              `ssh -o ConnectTimeout=5 -o StrictHostKeyChecking=no ${host} 'rm -f "${sourcePath}" "${sourcePath.replace(/\\.loss\\.json$/, '.samples.json')}"'`,
              { encoding: 'utf-8', timeout: 10000 }
            );
          }
          sourceDeleted = true;
        } catch { /* file already gone or inaccessible */ }
      }
    }

    return NextResponse.json({ ok: true, deleted: runId, soft: true, source_deleted: sourceDeleted });
  } catch (err: any) {
    console.error('Training DELETE error:', err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const db = getDb();
    const body = await request.json();

    const events: TrainingEvent[] = Array.isArray(body) ? body : [body];

    if (events.length === 0) {
      return NextResponse.json({ error: 'no events provided' }, { status: 400 });
    }

    const insertRun = db.prepare(`
      INSERT OR IGNORE INTO training_runs (run_id, uuid, model, config, status, started_at, source)
      VALUES (?, ?, ?, ?, 'running', ?, ?)
    `);

    const insertEvent = db.prepare(`
      INSERT OR IGNORE INTO training_events
        (run_id, event_type, step, loss, lr, text_content, checkpoint_path, size_bytes, eval_name, eval_score, ts)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const endRun = db.prepare(`
      UPDATE training_runs
      SET status = ?, final_loss = ?, wall_ms = ?, ended_at = ?
      WHERE run_id = ?
    `);

    let inserted = 0;
    const errors: string[] = [];

    const ingest = db.transaction(() => {
      for (const evt of events) {
        // Accept both "type" (schema) and "event_type" (db) field names
        const eventType = evt.type ?? evt.event_type;
        if (!eventType || !evt.run_id || !evt.ts) {
          errors.push(`Missing required fields (type/event_type, run_id, ts)`);
          continue;
        }

        switch (eventType) {
          case 'run.start': {
            if (!evt.model) {
              errors.push(`run.start requires model for run_id=${evt.run_id}`);
              continue;
            }
            insertRun.run(
              evt.run_id,
              uuidv7(),
              evt.model,
              evt.config ? JSON.stringify(evt.config) : null,
              evt.ts,
              evt.source ?? null,
            );
            inserted++;
            break;
          }

          case 'run.loss':
          case 'run.sample':
          case 'run.checkpoint':
          case 'run.eval': {
            insertEvent.run(
              evt.run_id,
              eventType,
              evt.step ?? 0,
              evt.loss ?? null,
              evt.lr ?? null,
              evt.text ?? evt.text_content ?? null,
              evt.path ?? evt.checkpoint_path ?? null,
              evt.size_bytes ?? null,
              evt.eval ?? evt.eval_name ?? null,
              evt.score ?? evt.eval_score ?? null,
              evt.ts,
            );
            inserted++;
            break;
          }

          case 'run.end': {
            endRun.run(
              evt.status ?? 'completed',
              evt.final_loss ?? null,
              evt.wall_ms ?? null,
              evt.ts,
              evt.run_id,
            );
            inserted++;
            break;
          }

          default:
            errors.push(`Unknown event type: ${eventType}`);
        }
      }
    });

    ingest();

    return NextResponse.json({
      ok: true,
      inserted,
      ...(errors.length > 0 && { errors }),
    });
  } catch (err: any) {
    console.error('Training POST error:', err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
