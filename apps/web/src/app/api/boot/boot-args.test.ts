import { describe, it, expect, vi } from 'vitest';

const settings: Record<string, string | null> = {};
vi.mock('@unturf/unfirehose/db/ingest', () => ({
  getSetting: (k: string) => settings[k] ?? null,
  setSetting: vi.fn(),
}));
vi.mock('@unturf/unfirehose/db/schema', () => ({ getDb: () => ({ prepare: () => ({ get: () => undefined, all: () => [], run: () => ({}) }) }) }));

const { buildClaudeCmd, buildClaudeArgs, resolveBootHost } = await import('./route');

/**
 * The command line a booted agent actually gets.
 *
 * This is the part of booting that is decidable without a machine, and the
 * part that has been wrong before: for a while every non-claude harness had
 * its prompt dropped, so launching uncloseai from a project produced
 * `unclose --model X`, which prints help and exits 1. A session that starts
 * and immediately dies looks like a broken node.
 */

const opts = (over: Record<string, unknown> = {}) => ({
  harness: 'claude', harnessKey: undefined, model: undefined, sessionId: undefined,
  yolo: false, prompt: undefined, sessionName: 'agent-1', ...over,
});

describe('buildClaudeCmd', () => {
  it('is just claude with nothing asked for', () => {
    expect(buildClaudeCmd(opts() as never)).toBe('claude');
  });

  it('resumes a session when given one', () => {
    expect(buildClaudeCmd(opts({ sessionId: 'abc-123' }) as never)).toBe('claude --resume abc-123');
  });

  it('names the model when one is chosen', () => {
    // uncloseai-cli reaches hundreds of models; dispatching without saying
    // which is how work silently lands on the wrong tier.
    expect(buildClaudeCmd(opts({ model: 'opus' }) as never)).toBe('claude --model opus');
  });

  it('passes the permission flag only when yolo is asked for', () => {
    expect(buildClaudeCmd(opts({ yolo: true }) as never)).toContain('--dangerously-skip-permissions');
    expect(buildClaudeCmd(opts({ yolo: false }) as never)).not.toContain('--dangerously-skip-permissions');
  });

  it('keeps the flags in the order claude expects', () => {
    const cmd = buildClaudeCmd(opts({ sessionId: 's1', model: 'opus', yolo: true }) as never);
    expect(cmd).toBe('claude --resume s1 --model opus --dangerously-skip-permissions');
  });

  it('builds another harness by its own name', () => {
    expect(buildClaudeCmd(opts({ harness: 'unclose', harnessKey: 'uncloseai' }) as never))
      .toContain('unclose');
  });
});

describe('buildClaudeArgs', () => {
  it('reports no files to clean up when it wrote none', () => {
    expect(buildClaudeArgs(opts() as never).cleanupFiles).toEqual([]);
  });

  it('writes the prompt to a file and asks for it back', () => {
    // A prompt can be paragraphs long and carry quotes; putting it on the
    // command line is how a boot fails on an apostrophe.
    const { parts, cleanupFiles } = buildClaudeArgs(opts({ prompt: 'do the thing' }) as never);
    expect(parts.join(' ')).toContain('$(cat ');
    expect(cleanupFiles).toHaveLength(1);
    expect(cleanupFiles[0]).toContain('claude-prompt-agent-1');
  });

  it('names the prompt file after the session, so two boots do not collide', () => {
    const a = buildClaudeArgs(opts({ prompt: 'x', sessionName: 'agent-1' }) as never);
    const b = buildClaudeArgs(opts({ prompt: 'x', sessionName: 'agent-2' }) as never);
    expect(a.cleanupFiles[0]).not.toBe(b.cleanupFiles[0]);
  });

  it('adds a system prompt file under yolo, and cleans that up too', () => {
    const { cleanupFiles } = buildClaudeArgs(opts({ yolo: true, prompt: 'go' }) as never);
    expect(cleanupFiles).toHaveLength(2);
    expect(cleanupFiles.some((f: string) => f.includes('claude-sys-'))).toBe(true);
  });

  it('carries the prompt for a harness that is not claude', () => {
    // The defect this file exists for: the prompt used to be dropped here,
    // and the agent booted into a help screen.
    const { parts } = buildClaudeArgs(
      opts({ harness: 'unclose', harnessKey: 'uncloseai', prompt: 'find the leak', model: 'hermes' }) as never,
    );
    const cmd = parts.join(' ');
    expect(cmd).toContain('unclose');
    expect(cmd).toContain('hermes');
    expect(cmd.length).toBeGreaterThan('unclose --model hermes'.length);
  });
});

describe('resolveBootHost', () => {
  it('honours an explicit request over any setting', () => {
    settings.boot_default_host = 'cammy';
    expect(resolveBootHost('guile')).toBe('guile');
  });

  it('falls back to the configured default', () => {
    settings.boot_strategy = 'default';
    settings.boot_default_host = 'cammy';
    expect(resolveBootHost()).toBe('cammy');
  });

  it('lands on localhost when nothing is configured', () => {
    settings.boot_strategy = null;
    settings.boot_default_host = null;
    expect(resolveBootHost()).toBe('localhost');
  });

  it('still returns a host for a strategy that is not implemented yet', () => {
    // least-loaded needs an async mesh query. Until it has one it must fall
    // back rather than return nothing and boot onto undefined.
    settings.boot_strategy = 'least-loaded';
    settings.boot_default_host = 'guile';
    expect(resolveBootHost()).toBe('guile');
  });
});
