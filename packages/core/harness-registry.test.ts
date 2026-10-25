import { describe, it, expect } from 'vitest';
import { readdirSync, existsSync } from 'fs';
import path from 'path';
import { HARNESS_REGISTRY, FOREIGN_FORMATS, ingestedHarnesses, harnessById, repoFileHarnesses } from './harness-registry';
import { foreignSessionFiles } from './harness-files';
import { HARNESS_ROOTS } from './harness-roots';
import { HARNESSES, HARNESS_MODEL_FLAGS } from './harness-models';
import { HARNESS_PROC_NAMES } from './harness-procs';
import { harnessFor } from './session-paths';

/**
 * One table of harnesses, and everything that used to keep its own list
 * reading from it. These pin the table to the adapter docs and pin the
 * derived lists to the values saved settings and running sessions use.
 */

const DOCS = path.resolve(__dirname, '../schema/docs');

describe('HARNESS_REGISTRY', () => {
  it('has an entry for every adapter doc, and every entry\'s doc exists', () => {
    const docs = readdirSync(path.join(DOCS, 'harnesses')).filter((f) => f.endsWith('.md')).map((f) => `harnesses/${f}`).sort();
    expect([...new Set(HARNESS_REGISTRY.map((h) => h.doc))].sort()).toEqual(docs);
    for (const h of HARNESS_REGISTRY) expect(existsSync(path.join(DOCS, h.doc)), h.doc).toBe(true);
  });

  it('names each harness, launcher key and process once', () => {
    const ids = HARNESS_REGISTRY.map((h) => h.id);
    expect(new Set(ids).size).toBe(ids.length);
    const keys = HARNESS_REGISTRY.flatMap((h) => (h.launch ? [h.launch.key] : []));
    expect(new Set(keys).size).toBe(keys.length);
    const procs = HARNESS_REGISTRY.flatMap((h) => h.procNames ?? []);
    expect(new Set(procs).size).toBe(procs.length);
  });

  it('knows where every harness it ingests writes, and nothing else', () => {
    // Two kinds of "where": a root of the harness's own (HARNESS_ROOTS), or,
    // for a harness that writes inside each repository it runs in (Aider's
    // .aider.chat.history.md), the file it writes there, looked for in our
    // projects' roots. Every ingested harness has exactly one of the two.
    const inRepo = repoFileHarnesses().map((h) => h.id).sort();
    expect(inRepo).toEqual(['aider']);
    for (const id of inRepo) expect(HARNESS_ROOTS[id], id).toBeUndefined();
    expect(ingestedHarnesses().map((h) => h.id).filter((id) => !inRepo.includes(id)).sort()).toEqual(Object.keys(HARNESS_ROOTS).sort());
    for (const h of HARNESS_REGISTRY.filter((x) => x.repoFile)) expect(h.format, h.id).toBeTruthy();
  });

  it('gives the session viewer a reader for every ingested harness and its older ids', () => {
    for (const h of ingestedHarnesses()) expect(harnessFor(`${h.id}:slug`).adapter.name).toBe(h.id);
    expect(harnessFor('uncloseai-cli:slug').adapter.name).toBe('uncloseai-cli');
    expect(harnessFor('-home-fox-git-x').adapter.name).toBe('claude-code');
  });

  it('gives every foreign format a file lister, and reads its sessions back from our database', () => {
    const foreign = ingestedHarnesses().filter((h) => FOREIGN_FORMATS.has(h.format!));
    expect(foreign.map((h) => h.id).sort()).toEqual(['aider', 'codex', 'continue', 'gemini-cli']);
    for (const h of foreign) {
      expect(foreignSessionFiles(h.format!, '/nonexistent'), h.id).toEqual([]);
      expect(harnessFor(`${h.id}:slug`).adapter.stored, h.id).toBe(true);
      expect(() => harnessFor(`${h.id}:slug`).adapter.sessionFile('slug', 'sid')).toThrow();
    }
    for (const h of ingestedHarnesses().filter((x) => !FOREIGN_FORMATS.has(x.format!))) {
      expect(foreignSessionFiles(h.format!, '/nonexistent'), h.id).toBeNull();
      expect(harnessFor(`${h.id}:slug`).adapter.stored, h.id).toBeFalsy();
    }
  });

  it('looks a harness up by id', () => {
    expect(harnessById('gemini-cli')?.label).toBe('Gemini CLI');
    expect(harnessById('nope')).toBeUndefined();
  });
});

describe('lists derived from the registry keep their values', () => {
  it('boot panel: same keys, labels and commands, same order', () => {
    expect(HARNESSES.map((h) => [h.value, h.label, h.cmd])).toEqual([
      ['claude', 'Claude Code', 'claude'], ['uncloseai', 'uncloseai-cli', 'unclose'],
      ['gemini', 'Gemini CLI', 'gemini'], ['codex', 'Codex CLI', 'codex'],
      ['open-code', 'Open Code', 'opencode'], ['aider', 'Aider', 'aider'],
      ['agnt', 'agnt', 'agnt'], ['cursor', 'Cursor', 'cursor'], ['continue', 'Continue', 'continue'],
      ['ollama', 'Ollama', 'ollama'], ['fetch', 'Fetch', 'fetch'], ['custom', 'Custom...', ''],
    ]);
    expect(HARNESS_MODEL_FLAGS).toEqual({ claude: '--model', uncloseai: '--model', gemini: '--model', codex: '--model', aider: '--model', ollama: '' });
  });

  it('process names map to the same harness keys as before', () => {
    expect(HARNESS_PROC_NAMES).toEqual({
      claude: 'claude', unclose: 'uncloseai', 'uncloseai-cli': 'uncloseai', 'uncloseai_cli.py': 'uncloseai',
      crossbench: 'uncloseai', gemini: 'gemini', codex: 'codex', opencode: 'open-code', aider: 'aider',
      agnt: 'agnt', cursor: 'cursor',
    });
  });
});
