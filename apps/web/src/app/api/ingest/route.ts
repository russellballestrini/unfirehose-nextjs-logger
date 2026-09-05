import { NextResponse } from 'next/server';
import { spawn } from 'child_process';
import path from 'path';
import { getDbStats } from '@unturf/unfirehose/db/ingest';

/**
 * Run a pass over every harness log — in another process.
 *
 * apps/worker does this on a timer; this is the on-demand form, for the
 * moment after a harness writes something you want to see now. It used to
 * call ingestAll() right here, and ingestAll() is synchronous all the way
 * down: better-sqlite3 runs on the event loop. For as long as a pass took —
 * measured at over two minutes on a busy box — this server answered
 * nothing, to anyone. The usage page fired it on every visit.
 *
 * So the pass now runs in the worker's own runtime, spawned detached, and
 * this answers 202 at once. One pass at a time: a second request while one
 * is running is told so rather than starting another to contend with the
 * first over the same database.
 */

/** The worker package, whose tsx runtime runs the pass. */
const WORKER_DIR = path.resolve(process.cwd(), '..', 'worker');

let running: { pid: number; startedAt: string } | null = null;

const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

export async function POST() {
  if (running && alive(running.pid)) {
    return NextResponse.json({ started: false, alreadyRunning: true, ...running }, { status: 202 });
  }
  try {
    const child = spawn('npx', ['tsx', 'src/ingest-once.ts'], {
      cwd: WORKER_DIR,
      detached: true,
      stdio: 'ignore',
      env: { ...process.env, PYTHONUNBUFFERED: '1' },
    });
    child.unref();
    child.on('exit', () => { if (running?.pid === child.pid) running = null; });
    running = { pid: child.pid ?? -1, startedAt: new Date().toISOString() };
    return NextResponse.json({ started: true, ...running }, { status: 202 });
  } catch (err) {
    return NextResponse.json(
      { error: 'Could not start ingest', detail: String(err) },
      { status: 500 },
    );
  }
}

export async function GET() {
  try {
    return NextResponse.json(getDbStats());
  } catch (err) {
    return NextResponse.json(
      { error: 'Failed to read DB stats', detail: String(err) },
      { status: 500 },
    );
  }
}
