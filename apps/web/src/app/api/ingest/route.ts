import { NextRequest, NextResponse } from 'next/server';
import { ingestAll, getDbStats, ingestJsonlLines } from '@unfirehose/core/db/ingest';
import { isMultiTenant, authenticateRequest } from '@unfirehose/core/auth';
import { getTenantDb } from '@unfirehose/core/db/tenant';
import { getControlDb } from '@unfirehose/core/db/control';
import { uuidv7 } from '@unfirehose/core/uuidv7';

export async function POST(request: NextRequest) {
  if (isMultiTenant()) {
    return handleCloudIngest(request);
  }

  try {
    const result = await ingestAll();
    const stats = getDbStats();
    return NextResponse.json({ ingested: result, db: stats });
  } catch (err) {
    return NextResponse.json(
      { error: 'Ingestion failed', detail: String(err) },
      { status: 500 }
    );
  }
}

async function handleCloudIngest(request: NextRequest) {
  const auth = await authenticateRequest(request);
  if (!auth) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  if (!auth.scopes.split(',').includes('ingest')) {
    return NextResponse.json({ error: 'Insufficient scope' }, { status: 403 });
  }

  const body = await request.text();
  if (!body.trim()) {
    return NextResponse.json({ error: 'Empty body' }, { status: 400 });
  }

  const lines = body.split('\n').filter(l => l.trim());
  if (lines.length === 0) {
    return NextResponse.json({ accepted: 0, errors: 0 });
  }

  const tenantDb = getTenantDb(auth.accountId);

  const firstLine = lines[0];
  let projectName = 'cloud-ingest';
  let sessionUuid = uuidv7();
  try {
    const parsed = JSON.parse(firstLine);
    if (parsed.sessionId) sessionUuid = parsed.sessionId;
    if (parsed.projectName) projectName = parsed.projectName;
  } catch {
    // use defaults
  }

  const result = ingestJsonlLines(tenantDb, lines, projectName, sessionUuid);

  const controlDb = getControlDb();
  controlDb.prepare(`
    INSERT INTO usage_log (account_id, api_key_id, event_type, event_count, bytes)
    VALUES (?, ?, 'ingest', ?, ?)
  `).run(auth.accountId, auth.keyId, result.accepted, Buffer.byteLength(body, 'utf-8'));

  return NextResponse.json({ accepted: result.accepted, errors: result.errors });
}

export async function GET() {
  if (isMultiTenant()) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  try {
    const stats = getDbStats();
    return NextResponse.json(stats);
  } catch (err) {
    return NextResponse.json(
      { error: 'Failed to read DB stats', detail: String(err) },
      { status: 500 }
    );
  }
}
