import { describe, it, expect, vi, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';

/**
 * The tail route reads a harness session file from disk and streams its
 * last entries as one rendered string. Everything renders through the
 * shared extractors, so a Claude-shaped and an unfirehose/1.0-shaped
 * session must read the same way — which is what these lines check, by
 * reading the first SSE event off a real file and then hanging up.
 */
const ssh = vi.hoisted(() => ({ stdout: '', calls: [] as string[][] }));
vi.mock('child_process', () => ({
  execFile: (_cmd: string, args: string[], _opts: unknown, cb: (e: null, out: string) => void) => {
    ssh.calls.push(args);
    cb(null, ssh.stdout);
    return {};
  },
}));

const { GET } = await import('./route');

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

/** A file at the only shape the route will open: ~/.<harness>/projects/<enc>/<id>.jsonl. */
function sessionFile(lines: unknown[]): string {
  const root = mkdtempSync(path.join(tmpdir(), 'tail-'));
  dirs.push(root);
  const dir = path.join(root, '.claude', 'projects', '-home-demo');
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'sess.jsonl');
  writeFileSync(file, lines.map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n') + '\n');
  return file;
}

/** Open the stream, take the first `data:` event, hang up. */
async function firstTail(qs: string): Promise<{ status: number; content: string | null }> {
  const ac = new AbortController();
  const req = new NextRequest(new URL(`http://localhost:3000/api/session/tail?${qs}`), { signal: ac.signal });
  const res = await GET(req);
  if (res.status !== 200) return { status: res.status, content: null };
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let buf = '';
  let content: string | null = null;
  for (let i = 0; i < 20 && content === null; i++) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value);
    const m = buf.match(/data: (.*)\n\n/);
    if (m) content = JSON.parse(m[1]).content;
  }
  ac.abort();
  try { await reader.cancel(); } catch { /* closed */ }
  return { status: res.status, content };
}

describe('GET /api/session/tail', () => {
  it('refuses anything that is not a session file inside a harness tree', async () => {
    for (const p of ['/etc/passwd', '/home/x/.claude/projects/a/b.txt', '/home/x/.claude/projects/../a/b.jsonl', '/a/b.jsonl']) {
      expect((await firstTail(`path=${encodeURIComponent(p)}`)).status, p).toBe(400);
    }
    expect((await firstTail('')).status).toBe(400);
  });

  it('refuses a host that is not a hostname', async () => {
    const file = sessionFile([]);
    expect((await firstTail(`path=${encodeURIComponent(file)}&host=${encodeURIComponent('a b; rm')}`)).status).toBe(400);
  });

  it('renders Claude-shaped entries: reasoning, text, tool calls and results', async () => {
    const file = sessionFile([
      { type: 'user', message: { role: 'user', content: 'fix the login page' } },
      { type: 'assistant', message: { role: 'assistant', content: [
        { type: 'thinking', thinking: 'first look at the css' },
        { type: 'text', text: 'Checking files.' },
        { type: 'tool_use', id: 'tu1', name: 'Bash', input: { command: 'ls src/' } },
      ] } },
      { type: 'user', message: { role: 'user', content: [
        { type: 'tool_result', tool_use_id: 'tu1', content: 'login.css\napp.js', is_error: false },
      ] } },
      { type: 'user', message: { role: 'user', content: [
        { type: 'tool_result', tool_use_id: 'tu2', content: [{ type: 'text', text: 'boom' }], is_error: true },
      ] } },
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'thinking', thinking: '' }] } },
      { type: 'assistant', message: { role: 'assistant', content: [] } },
      { type: 'progress', data: 'not a role' },
      'not json at all',
      '',
    ]);
    const { content } = await firstTail(`path=${encodeURIComponent(file)}`);
    expect(content).toContain('⏴ user\nfix the login page');
    expect(content).toContain('[reasoning] first look at the css');
    expect(content).toContain('Checking files.');
    expect(content).toContain('[→ Bash] {"command":"ls src/"}');
    expect(content).toContain('[← result] login.css app.js');
    expect(content).toContain('[← error] boom');
    expect(content).toContain('[reasoning · sealed]');
    // An empty assistant turn, a progress record and a bad line render nothing.
    expect(content!.split('\n\n')).toHaveLength(5);
  });

  it('renders unfirehose/1.0 entries through the same extractors', async () => {
    const file = sessionFile([
      { type: 'message', role: 'assistant', content: [
        { type: 'tool-call', toolCallId: 'c1', toolName: 'bash', input: { command: 'make test' } },
      ] },
      { type: 'message', role: 'user', content: [{ type: 'tool-result', toolCallId: 'c1', output: 'PASS' }] },
      { type: 'message', role: 'system', content: [{ type: 'text', text: 'session_end' }] },
    ]);
    const { content } = await firstTail(`path=${encodeURIComponent(file)}`);
    expect(content).toContain('⏵ assistant\n[→ bash] {"command":"make test"}');
    expect(content).toContain('[← result] PASS');
    expect(content).toContain('· system\nsession_end');
  });

  it('keeps only the last N entries and floors N at 5', async () => {
    const file = sessionFile(Array.from({ length: 12 }, (_, i) => ({ type: 'user', message: { role: 'user', content: `turn ${i}` } })));
    const { content } = await firstTail(`path=${encodeURIComponent(file)}&lines=1`);
    const turns = content!.split('\n\n');
    expect(turns).toHaveLength(5);
    expect(turns[4]).toContain('turn 11');
    expect(content).not.toContain('turn 6');
  });

  it('sends an empty tail once for a session with nothing renderable yet', async () => {
    const file = sessionFile([{ type: 'progress' }]);
    expect((await firstTail(`path=${encodeURIComponent(file)}`)).content).toBe('');
  });

  it('sends an empty tail for a file that is not there', async () => {
    const file = sessionFile([]);
    rmSync(file);
    expect((await firstTail(`path=${encodeURIComponent(file)}`)).content).toBe('');
  });

  it('tails a remote file over ssh and renders what came back', async () => {
    ssh.stdout = [
      JSON.stringify({ type: 'user', message: { role: 'user', content: 'over ssh' } }),
      'garbage',
      JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] } }),
    ].join('\n');
    const { content } = await firstTail(`path=${encodeURIComponent('/home/x/.claude/projects/p/s.jsonl')}&host=demo-node`);
    expect(content).toBe('⏴ user\nover ssh\n\n⏵ assistant\nok');
    const args = ssh.calls.at(-1)!;
    expect(args).toContain('demo-node');
    expect(args.slice(-2)).toEqual(['--', '/home/x/.claude/projects/p/s.jsonl']);
    expect(args[args.indexOf('-n') + 1]).toBe('80');          // twice the default 40 entries
  });
});
