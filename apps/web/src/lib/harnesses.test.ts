import { describe, it, expect } from 'vitest';
import { harnessesFor, harnessById, type Harness } from './harnesses';

/**
 * The harness catalogue, which used to be three catalogues.
 *
 * It was copied into the node page, its tabs, and the unsandbox page, and
 * the copies had drifted: the container one had lost the third tag from
 * all sixteen entries, so the same search box matched different things
 * depending on which page you typed it into.
 *
 * Every entry here becomes a shell command run on somebody's machine, so
 * the shape of an entry is worth holding as firmly as its contents.
 */

const node = harnessesFor('node');
const container = harnessesFor('container');

describe('the catalogue', () => {
  it('offers the same harnesses wherever they are going', () => {
    // Anything else is a harness installable on one kind of box and
    // invisible on the other, for no reason anyone chose.
    expect(container.map(h => h.id)).toEqual(node.map(h => h.id));
  });

  it('gives every entry the fields a boot needs', () => {
    for (const h of node) {
      expect(h.id, h.id).toMatch(/^[a-z0-9-]+$/);
      expect(h.name, h.id).toBeTruthy();
      expect(h.desc, h.id).toBeTruthy();
      expect(h.install, h.id).toBeTruthy();
      expect(h.verify, h.id).toBeTruthy();
      expect(h.tags.length, h.id).toBeGreaterThan(0);
    }
  });

  it('names each harness once', () => {
    const ids = node.map(h => h.id);
    expect(ids).toEqual([...new Set(ids)]);
  });

  it('gives every entry at least the two tags a card shows', () => {
    // The card renders tags.slice(0, 2). One tag is a card with a gap.
    for (const h of node) expect(h.tags.length, h.id).toBeGreaterThanOrEqual(2);
  });

  it('says which key a harness will want before anyone boots it', () => {
    // A harness that needs a key and does not say so boots, starts, and
    // fails at the first request with an auth error.
    const needy = node.filter(h => h.requiresKey);
    expect(needy.length).toBeGreaterThan(0);
    for (const h of needy) expect(h.requiresKey, h.id).toMatch(/[A-Z_]{4,}/);
  });
});

describe('context', () => {
  it('finds claude where a login shell would', () => {
    // The installer drops it in $HOME/.local/bin, which is not on PATH
    // until a login shell puts it there.
    const claude = node.find(h => h.id === 'claude-code')!;
    expect(claude.verify).toContain('$HOME/.local/bin');
  });

  it('names claude absolutely in a container, which has no login shell', () => {
    // unsandbox runs as root without one, so the same command finds
    // nothing and the harness reads as failed to install.
    const claude = container.find(h => h.id === 'claude-code')!;
    expect(claude.verify).toBe('/root/.local/bin/claude --version');
  });

  it('changes nothing else between the two', () => {
    // One field varies by context. Sixteen entries used to.
    const differing: string[] = [];
    for (const a of node) {
      const b = container.find(h => h.id === a.id)!;
      for (const k of Object.keys(a) as (keyof Harness)[]) {
        if (JSON.stringify(a[k]) !== JSON.stringify(b[k])) differing.push(`${a.id}.${k}`);
      }
    }
    expect(differing).toEqual(['claude-code.verify']);
  });

  it('does not hand out a list a caller can edit', () => {
    // Three pages read this. One of them mutating it would change the
    // others, and the bug would look like a rendering fault.
    const first = harnessesFor('container')[0];
    expect(first).not.toBe(harnessesFor('node')[0]);
  });
});

describe('harnessById', () => {
  it('finds one by the id our boot routes pass around', () => {
    expect(harnessById('claude-code')?.name).toBe('Claude Code');
  });

  it('answers nothing for an id we do not have', () => {
    expect(harnessById('not-a-harness')).toBeUndefined();
  });
});
