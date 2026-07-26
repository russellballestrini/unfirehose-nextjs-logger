import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { createHash } from 'crypto';

// Temp roots stand in for ~/.claude and ~/.unfirehose. Created before the
// module mocks are consumed so the mocked paths resolve into them.
const claudeRoot = mkdtempSync(path.join(tmpdir(), 'uf-claude-'));
const dataRoot = mkdtempSync(path.join(tmpdir(), 'uf-data-'));

let testDb: Database.Database;

vi.mock('./schema', () => ({
  getDb: () => testDb,
  UNFIREHOSE_DIR: dataRoot,
}));

vi.mock('../claude-paths', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../claude-paths')>();
  return {
    ...actual,
    claudePaths: {
      ...actual.claudePaths,
      toolResultsDir: (projectName: string, sessionId: string) =>
        path.join(claudeRoot, 'projects', projectName, sessionId, 'tool-results'),
    },
  };
});

const { archiveToolResultsForSession } = await import('./ingest');

const PROJECT = '-home-fox-git-demo';
const SESSION = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

function spillDir(sessionId = SESSION) {
  return path.join(claudeRoot, 'projects', PROJECT, sessionId, 'tool-results');
}

/** Write a fake spill file the way Claude Code does: <tool_use_id>.txt */
function writeSpill(name: string, body: string, sessionId = SESSION) {
  const dir = spillDir(sessionId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, name), body);
}

beforeEach(() => {
  testDb = new Database(':memory:');
  testDb.exec(`
    CREATE TABLE tool_results (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_uuid TEXT NOT NULL,
      tool_use_id TEXT NOT NULL,
      rel_path TEXT NOT NULL,
      mime_type TEXT NOT NULL,
      size_bytes INTEGER NOT NULL,
      hash TEXT NOT NULL,
      source_path TEXT NOT NULL,
      archived_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(session_uuid, rel_path)
    );
  `);
  rmSync(path.join(claudeRoot, 'projects'), { recursive: true, force: true });
  rmSync(path.join(dataRoot, 'attachments'), { recursive: true, force: true });
});

afterEach(() => {
  testDb.close();
});

