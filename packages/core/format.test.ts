import { describe, it, expect } from 'vitest';
import {
  formatTokens,
  formatBytes,
  formatRelativeTime,
  formatTimestamp,
  formatDate,
  formatDuration,
  formatCost,
  truncate,
  extractUserText,
  gitRemoteToWebUrl,
  commitUrl,
} from './format';

describe('formatTokens', () => {
  it('returns raw number for values under 1000', () => {
    expect(formatTokens(0)).toBe('0');
    expect(formatTokens(500)).toBe('500');
    expect(formatTokens(999)).toBe('999');
  });

  it('formats thousands with K suffix', () => {
    expect(formatTokens(1000)).toBe('1.0K');
    expect(formatTokens(1500)).toBe('1.5K');
    expect(formatTokens(999999)).toBe('1000.0K');
  });

  it('formats millions with M suffix', () => {
    expect(formatTokens(1_000_000)).toBe('1.0M');
    expect(formatTokens(2_500_000)).toBe('2.5M');
    expect(formatTokens(15_000_000)).toBe('15.0M');
  });
});

describe('formatBytes', () => {
  it('returns bytes with B suffix for small values', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(1023)).toBe('1023 B');
  });

  it('formats kilobytes', () => {
    expect(formatBytes(1024)).toBe('1.0 KB');
    expect(formatBytes(1536)).toBe('1.5 KB');
  });

  it('formats megabytes', () => {
    expect(formatBytes(1_048_576)).toBe('1.0 MB');
    expect(formatBytes(253 * 1_048_576)).toBe('253.0 MB');
  });

  it('formats gigabytes', () => {
    expect(formatBytes(1_073_741_824)).toBe('1.0 GB');
    expect(formatBytes(3 * 1_073_741_824)).toBe('3.0 GB');
  });
});

describe('formatRelativeTime', () => {
  it('returns relative time string for a recent ISO date', () => {
    const recent = new Date(Date.now() - 60_000).toISOString();
    const result = formatRelativeTime(recent);
    expect(result).toContain('ago');
  });

  it('returns the original string for an invalid ISO date', () => {
    expect(formatRelativeTime('not-a-date')).toBe('not-a-date');
  });
});

describe('formatTimestamp', () => {
  it('formats a valid ISO string to yyyy-MM-dd HH:mm:ss', () => {
    expect(formatTimestamp('2026-03-03T14:30:45.123Z')).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  });

  it('returns the original string for an invalid date', () => {
    expect(formatTimestamp('invalid')).toBe('invalid');
  });
});

describe('formatDate', () => {
  it('formats a valid ISO string to MMM d, yyyy', () => {
    expect(formatDate('2026-03-03T14:30:45.123Z')).toMatch(/Mar 3, 2026/);
  });

  it('returns the original string for an invalid date', () => {
    expect(formatDate('nope')).toBe('nope');
  });
});

describe('formatDuration', () => {
  it('formats durations under 60 seconds as Xs', () => {
    expect(formatDuration(0)).toBe('0s');
    expect(formatDuration(5000)).toBe('5s');
    expect(formatDuration(59_000)).toBe('59s');
  });

  it('formats minutes range as Xm Ys', () => {
    expect(formatDuration(60_000)).toBe('1m 0s');
    expect(formatDuration(90_000)).toBe('1m 30s');
    expect(formatDuration(3_540_000)).toBe('59m 0s');
  });

  it('formats hours range as Xh Ym', () => {
    expect(formatDuration(3_600_000)).toBe('1h 0m');
    expect(formatDuration(7_260_000)).toBe('2h 1m');
  });
});

describe('formatCost', () => {
  it('formats costs >= $1 with 2 decimal places', () => {
    expect(formatCost(1.5)).toBe('$1.50');
    expect(formatCost(100)).toBe('$100.00');
  });

  it('formats costs >= $0.01 with 2 decimal places', () => {
    expect(formatCost(0.05)).toBe('$0.05');
    expect(formatCost(0.99)).toBe('$0.99');
  });

  it('formats small costs > 0 with 4 decimal places', () => {
    expect(formatCost(0.001)).toBe('$0.0010');
    expect(formatCost(0.0001)).toBe('$0.0001');
  });

  it('formats zero cost as $0.00', () => {
    expect(formatCost(0)).toBe('$0.00');
  });
});

