import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@unturf/unfirehose/db/schema';

/* eslint-disable @typescript-eslint/no-explicit-any */

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
      const run = db.prepare('SELECT * FROM training_runs WHERE run_id = ?').get(runId);
      if (!run) {
        return NextResponse.json({ error: 'run not found' }, { status: 404 });
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

    // List runs with aggregated data
    const params: any[] = [];
    let where = '1=1';

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

export async function POST(request: NextRequest) {
  try {
    const db = getDb();
    const body = await request.json();

    const events: TrainingEvent[] = Array.isArray(body) ? body : [body];

    if (events.length === 0) {
      return NextResponse.json({ error: 'no events provided' }, { status: 400 });
    }

    const insertRun = db.prepare(`
      INSERT OR IGNORE INTO training_runs (run_id, model, config, status, started_at, source)
      VALUES (?, ?, ?, 'running', ?, ?)
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
    let errors: string[] = [];

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