describe('archiveToolResultsForSession', () => {
  it('copies a spill file into the blob store and records it', async () => {
    const body = 'a very large tool output\n'.repeat(100);
    writeSpill('toolu_01ABC.txt', body);

    const result = { filesScanned: 0 };
    await archiveToolResultsForSession(testDb as any, PROJECT, { sessionId: SESSION }, result);

    const hash = createHash('sha256').update(body).digest('hex');
    const row = testDb.prepare('SELECT * FROM tool_results').get() as any;

    expect(result.filesScanned).toBe(1);
    expect(row.tool_use_id).toBe('toolu_01ABC');
    expect(row.rel_path).toBe('toolu_01ABC.txt');
    expect(row.mime_type).toBe('text/plain; charset=utf-8');
    expect(row.session_uuid).toBe(SESSION);
    expect(row.hash).toBe(hash);
    expect(row.size_bytes).toBe(Buffer.byteLength(body));

    // Payload survives independently of the original.
    const blob = path.join(dataRoot, 'attachments', hash);
    expect(existsSync(blob)).toBe(true);
    expect(readFileSync(blob, 'utf-8')).toBe(body);
  });

  it('survives the original being swept away', async () => {
    const body = 'payload that outlives cleanupPeriodDays';
    writeSpill('toolu_01DEAD.txt', body);
    await archiveToolResultsForSession(testDb as any, PROJECT, { sessionId: SESSION }, { filesScanned: 0 });

    // Simulate Claude Code's 30-day sweep deleting the source.
    rmSync(spillDir(), { recursive: true, force: true });

    const row = testDb.prepare('SELECT hash FROM tool_results').get() as any;
    expect(readFileSync(path.join(dataRoot, 'attachments', row.hash), 'utf-8')).toBe(body);
  });

  it('is idempotent — a second pass rescans nothing', async () => {
    writeSpill('toolu_01ABC.txt', 'stable content');

    const first = { filesScanned: 0 };
    await archiveToolResultsForSession(testDb as any, PROJECT, { sessionId: SESSION }, first);
    const second = { filesScanned: 0 };
    await archiveToolResultsForSession(testDb as any, PROJECT, { sessionId: SESSION }, second);

    expect(first.filesScanned).toBe(1);
    expect(second.filesScanned).toBe(0);
    expect((testDb.prepare('SELECT COUNT(*) c FROM tool_results').get() as any).c).toBe(1);
  });

  it('re-archives when a spill file grows', async () => {
    writeSpill('toolu_01ABC.txt', 'short');
    await archiveToolResultsForSession(testDb as any, PROJECT, { sessionId: SESSION }, { filesScanned: 0 });

    const grown = 'short but now much longer';
    writeSpill('toolu_01ABC.txt', grown);
    await archiveToolResultsForSession(testDb as any, PROJECT, { sessionId: SESSION }, { filesScanned: 0 });

    const rows = testDb.prepare('SELECT * FROM tool_results').all() as any[];
    expect(rows).toHaveLength(1);
    expect(rows[0].size_bytes).toBe(Buffer.byteLength(grown));
    expect(rows[0].hash).toBe(createHash('sha256').update(grown).digest('hex'));
  });

  it('deduplicates identical payloads across sessions into one blob', async () => {
    const body = 'identical output';
    const other = '11111111-2222-3333-4444-555555555555';
    writeSpill('toolu_01A.txt', body);
    writeSpill('toolu_01B.txt', body, other);

    await archiveToolResultsForSession(testDb as any, PROJECT, { sessionId: SESSION }, { filesScanned: 0 });
    await archiveToolResultsForSession(testDb as any, PROJECT, { sessionId: other }, { filesScanned: 0 });

    const hashes = testDb.prepare('SELECT DISTINCT hash FROM tool_results').all() as any[];
    expect(testDb.prepare('SELECT COUNT(*) c FROM tool_results').get()).toEqual({ c: 2 });
    expect(hashes).toHaveLength(1);
  });

  it('skips files over the size ceiling rather than blowing memory', async () => {
    writeSpill('toolu_01BIG.txt', 'x'.repeat(11 * 1024 * 1024));

    const result = { filesScanned: 0 };
    await archiveToolResultsForSession(testDb as any, PROJECT, { sessionId: SESSION }, result);

    expect(result.filesScanned).toBe(0);
    expect((testDb.prepare('SELECT COUNT(*) c FROM tool_results').get() as any).c).toBe(0);
  });

  it('archives a nested spill directory, one row per page', async () => {
    // A single PDF read spills as pdf-<uuid>/page-NN.jpg — every page shares
    // one tool_use_id, so rel_path has to carry the identity.
    const doc = 'pdf-8e983773-eff6-4fde-a5a2-cd0f61123846';
    const dir = path.join(spillDir(), doc);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'page-01.jpg'), 'first page bytes');
    writeFileSync(path.join(dir, 'page-02.jpg'), 'second page bytes');

    const result = { filesScanned: 0 };
    await archiveToolResultsForSession(testDb as any, PROJECT, { sessionId: SESSION }, result);

    const rows = testDb
      .prepare('SELECT * FROM tool_results ORDER BY rel_path')
      .all() as any[];

    expect(result.filesScanned).toBe(2);
    expect(rows.map((r) => r.rel_path)).toEqual([
      path.join(doc, 'page-01.jpg'),
      path.join(doc, 'page-02.jpg'),
    ]);
    // Both pages resolve back to the one tool call that produced them.
    expect(new Set(rows.map((r) => r.tool_use_id))).toEqual(new Set([doc]));
    expect(rows.every((r) => r.mime_type === 'image/jpeg')).toBe(true);
  });

  it('keeps flat and nested spills side by side in one session', async () => {
    writeSpill('toolu_01FLAT.txt', 'flat output');
    const dir = path.join(spillDir(), 'pdf-abc');
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'page-01.png'), 'page bytes');

    const result = { filesScanned: 0 };
    await archiveToolResultsForSession(testDb as any, PROJECT, { sessionId: SESSION }, result);

    const mimes = testDb
      .prepare('SELECT rel_path, mime_type FROM tool_results ORDER BY rel_path')
      .all() as any[];

    expect(result.filesScanned).toBe(2);
    expect(mimes).toEqual([
      { rel_path: path.join('pdf-abc', 'page-01.png'), mime_type: 'image/png' },
      { rel_path: 'toolu_01FLAT.txt', mime_type: 'text/plain; charset=utf-8' },
    ]);
  });

  it('heals a placeholder mime left by the legacy-table migration', async () => {
    writeSpill('toolu_01ABC.txt', 'archived under the old schema');
    await archiveToolResultsForSession(testDb as any, PROJECT, { sessionId: SESSION }, { filesScanned: 0 });

    testDb.prepare("UPDATE tool_results SET mime_type = 'application/octet-stream'").run();

    const result = { filesScanned: 0 };
    await archiveToolResultsForSession(testDb as any, PROJECT, { sessionId: SESSION }, result);

    expect(result.filesScanned).toBe(1);
    expect(
      (testDb.prepare('SELECT mime_type FROM tool_results').get() as any).mime_type
    ).toBe('text/plain; charset=utf-8');
  });

  it('is a no-op when a session has no tool-results dir', async () => {
    const result = { filesScanned: 0 };
    await archiveToolResultsForSession(testDb as any, PROJECT, { sessionId: SESSION }, result);
    expect(result.filesScanned).toBe(0);
  });
});
