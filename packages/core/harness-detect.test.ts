import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

/**
 * Which harnesses a machine has. The wizard, Settings and `make doctor` all
 * read this, so a fixture home stands in for a real one: nothing here may
 * depend on what is installed on the box running the tests.
 */

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'uf-detect-'));
vi.mock('os', async (orig) => {
  const actual = await orig<typeof import('os')>();
  return { ...actual, default: { ...actual, homedir: () => home }, homedir: () => home };
});
// The env overrides would point outside the fixture.
delete process.env.FETCH_JSONL_DIR;
delete process.env.UNCLOSEAI_UNFIREHOSE_DIR;
delete process.env.AGNT_UNFIREHOSE_DIR;
delete process.env.CODEX_HOME;
delete process.env.GEMINI_CLI_HOME;
delete process.env.CONTINUE_GLOBAL_DIR;

const { detectHarnesses, harnessLocations } = await import('./harness-detect');

const write = (rel: string, mtime?: number) => {
  const f = path.join(home, rel);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, '{}\n');
  if (mtime) fs.utimesSync(f, mtime / 1000, mtime / 1000);
};

beforeEach(() => {
  for (const e of fs.readdirSync(home)) fs.rmSync(path.join(home, e), { recursive: true, force: true });
});
afterAll(() => fs.rmSync(home, { recursive: true, force: true }));

describe('detectHarnesses', () => {
  it('finds nothing on a machine with no harness, and still names every one ingest reads', () => {
    const d = detectHarnesses();
    expect(d.map((h) => h.id)).toEqual(['claude-code', 'fetch', 'uncloseai', 'agnt', 'codex', 'gemini-cli', 'aider', 'continue']);
    expect(d.every((h) => !h.found && h.files === 0 && h.newestMs === null)).toBe(true);
    expect(d[0]).toMatchObject({ root: path.join(home, '.claude', 'projects'), doc: 'harnesses/claude-code.md', start: 'cd ~/your/repo && claude' });
  });

  it('counts session files a project deep and dates the newest', () => {
    write('.claude/projects/-home-fox-git-a/s1.jsonl', Date.parse('2026-10-01T00:00:00Z'));
    write('.claude/projects/-home-fox-git-a/s2.jsonl', Date.parse('2026-10-20T00:00:00Z'));
    write('.claude/projects/-home-fox-git-b/s3.jsonl', Date.parse('2026-10-05T00:00:00Z'));
    write('.claude/projects/-home-fox-git-b/sessions-index.json');
    write('.claude/projects/-home-fox-git-b/s3/subagents/agent-x.jsonl');
    const cc = detectHarnesses().find((h) => h.id === 'claude-code')!;
    expect(cc).toMatchObject({ found: true, readable: true, files: 3, truncated: false, newestMs: Date.parse('2026-10-20T00:00:00Z') });
  });

  it('counts Codex, Gemini CLI and Continue sessions where those tools lay them out', () => {
    write('.codex/sessions/2026/10/20/rollout-2026-10-20T09-15-02-a.jsonl', Date.parse('2026-10-20T09:15:02Z'));
    write('.codex/sessions/2026/10/21/rollout-2026-10-21T09-15-02-b.jsonl', Date.parse('2026-10-21T09:15:02Z'));
    write('.gemini/tmp/demo-api/chats/session-2026-10-20T09-15-3f6c2a1e.jsonl');
    write('.gemini/tmp/demo-api/chats/session-2025-08-01T10-00-aaaabbbb.json');
    write('.gemini/tmp/demo-api/chats/3f6c2a1e/sub.jsonl');
    write('.gemini/tmp/demo-api/logs.json');
    write('.continue/sessions/5e9d8c7b.json');
    write('.continue/sessions/sessions.json');
    // What the retired codex bridge wrote is not a harness of its own.
    write('.codex/unfirehose/-home-demo/s.jsonl');
    const d = detectHarnesses();
    expect(d.find((h) => h.id === 'codex')).toMatchObject({ found: true, files: 2, newestMs: Date.parse('2026-10-21T09:15:02Z'), root: path.join(home, '.codex', 'sessions') });
    expect(d.find((h) => h.id === 'gemini-cli')).toMatchObject({ found: true, files: 3, root: path.join(home, '.gemini', 'tmp') });
    expect(d.find((h) => h.id === 'continue')).toMatchObject({ found: true, files: 1 });
    expect(d.filter((h) => h.id === 'codex')).toHaveLength(1);
  });

  it('finds a native unfirehose/1.0 writer it was never told about, once', () => {
    write('.orcestra/unfirehose/proj/s.jsonl');
    write('.uncloseai/unfirehose/proj/s.jsonl');
    const d = detectHarnesses();
    expect(d.map((h) => h.id)).toEqual(['claude-code', 'fetch', 'uncloseai', 'agnt', 'codex', 'gemini-cli', 'aider', 'continue', 'orcestra']);
    expect(d.find((h) => h.id === 'orcestra')).toMatchObject({ found: true, files: 1, doc: 'jsonl-format.md' });
    expect(d.find((h) => h.id === 'uncloseai')).toMatchObject({ found: true, files: 1 });
  });

  it('gives a native writer the registry documents its own label and doc', () => {
    write('.arborist/unfirehose/p/s.jsonl');
    expect(detectHarnesses().find((h) => h.id === 'arborist')).toMatchObject({ label: 'arborist', doc: 'harnesses/arborist.md', found: true });
  });

  it('stops counting at the cap and says so', () => {
    for (let i = 0; i < 5; i++) write(`.agnt/unfirehose/p/s${i}.jsonl`);
    expect(detectHarnesses({ maxFiles: 3 }).find((h) => h.id === 'agnt')).toMatchObject({ files: 3, truncated: true });
  });

  it('tells a directory it cannot read from one that is not there', () => {
    if (process.getuid?.() === 0) return; // root reads everything
    write('.fetch/sessions/p/s.jsonl');
    fs.chmodSync(path.join(home, '.fetch', 'sessions'), 0o000);
    try {
      expect(detectHarnesses().find((h) => h.id === 'fetch')).toMatchObject({ found: true, readable: false });
    } finally {
      fs.chmodSync(path.join(home, '.fetch', 'sessions'), 0o755);
    }
  });

  it('lists locations without touching the files', () => {
    expect(harnessLocations().length).toBe(8);
  });

  it('looks for Aider only in the project roots it is given', () => {
    write('git/demo-api/.aider.chat.history.md', Date.parse('2026-10-20T09:20:00Z'));
    write('git/demo-web/.aider.chat.history.md');
    write('git/elsewhere/.aider.chat.history.md');
    // No roots (no database yet): not found, and nothing under home is walked.
    expect(detectHarnesses().find((h) => h.id === 'aider')).toMatchObject({ found: false, files: 0, root: "<each project's root>/.aider.chat.history.md" });
    const one = detectHarnesses({ projectRoots: [path.join(home, 'git', 'demo-api'), path.join(home, 'git', 'demo-cli')] }).find((h) => h.id === 'aider');
    expect(one).toMatchObject({
      found: true, readable: true, files: 1, newestMs: Date.parse('2026-10-20T09:20:00Z'),
      root: path.join(home, 'git', 'demo-api', '.aider.chat.history.md'),
    });
    const two = detectHarnesses({ projectRoots: [path.join(home, 'git', 'demo-api'), path.join(home, 'git', 'demo-web'), path.join(home, 'git', 'demo-cli')] }).find((h) => h.id === 'aider');
    expect(two).toMatchObject({ found: true, files: 2, root: '.aider.chat.history.md in 2 of our 3 project roots' });
  });
});
