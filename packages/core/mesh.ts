import { readFileSync, readdirSync } from 'fs';
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
    const sshConfig = readSshConfig(path.join(homedir(), '.ssh', 'config'));
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

// ssh_config(5) caps Include nesting at 16; a loop past that is a mistake,
// not a mesh.
const MAX_INCLUDE_DEPTH = 16;

/**
 * An ssh config with every `Include` read in where it stands, the way ssh
 * itself reads it. Paths may be absolute, `~/`-rooted or relative to
 * ~/.ssh, and may glob (`config.d/*`); matches are taken in lexical order,
 * a missing file is skipped. Throws only when the top file is unreadable.
 */
export function readSshConfig(file: string, depth = 0): string {
  const text = readFileSync(file, 'utf-8');
  if (depth >= MAX_INCLUDE_DEPTH) return text;
  return text.split('\n').map((line) => {
    const m = line.match(/^\s*Include\s*(?:=\s*)?(.+?)\s*$/i);
    if (!m) return line;
    return sshWords(m[1]).flatMap(includePaths).map((f) => {
      try { return readSshConfig(f, depth + 1); } catch { return ''; }
    }).join('\n');
  }).join('\n');
}

/** Whitespace-separated words, double quotes keeping a path with spaces whole. */
function sshWords(s: string): string[] {
  return [...s.matchAll(/"([^"]*)"|(\S+)/g)].map((m) => m[1] ?? m[2]);
}

/** One Include argument as the files it names, globs expanded. */
function includePaths(arg: string): string[] {
  const home = homedir();
  const abs = arg.startsWith('~/') ? path.join(home, arg.slice(2))
    : path.isAbsolute(arg) ? arg
    : path.join(home, '.ssh', arg);
  if (!/[*?[]/.test(abs)) return [abs];
  // Walk the path a segment at a time, globbing only the segments that ask.
  let found = [path.parse(abs).root];
  for (const seg of abs.split(path.sep).filter(Boolean)) {
    if (!/[*?[]/.test(seg)) { found = found.map((d) => path.join(d, seg)); continue; }
    const re = globToRegExp(seg);
    found = found.flatMap((d) => {
      try {
        return readdirSync(d).filter((n) => re.test(n) && !(n.startsWith('.') && !seg.startsWith('.')))
          .sort().map((n) => path.join(d, n));
      } catch { return []; }
    });
  }
  return found;
}

function globToRegExp(seg: string): RegExp {
  let re = '';
  for (let i = 0; i < seg.length; i++) {
    const c = seg[i];
    if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else if (c === '[') {
      const end = seg.indexOf(']', i + 1);
      if (end === -1) { re += '\\['; continue; }
      re += '[' + seg.slice(i + 1, end).replace(/^!/, '^').replace(/\\/g, '\\\\') + ']';
      i = end;
    } else re += c.replace(/[.+^${}()|\\]/g, '\\$&');
  }
  return new RegExp('^' + re + '$');
}
