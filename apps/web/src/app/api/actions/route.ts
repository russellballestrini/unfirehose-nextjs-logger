import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@unturf/unfirehose/db/schema';
import { queryLedger, rebuildLedger, scanLedgerHead, backfillLedger, ledgerStatus, type LedgerQuery } from '@unturf/unfirehose/db/action-ledger';

export const dynamic = 'force-dynamic';

/**
 * GET /api/actions — our agent action ledger.
 *
 * Every tool call that touched the filesystem, git or the network, newest
 * first, with flags for destructive commands, force pushes, credentials,
 * sudo and curl | sh. Free and local: knowing what an agent did on your
 * machine is safety, not a feature tier.
 *
 * Filters: project, session, from, to, kind, flag (any | one flag), path,
 * command (substrings), harness, tool. `cursor` pages; `format=csv`
 * downloads the matching rows (up to 10 000).
 *
 * POST `{ "rebuild": true }` empties our ledger and starts it again from
 * content_blocks (our worker refills history in the background).
 */
export async function GET(req: NextRequest) {
  const p = req.nextUrl.searchParams;
  const csv = p.get('format') === 'csv';
  const q: LedgerQuery = {
    project: p.get('project'),
    session: p.get('session'),
    from: p.get('from'),
    to: p.get('to'),
    kind: p.get('kind'),
    flag: p.get('flag'),
    path: p.get('path'),
    command: p.get('command'),
    harness: p.get('harness'),
    tool: p.get('tool'),
    cursor: p.get('cursor'),
    limit: csv ? 10_000 : Math.max(1, Math.min(500, Number(p.get('limit') ?? 100) || 100)),
  };
  const page = queryLedger(getDb(), q);
  if (!csv) return NextResponse.json(page);

  const cell = (v: unknown) => {
    const s = v == null ? '' : String(v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const header = ['timestamp', 'project', 'session', 'harness', 'tool', 'kind', 'flags', 'paths', 'command', 'reasons'];
  const lines = [header.join(',')];
  for (const r of page.rows) {
    lines.push([
      r.timestamp, r.projectName, r.sessionUuid, r.harness, r.tool, r.kind,
      r.flags.join(' '), r.paths.join(' '), r.command, r.reasons,
    ].map(cell).join(','));
  }
  return new NextResponse(lines.join('\n') + '\n', {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="actions-${new Date().toISOString().slice(0, 10)}.csv"`,
    },
  });
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const db = getDb();
  if (body?.rebuild === true) rebuildLedger(db);
  // One window each way now, so the page has something before the worker's next tick.
  scanLedgerHead(db);
  const b = backfillLedger(db);
  return NextResponse.json({ ok: true, rebuilt: body?.rebuild === true, ...ledgerStatus(db), done: b.done });
}
