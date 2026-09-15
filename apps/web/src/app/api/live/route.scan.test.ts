import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, rmSync, utimesSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';

/**
 * The live stream against real files. `route.test.ts` proves the headers
 * with every read mocked away; this proves the scan: which sessions are
 * hot, which lines are stream content, that a file growing under the
 * watcher produces exactly its new entries, and that a Claude-shaped and
 * an unfirehose/1.0-shaped journal are filtered by their own rules.
 */
const home = mkdtempSync(path.join(tmpdir(), 'live-home-'));
const claudeProjects = path.join(home, '.claude', 'projects');
const nativeRoot = path.join(home, '.demo', 'unfirehose');

vi.mock('os', async (importOriginal) => {
  const real = await importOriginal<typeof import('os')>();
  return { ...real, default: { ...real, homedir: () => home }, homedir: () => home };
});
vi.mock('@unturf/unfirehose/claude-paths', () => ({
  claudePaths: {
    projects: claudeProjects,
    projectDir: (p: string) => path.join(claudeProjects, p),
    sessionsIndex: (p: string) => path.join(claudeProjects, p, 'sessions-index.json'),
    sessionFile: (p: string, id: string) => path.join(claudeProjects, p, `${id}.jsonl`),
  },
  decodeProjectName: (name: string) => name.replace(/^-/, '/').replace(/-/g, '/'),
}));

const { GET } = await import('./route');

const line = (o: unknown) => JSON.stringify(o) + '\n';

beforeAll(() => {
  mkdirSync(path.join(claudeProjects, '-home-demo'), { recursive: true });
  writeFileSync(path.join(claudeProjects, '-home-demo', 'sessions-index.json'),
    JSON.stringify({ originalPath: '/home/demo', entries: [] }));
  writeFileSync(path.join(claudeProjects, '-home-demo', 'hot.jsonl'), [
    line({ type: 'summary', summary: 'not content' }),
    line({ type: 'user', message: { role: 'user', content: 'hello' } }),
    line({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'hi' }] } }),
    'not json\n',
  ].join(''));
  // A session touched an hour ago is not hot.
  const cold = path.join(claudeProjects, '-home-demo', 'cold.jsonl');
  writeFileSync(cold, line({ type: 'user', message: { role: 'user', content: 'old' } }));
  const hourAgo = new Date(Date.now() - 3600 * 1000);
  utimesSync(cold, hourAgo, hourAgo);

  mkdirSync(path.join(nativeRoot, 'proj-slug'), { recursive: true });
  writeFileSync(path.join(nativeRoot, 'proj-slug', 'native.jsonl'), [
    line({ type: 'session', id: 'native', status: 'active' }),
    line({ type: 'message', role: 'user', content: [{ type: 'text', text: 'native hello' }] }),
    line({ type: 'message', role: 'system', subtype: 'session_end' }),
    line({ type: 'message', role: 'tool', content: [] }),
  ].join(''));
});

afterAll(() => rmSync(home, { recursive: true, force: true }));

type Event = { type: string; [k: string]: unknown };

/** Read SSE events until `until` is satisfied or the deadline passes, then hang up. */
async function collect(until: (events: Event[]) => boolean, deadlineMs: number): Promise<Event[]> {
  const ac = new AbortController();
  const res = await GET({ signal: ac.signal, nextUrl: new URL('http://localhost:3000/api/live'), url: 'http://localhost:3000/api/live' } as never);
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  const events: Event[] = [];
  let buf = '';
  const deadline = Date.now() + deadlineMs;
  // One outstanding read at a time: a read abandoned by a timed-out race
  // would still consume the next chunk, and the chunk would be lost.
  let pending: Promise<ReadableStreamReadResult<Uint8Array>> | null = null;
  while (Date.now() < deadline && !until(events)) {
    pending ??= reader.read();
    const next = await Promise.race([pending, new Promise<null>((r) => setTimeout(() => r(null), 300))]);
    if (!next) continue;
    pending = null;
    if (next.done) break;
    buf += dec.decode(next.value);
    let m: RegExpMatchArray | null;
    while ((m = buf.match(/data: (.*)\n\n/))) {
      events.push(JSON.parse(m[1]));
      buf = buf.slice(m.index! + m[0].length);
    }
  }
  ac.abort();
  try { await reader.cancel(); } catch { /* closed */ }
  return events;
}

describe('GET /api/live over real session files', () => {
  it('announces the hot sessions of every harness and streams their recent content', async () => {
    const events = await collect((e) => e.filter((x) => x.type === 'entry').length >= 3, 5000);
    const sessions = events.find((e) => e.type === 'sessions')!.sessions as Array<Record<string, unknown>>;
    expect(sessions.map((s) => s.sessionId).sort()).toEqual(['hot', 'native']);
    const claude = sessions.find((s) => s.sessionId === 'hot')!;
    expect(claude.harness).toBe('claude-code');
    expect(claude.originalPath).toBe('/home/demo');
    const native = sessions.find((s) => s.sessionId === 'native')!;
    expect(native.harness).toBe('demo');

    const entries = events.filter((e) => e.type === 'entry');
    const texts = entries.map((e) => JSON.stringify(e.entry));
    // Claude: user/assistant/system pass, a summary record and a bad line do not.
    expect(texts.some((t) => t.includes('"hello"'))).toBe(true);
    expect(texts.some((t) => t.includes('"hi"'))).toBe(true);
    expect(texts.some((t) => t.includes('not content'))).toBe(false);
    // unfirehose/1.0: a message with a role passes; the header, session_end and a tool role do not.
    expect(texts.some((t) => t.includes('native hello'))).toBe(true);
    expect(texts.some((t) => t.includes('"status":"active"'))).toBe(false);
    expect(texts.some((t) => t.includes('session_end'))).toBe(false);
    expect(texts.some((t) => t.includes('"role":"tool"'))).toBe(false);
    expect(entries).toHaveLength(3);
  }, 10000);

  it('streams only the new entries when a hot file grows', async () => {
    const file = path.join(claudeProjects, '-home-demo', 'hot.jsonl');
    const seen = (events: Event[]) => events.filter((e) => e.type === 'entry' && JSON.stringify(e.entry).includes('appended'));
    const p = collect((e) => seen(e).length >= 1, 8000);
    setTimeout(() => appendFileSync(file, line({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'appended' }] } })), 800);
    const events = await p;
    expect(seen(events)).toHaveLength(1);
    // The initial context arrived once; the growth did not replay it.
    expect(events.filter((e) => e.type === 'entry' && JSON.stringify(e.entry).includes('"hello"'))).toHaveLength(1);
  }, 12000);
});