describe('truncate', () => {
  it('returns the string unchanged when shorter than maxLen', () => {
    expect(truncate('hello', 10)).toBe('hello');
  });

  it('returns the string unchanged when exactly maxLen', () => {
    expect(truncate('hello', 5)).toBe('hello');
  });

  it('truncates and adds ellipsis when longer than maxLen', () => {
    const result = truncate('hello world', 6);
    expect(result).toBe('hello\u2026');
    expect(result.length).toBe(6);
  });

  it('handles empty string', () => {
    expect(truncate('', 5)).toBe('');
  });
});

describe('extractUserText', () => {
  it('returns the string directly when content is a string', () => {
    expect(extractUserText({ message: { content: 'hello' } })).toBe('hello');
  });

  it('extracts text from an array of content blocks', () => {
    const entry = {
      message: {
        content: [
          { type: 'text', text: 'hello' },
          { type: 'text', text: 'world' },
        ],
      },
    };
    expect(extractUserText(entry)).toBe('hello\nworld');
  });

  it('filters out non-text blocks', () => {
    const entry = {
      message: {
        content: [
          { type: 'text', text: 'hello' },
          { type: 'tool_use', id: 'x', name: 'bash', input: {} },
        ],
      },
    };
    expect(extractUserText(entry)).toBe('hello');
  });

  it('returns empty string for non-string non-array content', () => {
    expect(extractUserText({ message: { content: 42 } })).toBe('');
    expect(extractUserText({ message: { content: null } })).toBe('');
  });

  it('returns empty string for empty array', () => {
    expect(extractUserText({ message: { content: [] } })).toBe('');
  });
});

describe('gitRemoteToWebUrl', () => {
  it('converts GitHub SSH shorthand to HTTPS', () => {
    expect(gitRemoteToWebUrl('git@github.com:owner/repo.git')).toBe('https://github.com/owner/repo');
  });

  it('strips .git suffix from SSH remotes', () => {
    expect(gitRemoteToWebUrl('git@github.com:owner/repo.git')).not.toContain('.git');
  });

  it('converts GitHub HTTPS to canonical HTTPS', () => {
    expect(gitRemoteToWebUrl('https://github.com/owner/repo.git')).toBe('https://github.com/owner/repo');
  });

  it('handles HTTPS without .git suffix', () => {
    expect(gitRemoteToWebUrl('https://github.com/owner/repo')).toBe('https://github.com/owner/repo');
  });

  it('converts GitLab SSH shorthand', () => {
    expect(gitRemoteToWebUrl('git@gitlab.com:group/project.git')).toBe('https://gitlab.com/group/project');
  });

  it('converts self-hosted Gitea/Forgejo SSH url with explicit port', () => {
    expect(gitRemoteToWebUrl('ssh://git@git.unturf.com:22/fox/myrepo.git')).toBe('https://git.unturf.com/fox/myrepo');
  });

  it('converts self-hosted HTTPS remote', () => {
    expect(gitRemoteToWebUrl('https://git.unturf.com/fox/myrepo.git')).toBe('https://git.unturf.com/fox/myrepo');
  });

  it('returns null for unrecognized format', () => {
    expect(gitRemoteToWebUrl('file:///local/path')).toBeNull();
    expect(gitRemoteToWebUrl('not-a-remote')).toBeNull();
  });
});

describe('commitUrl', () => {
  it('builds GitHub commit URL', () => {
    const url = commitUrl('git@github.com:owner/repo.git', 'abc1234');
    expect(url).toBe('https://github.com/owner/repo/commit/abc1234');
  });

  it('builds GitLab commit URL with /-/commit/ path', () => {
    const url = commitUrl('git@gitlab.com:group/project.git', 'def5678');
    expect(url).toBe('https://gitlab.com/group/project/-/commit/def5678');
  });

  it('builds Gitea commit URL (no /-/ path)', () => {
    const url = commitUrl('https://git.unturf.com/fox/repo.git', 'abc1234');
    expect(url).toBe('https://git.unturf.com/fox/repo/commit/abc1234');
  });

  it('returns null for invalid remote URL', () => {
    expect(commitUrl('not-a-remote', 'abc1234')).toBeNull();
  });

  it('uses full commit hash in URL', () => {
    const hash = 'a'.repeat(40);
    const url = commitUrl('git@github.com:owner/repo.git', hash);
    expect(url).toContain(hash);
  });
});
