import { describe, it, expect, vi } from 'vitest';

vi.mock('os', () => ({
  homedir: () => '/mock/home',
}));

// Import after mock
const { claudePaths, decodeProjectName } = await import('./claude-paths');

describe('claudePaths', () => {
  it('sets root to ~/.claude/', () => {
    expect(claudePaths.root).toBe('/mock/home/.claude');
  });

  it('sets projects to ~/.claude/projects', () => {
    expect(claudePaths.projects).toBe('/mock/home/.claude/projects');
  });

  it('sets statsCache path', () => {
    expect(claudePaths.statsCache).toBe('/mock/home/.claude/stats-cache.json');
  });

  it('returns correct projectDir', () => {
    expect(claudePaths.projectDir('test-proj')).toBe('/mock/home/.claude/projects/test-proj');
  });

  it('returns correct sessionsIndex path', () => {
    expect(claudePaths.sessionsIndex('test-proj')).toBe('/mock/home/.claude/projects/test-proj/sessions-index.json');
  });

  it('returns correct sessionFile path', () => {
    expect(claudePaths.sessionFile('test-proj', 'abc-123')).toBe('/mock/home/.claude/projects/test-proj/abc-123.jsonl');
  });

  it('returns correct subagentsDir', () => {
    expect(claudePaths.subagentsDir('test-proj', 'abc-123')).toBe('/mock/home/.claude/projects/test-proj/abc-123/subagents');
  });

  it('returns correct memory path', () => {
    expect(claudePaths.memory('test-proj')).toBe('/mock/home/.claude/projects/test-proj/memory/MEMORY.md');
  });
});

describe('decodeProjectName', () => {
  it('decodes a path with git segment', () => {
    expect(decodeProjectName('-home-fox-git-unsandbox-com')).toBe('unsandbox-com');
  });

  it('decodes a multi-segment project after git', () => {
    expect(decodeProjectName('-home-fox-git-make-post-sell')).toBe('make-post-sell');
  });

  it('uses last git segment when multiple exist', () => {
    expect(decodeProjectName('-home-git-old-git-new-project')).toBe('new-project');
  });

  it('falls back to last two segments when no git found', () => {
    expect(decodeProjectName('-home-fox-myproject')).toBe('fox-myproject');
  });

  it('handles leading dash correctly', () => {
    expect(decodeProjectName('-home-fox-git-app')).toBe('app');
  });

  it('handles empty string', () => {
    expect(decodeProjectName('')).toBe('');
  });
});
