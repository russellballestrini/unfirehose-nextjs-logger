import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readdirSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { createTestDb } from '@unturf/unfirehose/test/db-helper';

/**
 * The sweep that rescues spilled tool results before Claude Code's 30-day
 * cleanup deletes them: a temp projects tree with one session that has
 * spills, one that has none, and a stray file where a session dir would
 * be. The blob store lands in a temp .unfirehose so the real one is never
 * touched.
 */
const root = mkdtempSync(path.join(tmpdir(), 'rescue-'));
const projects = path.join(root, 'projects');
const unfirehose = path.join(root, '.unfirehose');
const db = createTestDb();

vi.mock('@unturf/unfirehose/db/schema', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  getDb: () => db,
  UNFIREHOSE_DIR: unfirehose,
}));
vi.mock('@unturf/unfirehose/claude-paths', async (original) => {
  const real = await original<typeof import('@unturf/unfirehose/claude-paths')>();
  return {
    ...real,
    claudePaths: {
      ...real.claudePaths,
      projects,
      toolResultsDir: (p: string, s: string) => path.join(projects, p, s, 'tool-results'),
    },
  };
});

let printed: string[] = [];
const quiet = { log: console.log, error: console.error };
beforeAll(() => {
  console.log = (...a: unknown[]) => { printed.push(a.join(' ')); };
  console.error = (...a: unknown[]) => { printed.push(a.join(' ')); };
  mkdirSync(path.join(projects, '-home-demo', 'sess-1', 'tool-results'), { recursive: true });
  writeFileSync(path.join(projects, '-home-demo', 'sess-1', 'tool-results', 'tu_1.txt'), 'x'.repeat(2000));
  writeFileSync(path.join(projects, '-home-demo', 'sess-1', 'tool-results', 'tu_2.txt'), 'y'.repeat(3000));
  mkdirSync(path.join(projects, '-home-demo', 'sess-2'), { recursive: true });        // no spills
  writeFileSync(path.join(projects, '-home-demo', 'sess-1.jsonl'), '{}\n');           // a transcript, not a dir
  writeFileSync(path.join(projects, 'stray.json'), '{}');                             // not a project dir
});
afterAll(() => {
  console.log = quiet.log; console.error = quiet.error;
  rmSync(root, { recursive: true, force: true });
});

describe('rescue-tool-results', () => {
  it('archives every spill it finds and reports the totals', async () => {
    const { main } = await import('./rescue-tool-results.ts');
    printed = [];
    const out = await main(projects);
    expect(out.sessionsWithSpills).toBe(1);
    expect(out.archived).toBe(2);
    expect(out.rows).toBe(2);
    expect(out.blobs).toBe(2);
    expect(out.bytes).toBe(5000);
    expect(printed.some((l) => l.includes('+2') && l.includes('-home-demo/sess-1'))).toBe(true);
    expect(printed.some((l) => l.startsWith('archived this run    : 2'))).toBe(true);
    expect(existsSync(path.join(unfirehose, 'attachments'))).toBe(true);
    expect(readdirSync(path.join(unfirehose, 'attachments'))).toHaveLength(2);
  });

  it('is idempotent: a second pass archives nothing new and keeps the rows', async () => {
    const { main } = await import('./rescue-tool-results.ts');
    const out = await main(projects);
    expect(out.archived).toBe(0);
    expect(out.rows).toBe(2);
  });

  it('exits 1 when the projects tree is missing', async () => {
    const { main } = await import('./rescue-tool-results.ts');
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => { throw new Error('exit'); }) as never);
    await expect(main(path.join(root, 'nope'))).rejects.toThrow('exit');
    expect(exit).toHaveBeenCalledWith(1);
    expect(printed.some((l) => l.includes('no such directory'))).toBe(true);
  });
});
