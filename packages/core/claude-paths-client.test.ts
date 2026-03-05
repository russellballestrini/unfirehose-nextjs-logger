import { describe, it, expect } from 'vitest';
import { decodeProjectName } from './claude-paths-client';

describe('decodeProjectName (client)', () => {
  it('decodes a path with git segment', () => {
    expect(decodeProjectName('-home-fox-git-unsandbox-com')).toBe('unsandbox-com');
  });

  it('falls back to last two segments when no git found', () => {
    expect(decodeProjectName('-home-fox-myproject')).toBe('fox-myproject');
  });

  it('handles empty string', () => {
    expect(decodeProjectName('')).toBe('');
  });

  it('decodes deep paths after git', () => {
    expect(decodeProjectName('-home-fox-git-unfirehose')).toBe('unfirehose');
  });
});
