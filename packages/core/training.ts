/**
 * Training run ingestion — processes training run JSONL events into SQLite.
 *
 * Supports 6 event types: run.start, run.loss, run.sample, run.checkpoint, run.eval, run.end
 * Generic across any training system — not specific to any particular proxy or framework.
 */

import type Database from 'better-sqlite3';

export interface TrainingEvent {
  type: 'run.start' | 'run.loss' | 'run.sample' | 'run.checkpoint' | 'run.eval' | 'run.end';
  run_id: string;
  ts: string;
  // run.start
  model?: string;
  config?: Record<string, unknown>;
  // run.loss
  step?: number;
  loss?: number;
  lr?: number;
  // run.sample
  text?: string;
  // run.checkpoint
  path?: string;
  size_bytes?: number;
  // run.eval
  eval?: string;
  score?: number;
  // run.end
  final_loss?: number;
  wall_ms?: number;
}

export interface IngestTrainingResult {
  runsCreated: number;
  eventsInserted: number;
  runsCompleted: number;
  errors: string[];
}

/**
 * Ingest one or more training events into the database.
 * Idempotent — duplicate run.start events are ignored, events are inserted unconditionally.
 */
export function ingestTrainingEvents(db: Database.Database, events: TrainingEvent[], source?: string): IngestTrainingResult {
  const result: IngestTrainingResult = { runsCreated: 0, eventsInserted: 0, runsCompleted: 0, errors: [] };

  const insertRun = db.prepare(`
    INSERT OR IGNORE INTO training_runs (run_id, model, config, status, started_at, source)
    VALUES (?, ?, ?, 'running', ?, ?)
  `);

  const insertEvent = db.prepare(`
    INSERT INTO training_events (run_id, event_type, step, loss, lr, text_content, checkpoint_path, size_bytes, eval_name, eval_score, ts)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const endRun = db.prepare(`
    UPDATE training_runs SET status = 'completed', ended_at = ?, final_loss = ?, wall_ms = ? WHERE run_id = ?
  `);

  const ingestAll = db.transaction(() => {
    for (const ev of events) {
      if (!ev.type || !ev.run_id || !ev.ts) {
        result.errors.push(`Invalid event: missing type, run_id, or ts`);
        continue;
      }

      switch (ev.type) {
        case 'run.start': {
          const info = insertRun.run(
            ev.run_id,
            ev.model ?? 'unknown',
            ev.config ? JSON.stringify(ev.config) : null,
            ev.ts,
            source ?? null
          );
          if (info.changes > 0) result.runsCreated++;
          break;
        }

        case 'run.loss':
          insertEvent.run(ev.run_id, 'loss', ev.step ?? 0, ev.loss ?? null, ev.lr ?? null, null, null, null, null, null, ev.ts);
          result.eventsInserted++;
          break;

        case 'run.sample':
          insertEvent.run(ev.run_id, 'sample', ev.step ?? 0, ev.loss ?? null, null, ev.text ?? null, null, null, null, null, ev.ts);
          result.eventsInserted++;
          break;

        case 'run.checkpoint':
          insertEvent.run(ev.run_id, 'checkpoint', ev.step ?? 0, null, null, null, ev.path ?? null, ev.size_bytes ?? null, null, null, ev.ts);
          result.eventsInserted++;
          break;

        case 'run.eval':
          insertEvent.run(ev.run_id, 'eval', ev.step ?? 0, null, null, null, null, null, ev.eval ?? null, ev.score ?? null, ev.ts);
          result.eventsInserted++;
          break;

        case 'run.end': {
          const info = endRun.run(ev.ts, ev.final_loss ?? null, ev.wall_ms ?? null, ev.run_id);
          if (info.changes > 0) result.runsCompleted++;
          break;
        }

        default:
          result.errors.push(`Unknown event type: ${(ev as TrainingEvent).type}`);
      }
    }
  });

  ingestAll();
  return result;
}

/**
 * Get all training runs, optionally filtered by status.
 */
export function getTrainingRuns(db: Database.Database, status?: string) {
  let query = `
    SELECT r.*,
      (SELECT COUNT(*) FROM training_events e WHERE e.run_id = r.run_id AND e.event_type = 'loss') as loss_count,
      (SELECT MAX(e.step) FROM training_events e WHERE e.run_id = r.run_id) as latest_step,
      (SELECT e.loss FROM training_events e WHERE e.run_id = r.run_id AND e.event_type = 'loss' ORDER BY e.step DESC LIMIT 1) as latest_loss
    FROM training_runs r
  `;
  const params: string[] = [];
  if (status) {
    query += ' WHERE r.status = ?';
    params.push(status);
  }
  query += ' ORDER BY r.started_at DESC';
  return db.prepare(query).all(...params);
}

/**
 * Get all events for a specific run.
 */
export function getTrainingRunEvents(db: Database.Database, runId: string) {
  const run = db.prepare('SELECT * FROM training_runs WHERE run_id = ?').get(runId);
  if (!run) return null;

  const events = db.prepare(
    'SELECT * FROM training_events WHERE run_id = ? ORDER BY step ASC, ts ASC'
  ).all(runId);

  return { run, events };
}

/**
 * Parse a line of stdout for loss information.
 * Handles common formats:
 *   step 100 loss=5.23
 *   step=100 loss=5.23 lr=0.001
 *   loss: 5.23
 *   train_loss: 5.23
 *   [100] loss: 5.23
 */
export function parseStdoutLoss(line: string): { step?: number; loss?: number; lr?: number } | null {
  const result: { step?: number; loss?: number; lr?: number } = {};

  // Try to extract step
  const stepMatch = line.match(/(?:step|iter|iteration)[=:\s]+(\d+)/i) ?? line.match(/^\[(\d+)\]/);
  if (stepMatch) result.step = parseInt(stepMatch[1], 10);

  // Try to extract loss
  const lossMatch = line.match(/(?:loss|train_loss|training_loss)[=:\s]+([\d.]+(?:e[+-]?\d+)?)/i);
  if (!lossMatch) return null;
  result.loss = parseFloat(lossMatch[1]);

  // Try to extract learning rate
  const lrMatch = line.match(/(?:lr|learning_rate)[=:\s]+([\d.]+(?:e[+-]?\d+)?)/i);
  if (lrMatch) result.lr = parseFloat(lrMatch[1]);

  return result;
}
