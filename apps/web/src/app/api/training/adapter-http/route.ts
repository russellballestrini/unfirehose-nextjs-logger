import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@unturf/unfirehose/db/schema';

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * HTTP Adapter for training run ingestion.
 *
 * Polls any training proxy with /loss, /checkpoints, /samples endpoints
 * and converts the responses into unfirehose/1.0 training events.
 *
 * POST /api/training/adapter-http
 *   body: { url: string, run_id?: string, model?: string }
 *
 * The adapter will:
 * 1. Fetch /loss/<model> — array of [step, loss] tuples
 * 2. Fetch /checkpoints — array of checkpoint objects
 * 3. Fetch /samples/<model> — array of sample objects
 * 4. Convert to training_events and insert into DB
 *
 * This is designed to work with any HTTP training proxy that exposes
 * loss data as JSON. The default format matches common patterns:
 *   /loss/<model> → { points: [[step, loss], ...] }
 *   /checkpoints  → { checkpoints: [{ model, step, size_bytes }] }
 *   /samples/<model> → { samples: [{ step, text, loss }] }
 *
 * GET /api/training/adapter-http
 *   Returns adapter status and list of configured sources
 */

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { url, run_id, model } = body;

    if (!url) {
      return NextResponse.json({ error: 'url is required' }, { status: 400 });
    }

    const baseUrl = url.replace(/\/$/, '');
    const db = getDb();
    const now = new Date().toISOString();
    let eventsInserted = 0;
    const errors: string[] = [];

    // Discover model(s) from the proxy
    let models: string[] = model ? [model] : [];
    if (!models.length) {
      try {
        const indexRes = await fetch(`${baseUrl}/loss`);
        if (indexRes.ok) {
          const index = await indexRes.json();
          // Support { live: { model: count }, saved: { model: count } } format
          if (index.live) models.push(...Object.keys(index.live));
          if (index.saved) models.push(...Object.keys(index.saved));
          // Deduplicate
          models = [...new Set(models)];
        }
      } catch (e: any) {
        errors.push(`Failed to discover models: ${e.message}`);
      }
    }

    if (!models.length) {
      return NextResponse.json({ error: 'No models found. Provide model param or ensure proxy has /loss index.', errors }, { status: 400 });
    }

    const insertRun = db.prepare(`
      INSERT OR IGNORE INTO training_runs (run_id, model, config, status, started_at, source)
      VALUES (?, ?, ?, 'running', ?, 'http')
    `);

    const insertEvent = db.prepare(`
      INSERT INTO training_events (run_id, event_type, step, loss, lr, text_content, checkpoint_path, size_bytes, eval_name, eval_score, ts)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    // Get existing max steps to avoid re-inserting
    const getMaxStep = db.prepare(
      'SELECT COALESCE(MAX(step), -1) as max_step FROM training_events WHERE run_id = ? AND event_type = ?'
    );

    // Fetch data and insert per model
    for (const m of models) {
      const rid = run_id ?? `http-${m}`;

      // Ensure run exists
      insertRun.run(rid, m, JSON.stringify({ source_url: baseUrl }), now);

      const maxLossStep = (getMaxStep.get(rid, 'loss') as any)?.max_step ?? -1;
      const maxSampleStep = (getMaxStep.get(rid, 'sample') as any)?.max_step ?? -1;
      const maxCheckpointStep = (getMaxStep.get(rid, 'checkpoint') as any)?.max_step ?? -1;

      // Fetch loss data
      try {
        const lossRes = await fetch(`${baseUrl}/loss/${encodeURIComponent(m)}`);
        if (lossRes.ok) {
          const lossData = await lossRes.json();
          const points: [number, number][] = lossData.points ?? lossData.data ?? [];
          const newPoints = points.filter(([step]) => step > maxLossStep);

          const insertBatch = db.transaction(() => {
            for (const [step, loss] of newPoints) {
              insertEvent.run(rid, 'loss', step, loss, null, null, null, null, null, null, now);
              eventsInserted++;
            }
          });
          insertBatch();
        }
      } catch (e: any) {
        errors.push(`Failed to fetch loss for ${m}: ${e.message}`);
      }

      // Fetch checkpoints
      try {
        const cpRes = await fetch(`${baseUrl}/checkpoints`);
        if (cpRes.ok) {
          const cpData = await cpRes.json();
          const checkpoints: any[] = cpData.checkpoints ?? cpData.data ?? [];
          const forModel = checkpoints.filter((cp: any) => !cp.model || cp.model === m);
          const newCps = forModel.filter((cp: any) => (cp.step ?? 0) > maxCheckpointStep);

          const insertBatch = db.transaction(() => {
            for (const cp of newCps) {
              insertEvent.run(rid, 'checkpoint', cp.step ?? 0, null, null, null, cp.path ?? cp.filename ?? '', cp.size_bytes ?? cp.size ?? null, null, null, now);
              eventsInserted++;
            }
          });
          insertBatch();
        }
      } catch (e: any) {
        errors.push(`Failed to fetch checkpoints for ${m}: ${e.message}`);
      }

      // Fetch samples
      try {
        const sampleRes = await fetch(`${baseUrl}/samples/${encodeURIComponent(m)}`);
        if (sampleRes.ok) {
          const sampleData = await sampleRes.json();
          const samples: any[] = sampleData.samples ?? sampleData.data ?? [];
          const newSamples = samples.filter((s: any) => (s.step ?? 0) > maxSampleStep);

          const insertBatch = db.transaction(() => {
            for (const s of newSamples) {
              insertEvent.run(rid, 'sample', s.step ?? 0, s.loss ?? null, null, s.text ?? s.content ?? '', null, null, null, null, now);
              eventsInserted++;
            }
          });
          insertBatch();
        }
      } catch (e: any) {
        errors.push(`Failed to fetch samples for ${m}: ${e.message}`);
      }
    }

    return NextResponse.json({
      ok: true,
      models,
      events_inserted: eventsInserted,
      ...(errors.length > 0 && { errors }),
    });
  } catch (err: any) {
    console.error('Training adapter-http error:', err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

export async function GET() {
  try {
    const db = getDb();
    const httpRuns = db.prepare(
      "SELECT run_id, model, config, status, started_at FROM training_runs WHERE source = 'http' ORDER BY started_at DESC"
    ).all();

    return NextResponse.json({ adapter: 'http', runs: httpRuns });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
