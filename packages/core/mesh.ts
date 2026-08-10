import { readFileSync } from 'fs';
import { homedir } from 'os';
import path from 'path';

// Discover mesh nodes from SSH config.
// Aliases that resolve to the same target (two Host blocks sharing a HostName,
// or a block whose HostName is another block's name) collapse to one node —
// first block in file order wins. Without this, an alias double-counts a
// machine's cores/memory/watts across the whole mesh.
export function discoverNodes(): string[] {
  const nodes = new Set<string>();
  const seenTargets = new Set<string>();
  nodes.add('localhost');
  seenTargets.add('localhost');

  try {
    const sshConfig = readFileSync(path.join(homedir(), '.ssh', 'config'), 'utf-8');
    const blocks = sshConfig.split(/^(?=Host\s)/m);
    for (const block of blocks) {
      const hostMatch = block.match(/^Host\s+(.+)/);
      if (!hostMatch) continue;
      const hostname = block.match(/^\s*HostName\s+(\S+)/mi)?.[1];
      for (const h of hostMatch[1].trim().split(/\s+/)) {
        if (h.includes('*') || h.includes('git.') || h.includes('github')) continue;
        if (h.includes('.foxhop.net') || (!h.includes('.') && h !== 'localhost')) {
          const target = (hostname ?? h).toLowerCase();
          if (seenTargets.has(target)) continue;
          seenTargets.add(target);
          nodes.add(h);
        }
      }
    }
  } catch {
    // SSH config not readable
  }

  return [...nodes];
}
