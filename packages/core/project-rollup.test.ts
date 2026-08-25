import { describe, it, expect } from 'vitest';
import {
  stripHarness,
  rollupTarget,
  rollupProjects,
  newerOf,
  type RollupInput,
} from './project-rollup.js';

// A real fleet-worker name, from ~/.unfirehose/unfirehose.db on 2026-08-25.
const WORKER =
  'uncloseai:home-fox-git-arborist-bench-missions-vault_challenge_2_mesh-' +
  'results-2026-08-25_0c293c9-fleet-workers-worker_008-workspace-' +
  'agent_worker_008_b_grszvv';

const REPOS = new Set([
  '-home-fox-git-arborist',
  '-home-fox-git-unfirehose-nextjs-logger',
  '-home-fox-git-uncloseai-cli',
  '-home-fox-git-un',
]);

describe('stripHarness', () => {
  it('splits a harness-scoped name', () => {
    expect(stripHarness('uncloseai:home-fox-git-x')).toEqual({
      harness: 'uncloseai', slug: 'home-fox-git-x',
    });
  });

  it('leaves a bare name alone', () => {
    expect(stripHarness('-home-fox-git-x')).toEqual({ harness: null, slug: '-home-fox-git-x' });
  });
});

describe('rollupTarget', () => {
  it('folds a fleet-worker workspace into its repo', () => {
    expect(rollupTarget(WORKER, REPOS)).toBe('-home-fox-git-arborist');
  });

  it('tolerates the leading-dash mismatch between the two naming styles', () => {
    expect(rollupTarget('uncloseai:home-fox-git-arborist-bench-x', REPOS))
      .toBe('-home-fox-git-arborist');
  });

  it('only matches on a segment boundary', () => {
    // `-home-fox-git-un` must not swallow the unfirehose repo.
    expect(rollupTarget('uncloseai:home-fox-git-unfirehose-nextjs-logger-scratch', REPOS))
      .toBe('-home-fox-git-unfirehose-nextjs-logger');
  });

  it('prefers the longest containing repo', () => {
    const repos = new Set(['-home-fox-git-a', '-home-fox-git-a-b']);
    expect(rollupTarget('uncloseai:home-fox-git-a-b-c', repos)).toBe('-home-fox-git-a-b');
  });

  it('returns null when nothing contains it', () => {
    expect(rollupTarget('uncloseai:var-tmp-somewhere-else', REPOS)).toBeNull();
  });
});

describe('rollupProjects', () => {
  const mk = (name: string, latest: string, sessions = 1, messages = 10): RollupInput =>
    ({ name, latestActivity: latest, sessionCount: sessions, totalMessages: messages });

  const merge = (repo: RollupInput, child: RollupInput) => {
    repo.latestActivity = newerOf(repo.latestActivity, child.latestActivity);
    repo.sessionCount += child.sessionCount;
    repo.totalMessages += child.totalMessages;
  };

  it('bumps a repo to its newest folded child — the reported defect', () => {
    const all = [
      mk('-home-fox-git-arborist', '2026-08-20T00:00:00Z'),
      mk(WORKER, '2026-08-25T19:28:23Z'),
    ];
    const { rows, foldedInto } = rollupProjects(all, REPOS, merge);
    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe('-home-fox-git-arborist');
    // The repo now sorts by the uncloseai session, not its own last claude one.
    expect(rows[0].latestActivity).toBe('2026-08-25T19:28:23Z');
    expect(foldedInto.get(WORKER)).toBe('-home-fox-git-arborist');
  });

  it('accumulates counts from every folded child', () => {
    const all = [
      mk('-home-fox-git-arborist', '2026-08-20T00:00:00Z', 2, 20),
      mk('uncloseai:home-fox-git-arborist-w1', '2026-08-21T00:00:00Z', 1, 5),
      mk('uncloseai:home-fox-git-arborist-w2', '2026-08-22T00:00:00Z', 1, 7),
    ];
    const { rows } = rollupProjects(all, REPOS, merge);
    expect(rows).toHaveLength(1);
    expect(rows[0].sessionCount).toBe(4);
    expect(rows[0].totalMessages).toBe(32);
    expect(rows[0].latestActivity).toBe('2026-08-22T00:00:00Z');
  });

  it('keeps a row that matches no repo rather than dropping the work', () => {
    const all = [mk('uncloseai:var-tmp-orphan', '2026-08-25T00:00:00Z')];
    const { rows } = rollupProjects(all, REPOS, merge);
    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe('uncloseai:var-tmp-orphan');
  });

  it('keeps a repo row even with no children', () => {
    const all = [mk('-home-fox-git-uncloseai-cli', '2026-08-01T00:00:00Z')];
    const { rows } = rollupProjects(all, REPOS, merge);
    expect(rows.map((r) => r.name)).toEqual(['-home-fox-git-uncloseai-cli']);
  });

  it('does not fold a repo into another repo', () => {
    const all = [
      mk('-home-fox-git-un', '2026-08-01T00:00:00Z'),
      mk('-home-fox-git-uncloseai-cli', '2026-08-02T00:00:00Z'),
    ];
    const { rows } = rollupProjects(all, REPOS, merge);
    expect(rows).toHaveLength(2);
  });

  it('collapses a realistic fleet: 453 workspaces into one repo', () => {
    const all: RollupInput[] = [mk('-home-fox-git-arborist', '2026-08-20T00:00:00Z')];
    for (let i = 0; i < 453; i++) {
      all.push(mk(`uncloseai:home-fox-git-arborist-bench-worker_${i}-workspace`,
        `2026-08-25T19:${String(i % 60).padStart(2, '0')}:00Z`));
    }
    const { rows } = rollupProjects(all, REPOS, merge);
    expect(rows).toHaveLength(1);
    expect(rows[0].sessionCount).toBe(454);
    expect(rows[0].latestActivity).toBe('2026-08-25T19:59:00Z');
  });
});

