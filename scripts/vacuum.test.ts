import { describe, it, expect, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { runVacuum } from './vacuum';

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

function dbWithFreelist(): string {
  const d = mkdtempSync(path.join(tmpdir(), 'ufh-vac-'));
  dirs.push(d);
  const file = path.join(d, 'unfirehose.db');
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.exec('CREATE TABLE junk (b BLOB)');
  const ins = db.prepare('INSERT INTO junk VALUES (randomblob(4096))');
  db.transaction(() => { for (let i = 0; i < 400; i++) ins.run(); })();
  db.exec('DELETE FROM junk');
  db.close();
  return file;
}

describe('make vacuum', () => {
  it('refuses while another process holds the database, naming it', () => {
    const lines: string[] = [];
    expect(runVacuum({ dbPath: dbWithFreelist(), holders: [4242], log: (l) => lines.push(l) })).toBe(2);
    expect(lines[0]).toContain('refusing');
    expect(lines.join('\n')).toContain('4242');
    expect(lines.join('\n')).toContain('FORCE=1');
  });

  it('vacuums with FORCE=1 or when nothing else holds it, and reports the shrink', () => {
    const file = dbWithFreelist();
    const lines: string[] = [];
    expect(runVacuum({ dbPath: file, holders: [], log: (l) => lines.push(l) })).toBe(0);
    expect(lines.some((l) => l.startsWith('VACUUM'))).toBe(true);
    const db = new Database(file);
    expect((db.prepare('PRAGMA freelist_count').get() as { freelist_count: number }).freelist_count).toBe(0);
    db.close();
    expect(runVacuum({ dbPath: file, holders: [1], force: true, log: () => {} })).toBe(0);
  });

  it('honours MIN_MB', () => {
    const lines: string[] = [];
    expect(runVacuum({ dbPath: dbWithFreelist(), holders: [], minFreelistBytes: 512 * 1024 ** 2, log: (l) => lines.push(l) })).toBe(0);
    expect(lines.at(-1)).toContain('skipped');
  });

  it('says so when there is no database', () => {
    expect(runVacuum({ dbPath: '/nonexistent/unfirehose.db', holders: [], log: () => {} })).toBe(1);
  });
});
