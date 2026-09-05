/**
 * One ingest pass, in its own process — `npx tsx src/ingest-once.ts`.
 *
 * The web server's POST /api/ingest used to call ingestAll() itself. The
 * call is synchronous all the way down — better-sqlite3 runs on the event
 * loop — so for as long as a pass took, measured at over two minutes on a
 * busy box, the Next process answered nothing at all. The route now spawns
 * this instead and returns at once; the pass runs here, on the worker's own
 * runtime, and the web server stays a web server.
 *
 * Output is one JSON line, for whoever is watching the process.
 */
import { ingestAll } from '@unturf/unfirehose/db/ingest';

const t0 = Date.now();
ingestAll()
  .then((result) => {
    process.stdout.write(`${JSON.stringify({ ok: true, ms: Date.now() - t0, ...result })}\n`);
    process.exit(0);
  })
  .catch((err) => {
    process.stderr.write(`${JSON.stringify({ ok: false, ms: Date.now() - t0, error: String(err) })}\n`);
    process.exit(1);
  });