describe('newerOf', () => {
  it('picks the later timestamp', () => {
    expect(newerOf('2026-01-01', '2026-02-01')).toBe('2026-02-01');
  });
  it('tolerates empty strings on either side', () => {
    expect(newerOf('', '2026-02-01')).toBe('2026-02-01');
    expect(newerOf('2026-02-01', '')).toBe('2026-02-01');
    expect(newerOf('', '')).toBe('');
  });
});

describe('unmatched: drop', () => {
  const mk = (name: string, latest: string): RollupInput =>
    ({ name, latestActivity: latest, sessionCount: 1, totalMessages: 1 });
  const merge = (repo: RollupInput, child: RollupInput) => {
    repo.latestActivity = newerOf(repo.latestActivity, child.latestActivity);
    repo.sessionCount += child.sessionCount;
  };

  it('drops an ephemeral container with no containing repo', () => {
    const all = [
      mk('-home-fox-git-arborist', '2026-08-20T00:00:00Z'),
      mk('sandbox-ies4iwla', '2026-08-25T00:00:00Z'),
      mk('uncloseai:tmp-tmpnp6c2881', '2026-08-25T00:00:00Z'),
    ];
    const { rows, orphans } = rollupProjects(all, REPOS, merge, { unmatched: 'drop' });
    expect(rows.map((r) => r.name)).toEqual(['-home-fox-git-arborist']);
    expect(orphans).toHaveLength(2);
  });

  it('still folds a /tmp scratchpad that embeds its repo name', () => {
    const all = [
      mk('-home-fox-git-uncloseai-cli', '2026-08-20T00:00:00Z'),
      mk('uncloseai:tmp-claude-1000--home-fox-git-uncloseai-cli-8ddaa69f-scratchpad',
         '2026-08-25T12:00:00Z'),
    ];
    const { rows, orphans } = rollupProjects(all, REPOS, merge, { unmatched: 'drop' });
    expect(orphans).toHaveLength(0);
    expect(rows).toHaveLength(1);
    expect(rows[0].latestActivity).toBe('2026-08-25T12:00:00Z');
  });

  it('prefers a prefix match over an embedded one', () => {
    const repos = new Set(['-home-fox-git-arborist', '-home-fox-git-uncloseai-cli']);
    expect(rollupTarget('uncloseai:home-fox-git-arborist-tmp--home-fox-git-uncloseai-cli-x', repos))
      .toBe('-home-fox-git-arborist');
  });

  it('keeps unmatched rows when asked to', () => {
    const all = [mk('sandbox-abc', '2026-08-25T00:00:00Z')];
    const { rows } = rollupProjects(all, REPOS, merge, { unmatched: 'keep' });
    expect(rows).toHaveLength(1);
  });
});
