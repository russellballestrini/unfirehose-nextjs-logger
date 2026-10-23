/**
 * Agent action ledger: what a tool call did to our machine.
 *
 * Every tool call already sits in content_blocks as a name and a JSON
 * input. This reads one and says which of five things it was — a read of
 * the filesystem, a write to it, a git operation, a network call, or some
 * other shell command — which paths and command it named, and whether it
 * was one a person would want pointed out: destructive, a force push, a
 * credential written into a file or carried on a command line, sudo, or a
 * script piped from the network into a shell.
 *
 * Pure functions, no database. db/action-ledger-scan.ts runs them over
 * ingested blocks into the action_ledger table.
 *
 * Precision over recall, for `destructive` above all. `rm -rf dist` in a
 * project is housekeeping and `rm -rf ~` is not; a flag that fires on both
 * teaches a person to ignore it. So a recursive delete is flagged by what
 * it targets (root, home, a system directory, a top-level directory, an
 * unset-variable path), and a git command by whether it throws away work
 * (reset --hard, clean -f, checkout ., branch -D, stash drop). Rules are
 * versioned (LEDGER_RULES_VERSION): changing one re-classifies history.
 *
 * Tool names differ per harness. Claude Code says Read/Write/Edit/Bash;
 * Codex says shell/exec_command/apply_patch; Gemini CLI run_shell_command,
 * read_file, write_file, replace; OpenCode execute_command, edit_file; pi
 * and hermes bash/shell. Names are compared case- and punctuation-blind.
 */
import { findSecrets, redactSecrets } from './pii';
import { splitTopLevel, type ShellPiece } from './shell-pretty';

/** Bump when a rule changes; the scanner then rebuilds the ledger from blocks. */
export const LEDGER_RULES_VERSION = 1;

export const ACTION_KINDS = ['fs-read', 'fs-write', 'git', 'network', 'shell'] as const;
export type ActionKind = (typeof ACTION_KINDS)[number];

export const ACTION_FLAGS = [
  'destructive',
  'force-push',
  'force-with-lease',
  'secrets-in-diff',
  'secret-in-command',
  'sudo',
  'curl-pipe-shell',
] as const;
export type ActionFlag = (typeof ACTION_FLAGS)[number];

export interface ClassifiedAction {
  kind: ActionKind;
  /** Files, directories, URLs or hosts the call named; secrets redacted. */
  paths: string[];
  /** The shell command, URL, query or pattern; secrets redacted. Null for a plain file tool. */
  command: string | null;
  flags: ActionFlag[];
  /** Why each flag fired, in words: "rm -rf of home directory (~)". */
  reasons: string[];
}

const MAX_PATHS = 20;
const MAX_COMMAND = 4000;

// ── Tool names ───────────────────────────────────────────────────────────────

const norm = (name: string) => name.toLowerCase().replace(/[^a-z]/g, '');

const READ_TOOLS = new Set([
  'read', 'readfile', 'notebookread', 'glob', 'grep', 'ls', 'list', 'listdirectory', 'listfiles',
  'listdir', 'searchfiles', 'searchfilecontent', 'readmanyfiles', 'viewimage', 'view', 'find', 'cat',
  'codebasesearch', 'filesearch',
]);
const WRITE_TOOLS = new Set([
  'write', 'writefile', 'edit', 'multiedit', 'notebookedit', 'editfile', 'replace', 'applypatch',
  'patch', 'createfile', 'deletefile', 'strreplaceeditor', 'strreplacebasededittool', 'searchreplace',
]);
const SHELL_TOOLS = new Set([
  'bash', 'shell', 'runshellcommand', 'executecommand', 'exec', 'execcommand', 'localshell', 'run',
  'terminal', 'runterminalcmd', 'runterminalcommand', 'containerexec', 'runcommand', 'command', 'sh',
]);
const NETWORK_TOOLS = new Set([
  'webfetch', 'websearch', 'googlewebsearch', 'fetch', 'webfetchtool', 'browse', 'browser', 'httprequest',
  'searchweb', 'urlfetch',
]);

// ── Input parsing ────────────────────────────────────────────────────────────

type Input = Record<string, unknown>;

/**
 * A tool input however it was stored. content_blocks.tool_input is a JSON
 * string of the input; Codex hands its arguments over as a string already,
 * so that one decodes twice, and apply_patch's input is raw patch text.
 */
export function parseToolInput(raw: unknown): Input {
  let v: unknown = raw;
  for (let i = 0; i < 2 && typeof v === 'string'; i++) {
    try { v = JSON.parse(v); } catch { break; }
  }
  if (v && typeof v === 'object' && !Array.isArray(v)) return v as Input;
  if (typeof v === 'string') return { raw: v };
  if (Array.isArray(v)) return { command: v };
  return {};
}

const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);

function firstStr(input: Input, keys: string[]): string | null {
  for (const k of keys) {
    const s = str(input[k]);
    if (s) return s;
  }
  return null;
}

/** The shell text a shell tool ran, whichever key and shape its harness uses. */
function shellText(input: Input): string | null {
  const nested = input.action && typeof input.action === 'object' ? (input.action as Input) : null;
  const c = input.command ?? input.cmd ?? input.script ?? nested?.command ?? input.raw;
  if (typeof c === 'string') return c;
  if (Array.isArray(c) && c.every((x) => typeof x === 'string')) {
    const argv = c as string[];
    // ["bash", "-lc", "<script>"] is a script, not three words.
    if (argv.length >= 3 && /(^|\/)(ba|z|da|k)?sh$/.test(argv[0]) && /^-\w*c\w*$/.test(argv[1])) return argv.slice(2).join(' ');
    return argv.map((a) => (/[\s"'$]/.test(a) ? `'${a.replace(/'/g, `'\\''`)}'` : a)).join(' ');
  }
  return null;
}

// ── Paths ────────────────────────────────────────────────────────────────────

const SYSTEM_ROOTS = new Set([
  'etc', 'usr', 'bin', 'sbin', 'lib', 'lib32', 'lib64', 'boot', 'sys', 'proc', 'dev', 'var', 'opt',
  'root', 'srv', 'snap', 'System', 'Library', 'Applications', 'private',
]);
const SCRATCH = /^\/(?:tmp|var\/tmp|private\/tmp|private\/var\/folders|var\/folders|dev\/shm|run\/user\/\d+)(?:\/|$)/;
const HOME_RE = /^(?:~|\$HOME|\$\{HOME\})(?=\/|$)/;
const HOME_PREFIX = /^\/(?:home|Users)\/[^/]+/;
// A home's directories that hold far more than one project.
const HOME_PRECIOUS = new Set(['git', 'src', 'code', 'projects', 'work', 'Documents', 'Desktop', 'Pictures', 'Downloads']);

const unquote = (s: string) => s.replace(/^(['"])(.*)\1$/, '$2');

/**
 * Why deleting `target` recursively throws away more than a project's own
 * build output, or null when it does not. Relative paths inside a project
 * (`dist`, `node_modules`, `./build`) and anything under /tmp are null.
 */
export function dangerousDeleteTarget(target: string): string | null {
  const p = unquote(target.trim());
  if (!p) return null;
  if (p === '/' || p === '/*' || p === '/.*') return 'the root directory';
  if (['*', '.*', '.', './', './*', '..', '../', '../*'].includes(p)) return `everything in the working directory (${p})`;
  if (/^\$\{?[A-Za-z_][A-Za-z0-9_]*\}?\/\*?$/.test(p)) return `${p}, which is / when the variable is unset`;
  let rest: string | null = null;
  if (HOME_RE.test(p)) rest = p.replace(HOME_RE, '');
  else if (HOME_PREFIX.test(p)) rest = p.replace(HOME_PREFIX, '');
  if (rest !== null) {
    const segs = rest.split('/').filter(Boolean);
    if (segs.length === 0 || (segs.length === 1 && (segs[0] === '*' || segs[0] === '.*'))) return `the home directory (${p})`;
    if (segs.length === 1 && (segs[0].startsWith('.') || HOME_PRECIOUS.has(segs[0]))) return `a home directory folder (${p})`;
    return null;
  }
  if (!p.startsWith('/')) return null;
  if (SCRATCH.test(p)) return null;
  const segs = p.split('/').filter(Boolean);
  if (segs[0] === 'home' || segs[0] === 'Users') return `every home directory (${p})`;
  if (SYSTEM_ROOTS.has(segs[0])) return `a system path (${p})`;
  if (segs.length === 1) return `a top-level directory (${p})`;
  return null;
}

/**
 * Why overwriting `target` damages the machine rather than a project, or
 * null. System files, block devices, and the dotfiles that run at login.
 */
export function sensitiveWriteTarget(target: string): string | null {
  const p = unquote(target.trim());
  if (!p || p === '/dev/null' || p === '/dev/stdout' || p === '/dev/stderr' || p.startsWith('/dev/fd/') || p === '/dev/tty') return null;
  if (/^\/dev\/(?:sd|hd|vd|xvd|nvme|disk|mmcblk|md|dm-|mapper\/)/.test(p)) return `a block device (${p})`;
  if (p.startsWith('/') && !SCRATCH.test(p)) {
    const seg = p.split('/').filter(Boolean)[0];
    if (seg && SYSTEM_ROOTS.has(seg) && seg !== 'dev' && seg !== 'opt') return `a system file (${p})`;
  }
  const rest = HOME_RE.test(p) ? p.replace(HOME_RE, '') : HOME_PREFIX.test(p) ? p.replace(HOME_PREFIX, '') : null;
  if (rest !== null) {
    if (/^\/\.ssh\//.test(rest)) return `an ssh file (${p})`;
    if (/^\/\.(?:bashrc|bash_profile|profile|zshrc|zprofile|zshenv|login|gnupg\/)/.test(rest)) return `a login dotfile (${p})`;
  }
  return null;
}

// ── Shell ────────────────────────────────────────────────────────────────────

interface Redirect { op: string; target: string }
interface Words { words: string[]; redirects: Redirect[]; heredoc: string | null }

/**
 * One statement into words, with quotes removed, plus its redirects and
 * heredoc body. Not a shell: nothing expands. Enough to know which program
 * ran and what it was handed.
 */
export function shellWords(piece: string): Words {
  let text = piece;
  let heredoc: string | null = null;
  const hd = /<<-?\s*(['"]?)([A-Za-z0-9_]+)\1/.exec(text);
  if (hd) {
    const nl = text.indexOf('\n', hd.index);
    if (nl !== -1) {
      heredoc = text.slice(nl + 1).replace(new RegExp(`\\n?\\s*${hd[2]}\\s*$`), '');
      text = text.slice(0, nl);
    }
    text = text.slice(0, hd.index) + text.slice(hd.index + hd[0].length);
  }
  const words: string[] = [];
  const redirects: Redirect[] = [];
  let buf = '';
  let has = false;
  let pendingOp: string | null = null;
  const flush = () => {
    if (!has) return;
    if (pendingOp) { redirects.push({ op: pendingOp, target: buf }); pendingOp = null; }
    else words.push(buf);
    buf = ''; has = false;
  };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === "'") {
      const end = text.indexOf("'", i + 1);
      buf += end === -1 ? text.slice(i + 1) : text.slice(i + 1, end);
      has = true;
      i = end === -1 ? text.length : end;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') { if (text[j] === '\\') j++; buf += text[j] ?? ''; j++; }
      has = true;
      i = j;
      continue;
    }
    if (c === '\\') { buf += text[i + 1] ?? ''; has = true; i++; continue; }
    if (/\s/.test(c)) { flush(); continue; }
    // Redirects: >, >>, 2>, &>, >|, <, <<< (here-string; its word is data).
    const r = /^(>>|>\||>&|>|<<<|<)/.exec(text.slice(i));
    if (r) {
      // `2>` names a descriptor: drop the digits. `hi>f` ends the word `hi`.
      if (has && /^\d+$/.test(buf)) { buf = ''; has = false; } else flush();
      i += r[1].length - 1;
      let op = r[1] === '>|' ? '>' : r[1];
      if (op === '>&') {
        // 2>&1 and >&2 duplicate a descriptor; `>& file` is a file.
        const d = /^(\d+|-)/.exec(text.slice(i + 1));
        if (d) { i += d[0].length; continue; }
        op = '>';
      }
      pendingOp = op;
      continue;
    }
    buf += c;
    has = true;
  }
  flush();
  return { words, redirects, heredoc };
}

// Wrappers that run the command after them. Value: how many argument words
// a wrapper's own options consume, roughly.
const WRAPPERS = new Set(['sudo', 'doas', 'env', 'nohup', 'time', 'nice', 'ionice', 'timeout', 'command', 'exec', 'xargs', 'stdbuf', 'chronic', 'unbuffer', 'caffeinate', 'builtin']);
const SUDO = new Set(['sudo', 'doas', 'pkexec']);

const base = (w: string) => w.replace(/^.*\//, '');

/** Strip env assignments and wrappers; return the program, its args, and whether sudo ran it. */
function program(words: string[]): { prog: string; args: string[]; sudo: boolean } {
  let i = 0;
  let sudo = false;
  while (i < words.length) {
    const w = words[i];
    if (w === '(' || w === '{' || w === '!' || w === 'then' || w === 'do' || w === 'else') { i++; continue; }
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(w)) { i++; continue; }
    const b = base(w).replace(/^[({]+/, '');
    if (WRAPPERS.has(b) || SUDO.has(b)) {
      if (SUDO.has(b)) sudo = true;
      i++;
      // Their options: -u user, -n 10, a duration for timeout.
      while (i < words.length && (words[i].startsWith('-') || (b === 'timeout' && /^\d/.test(words[i])) || /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i]))) {
        const opt = words[i];
        i++;
        if ((b === 'sudo' && /^-[ugCDhpRrTt]$/.test(opt)) || (b === 'nice' && opt === '-n') || (b === 'xargs' && /^-[IdLnPsaE]$/.test(opt)) || (b === 'env' && /^-[uSC]$/.test(opt))) i++;
      }
      continue;
    }
    break;
  }
  const prog = i < words.length ? base(words[i]).replace(/^[({]+/, '') : '';
  return { prog, args: words.slice(i + 1), sudo };
}

const isOpt = (a: string) => a.startsWith('-') && a !== '-';
/** Short-option letters a word carries: "-rf" → "rf", "--force" → "". */
const shortOpts = (args: string[]) => args.filter((a) => /^-[A-Za-z]+$/.test(a)).map((a) => a.slice(1)).join('');

const NETWORK_PROGS = new Set([
  'curl', 'wget', 'ssh', 'scp', 'sftp', 'mosh', 'nc', 'ncat', 'netcat', 'telnet', 'ftp', 'lftp', 'http', 'https',
  'xh', 'aria2c', 'ping', 'dig', 'nslookup', 'host', 'whois', 'traceroute', 'mtr', 'gh', 'glab', 'npx', 'bunx',
  'twine', 'websocat', 'grpcurl',
]);
const INSTALLERS: Record<string, Set<string>> = {
  npm: new Set(['install', 'i', 'ci', 'add', 'update', 'publish', 'unpublish', 'login', 'view', 'info', 'outdated', 'audit']),
  pnpm: new Set(['install', 'i', 'add', 'update', 'publish', 'dlx']),
  yarn: new Set(['install', 'add', 'upgrade', 'publish', 'dlx']),
  bun: new Set(['install', 'i', 'add', 'update', 'publish']),
  pip: new Set(['install', 'download']),
  pip3: new Set(['install', 'download']),
  uv: new Set(['add', 'sync', 'pip', 'tool']),
  poetry: new Set(['add', 'install', 'update', 'publish']),
  cargo: new Set(['install', 'add', 'publish', 'update', 'fetch']),
  go: new Set(['get', 'install', 'mod']),
  gem: new Set(['install', 'push', 'update']),
  apt: new Set(['install', 'update', 'upgrade']),
  'apt-get': new Set(['install', 'update', 'upgrade', 'dist-upgrade']),
  brew: new Set(['install', 'update', 'upgrade']),
  dnf: new Set(['install', 'update', 'upgrade']),
  yum: new Set(['install', 'update']),
  pacman: new Set(['-S', '-Syu', '-Sy']),
  docker: new Set(['push', 'pull', 'login']),
  podman: new Set(['push', 'pull', 'login']),
};
const FS_WRITE_PROGS = new Set([
  'rm', 'rmdir', 'mv', 'cp', 'mkdir', 'touch', 'ln', 'chmod', 'chown', 'chgrp', 'tee', 'dd', 'truncate',
  'shred', 'install', 'unlink', 'patch', 'unzip', 'mkfs', 'wipefs',
]);
const FS_READ_PROGS = new Set([
  'cat', 'head', 'tail', 'less', 'more', 'ls', 'find', 'grep', 'egrep', 'fgrep', 'rg', 'ag', 'fd', 'wc', 'stat',
  'file', 'tree', 'du', 'df', 'diff', 'sed', 'awk', 'sort', 'uniq', 'cut', 'jq', 'yq', 'bat', 'readlink',
  'realpath', 'md5sum', 'sha1sum', 'sha256sum', 'xxd', 'od', 'strings', 'nl', 'column', 'tac', 'cmp', 'zcat',
  'basename', 'dirname',
]);
// Programs whose first non-option argument is a pattern or a script, not a path.
const PATTERN_FIRST = new Set(['grep', 'egrep', 'fgrep', 'rg', 'ag', 'sed', 'awk', 'jq', 'yq']);
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'fish']);
const INTERPRETERS = new Set([...SHELLS, 'python', 'python3', 'perl', 'ruby', 'node']);
const DB_CLIENTS = new Set(['sqlite3', 'psql', 'mysql', 'mariadb', 'duckdb', 'clickhouse-client', 'mongosh', 'cqlsh']);

const RANK: Record<ActionKind, number> = { shell: 0, 'fs-read': 1, 'fs-write': 2, git: 3, network: 4 };

interface ShellResult { kind: ActionKind; paths: string[]; flags: Set<ActionFlag>; reasons: string[] }

function add(r: ShellResult, flag: ActionFlag, reason: string) {
  r.flags.add(flag);
  if (!r.reasons.includes(reason)) r.reasons.push(reason);
}
function bump(r: ShellResult, kind: ActionKind) {
  if (RANK[kind] > RANK[r.kind]) r.kind = kind;
}
function addPath(r: ShellResult, p: string) {
  if (p && !r.paths.includes(p) && r.paths.length < MAX_PATHS) r.paths.push(p);
}

const SQL_DESTRUCTIVE: Array<[RegExp, string]> = [
  [/\bDROP\s+(?:TABLE|DATABASE|SCHEMA)\b/i, 'SQL DROP'],
  [/\bTRUNCATE\s+(?:TABLE\s+)?[A-Za-z_"`]/i, 'SQL TRUNCATE'],
  [/\bDELETE\s+FROM\s+[\w."`]+\s*(?:;|$|["'])/im, 'SQL DELETE without WHERE'],
];

function gitRules(args: string[], r: ShellResult) {
  // Skip git's own options: -C <dir>, -c <k=v>, --git-dir=…
  let i = 0;
  while (i < args.length && isOpt(args[i])) {
    if ((args[i] === '-C' || args[i] === '-c') && i + 1 < args.length) {
      if (args[i] === '-C') addPath(r, args[i + 1]);
      i += 2;
    } else i++;
  }
  const sub = args[i] ?? '';
  const rest = args.slice(i + 1);
  const opts = shortOpts(rest);
  const has = (...names: string[]) => rest.some((a) => names.includes(a));
  const pathspec = rest.filter((a) => !isOpt(a));
  switch (sub) {
    case 'reset':
      if (has('--hard')) add(r, 'destructive', 'git reset --hard discards uncommitted work');
      break;
    case 'clean':
      if ((opts.includes('f') || has('--force')) && !opts.includes('n') && !has('--dry-run')) {
        add(r, 'destructive', 'git clean -f deletes untracked files');
      }
      break;
    case 'checkout':
      if (has('-f', '--force') || pathspec.includes('.')) {
        add(r, 'destructive', 'git checkout . discards working tree changes');
      }
      break;
    case 'restore':
      if ((pathspec.includes('.') || pathspec.includes(':/')) && !(has('--staged', '-S') && !has('--worktree', '-W'))) {
        add(r, 'destructive', 'git restore . discards working tree changes');
      }
      break;
    case 'branch':
      if (opts.includes('D') || (has('--delete', '-d') && has('--force', '-f'))) add(r, 'destructive', 'git branch -D deletes an unmerged branch');
      break;
    case 'stash':
      if (rest[0] === 'drop' || rest[0] === 'clear') add(r, 'destructive', `git stash ${rest[0]} discards stashed work`);
      break;
    case 'filter-branch':
    case 'filter-repo':
      add(r, 'destructive', `git ${sub} rewrites history`);
      break;
    case 'reflog':
      if (rest[0] === 'expire' && rest.some((a) => /^--expire(?:-unreachable)?=now$/.test(a))) add(r, 'destructive', 'git reflog expire --expire=now drops recovery points');
      break;
    case 'push': {
      const lease = rest.some((a) => a.startsWith('--force-with-lease') || a === '--force-if-includes');
      const force = has('--force', '-f') || /f/.test(opts) || pathspec.slice(1).some((a) => a.startsWith('+'));
      if (force) add(r, 'force-push', 'git push --force overwrites the remote branch');
      else if (lease) add(r, 'force-with-lease', 'git push --force-with-lease overwrites the remote branch if unchanged');
      if (has('--delete', '-d') || pathspec.slice(1).some((a) => a.startsWith(':') && a.length > 1)) add(r, 'destructive', 'git push --delete removes a remote branch');
      if (has('--mirror')) add(r, 'destructive', 'git push --mirror overwrites every remote ref');
      break;
    }
  }
}

function analyzeStatement(piece: ShellPiece, next: ShellPiece | undefined, r: ShellResult, depth: number) {
  const { words, redirects, heredoc } = shellWords(piece.text);
  const { prog, args, sudo } = program(words);
  if (sudo) add(r, 'sudo', 'runs as root (sudo)');
  if (prog === 'su' && args.includes('-c')) add(r, 'sudo', 'runs as another user (su -c)');

  for (const red of redirects) {
    if (red.op === '<' || red.op === '<<<') { if (red.op === '<') { bump(r, 'fs-read'); addPath(r, red.target); } continue; }
    if (red.target === '/dev/null' || red.target.startsWith('&')) continue;
    bump(r, 'fs-write');
    addPath(r, red.target);
    const why = sensitiveWriteTarget(red.target);
    if (why && red.op !== '>>') add(r, 'destructive', `overwrites ${why}`);
  }

  if (heredoc || redirects.some((x) => x.op !== '<' && x.op !== '<<<' && x.target !== '/dev/null' && !x.target.startsWith('&'))) {
    const hits = findSecrets(heredoc ?? piece.text);
    if (hits.length) add(r, 'secrets-in-diff', `writes a credential (${[...new Set(hits.map((h) => h.kind))].join(', ')})`);
  }

  if (!prog) return;
  const operands = args.filter((a) => !isOpt(a));

  // A shell running a string: read the string.
  if (SHELLS.has(prog) && depth < 3) {
    const ci = args.findIndex((a) => /^-\w*c\w*$/.test(a));
    if (ci !== -1 && args[ci + 1]) analyzeShellInto(args[ci + 1], r, depth + 1);
  }

  if (prog === 'git') {
    bump(r, 'git');
    gitRules(args, r);
  } else if (NETWORK_PROGS.has(prog)) {
    bump(r, 'network');
    for (const a of operands) {
      if (/^[a-z][a-z0-9+.-]*:\/\//i.test(a)) addPath(r, a);
      else if (prog === 'scp' || prog === 'sftp') { if (/^[^/\s]+:/.test(a) || a.includes('@')) addPath(r, a); }
    }
    if (prog === 'ssh' || prog === 'mosh') {
      // Options that take a value: -i key, -p port, -o Opt=…, -J jump.
      const sshOperands: string[] = [];
      for (let k = 0; k < args.length; k++) {
        const a = args[k];
        if (sshOperands.length === 0 && isOpt(a)) { if (/^-[bcDEeFIiJLlmOopQRSWw]$/.test(a)) k++; continue; }
        sshOperands.push(a);
      }
      if (sshOperands[0]) addPath(r, sshOperands[0]);
      // The remote command still counts: `ssh box 'sudo rm -rf /var/lib/x'`.
      const remote = depth < 3 ? sshOperands.slice(1).join(' ') : '';
      if (remote) {
        const inner: ShellResult = { kind: 'shell', paths: [], flags: new Set(), reasons: [] };
        analyzeShellInto(remote, inner, depth + 1);
        for (const f of inner.flags) r.flags.add(f);
        for (const why of inner.reasons) if (!r.reasons.includes(why)) r.reasons.push(`on the remote host: ${why}`);
      }
    }
    // curl … | sh
    if ((prog === 'curl' || prog === 'wget') && piece.joiner === '|' && next) {
      const n = program(shellWords(next.text).words);
      if (INTERPRETERS.has(n.prog)) add(r, 'curl-pipe-shell', `pipes a download from ${prog} into ${n.prog}`);
    }
  } else if (prog === 'rsync') {
    const remote = operands.some((a) => /^[^/\s]+:/.test(a) || a.startsWith('rsync://'));
    bump(r, remote ? 'network' : 'fs-write');
    for (const a of operands) addPath(r, a);
    if (args.includes('--delete') && operands.length) {
      const why = dangerousDeleteTarget(operands[operands.length - 1]);
      if (why) add(r, 'destructive', `rsync --delete into ${why}`);
    }
  } else if (INSTALLERS[prog] && operands[0] && INSTALLERS[prog].has(operands[0])) {
    bump(r, 'network');
  } else if (prog === 'pacman' && args.some((a) => /^-S/.test(a))) {
    bump(r, 'network');
  } else if (FS_WRITE_PROGS.has(prog) || /^mkfs(\.|$)/.test(prog)) {
    bump(r, 'fs-write');
    for (const a of operands) addPath(r, a);
    writeRules(prog, args, operands, r);
  } else if ((prog === 'sed' || prog === 'perl') && args.some((a) => /^-[^-]*i/.test(a) || a.startsWith('--in-place'))) {
    bump(r, 'fs-write');
    for (const a of operands.slice(1)) addPath(r, a);
  } else if (prog === 'tar' && args.some((a) => /^-?[A-Za-z]*[xc]/.test(a))) {
    bump(r, 'fs-write');
    for (const a of operands) if (a.includes('/') || a.includes('.')) addPath(r, a);
  } else if (FS_READ_PROGS.has(prog)) {
    bump(r, 'fs-read');
    const files = PATTERN_FIRST.has(prog) && !args.some((a) => a === '-e' || a === '-f') ? operands.slice(1) : operands;
    if (prog === 'find') {
      const roots: string[] = [];
      for (const a of args) { if (a.startsWith('-') || a === '(' || a === '!') break; roots.push(a); }
      for (const a of roots) addPath(r, a);
      const deletes = args.includes('-delete') || args.some((a, k) => a === '-exec' && (args[k + 1] === 'rm' || args[k + 1] === 'shred'));
      if (deletes) {
        bump(r, 'fs-write');
        // `find . -name '*.pyc' -delete` is housekeeping: a find under the
        // working directory is already filtered, unlike `rm -rf .`.
        for (const root of roots) {
          if (/^\.\/?$/.test(root)) continue;
          const why = dangerousDeleteTarget(root);
          if (why) add(r, 'destructive', `find -delete under ${why}`);
        }
      }
    } else {
      for (const a of files) addPath(r, a);
    }
  } else if (prog === 'terraform' && operands[0] === 'destroy') {
    add(r, 'destructive', 'terraform destroy');
  } else if ((prog === 'docker' || prog === 'podman') && ((operands[0] === 'system' && operands[1] === 'prune') || (operands[0] === 'volume' && (operands[1] === 'rm' || operands[1] === 'prune')))) {
    add(r, 'destructive', `${prog} ${operands[0]} ${operands[1]} deletes stored data`);
  } else if (prog === 'kubectl' && operands[0] === 'delete' && /^(?:ns|namespace|namespaces|pv|pvc|all)$/.test(operands[1] ?? '')) {
    add(r, 'destructive', `kubectl delete ${operands[1]}`);
    bump(r, 'network');
  }

  if (DB_CLIENTS.has(prog)) {
    const sql = [piece.text, heredoc ?? ''].join('\n');
    for (const [re, why] of SQL_DESTRUCTIVE) if (re.test(sql)) add(r, 'destructive', why);
  }
}

function writeRules(prog: string, args: string[], operands: string[], r: ShellResult) {
  const opts = shortOpts(args);
  if (prog === 'rm') {
    if (args.includes('--no-preserve-root')) add(r, 'destructive', 'rm --no-preserve-root');
    const recursive = /[rR]/.test(opts) || args.includes('--recursive');
    if (!recursive) return;
    for (const t of operands) {
      const why = dangerousDeleteTarget(t);
      if (why) add(r, 'destructive', `rm -r of ${why}`);
    }
  } else if (prog === 'dd') {
    const of = args.find((a) => a.startsWith('of='));
    if (of && /^of=\/dev\/(?!null$)/.test(of)) add(r, 'destructive', `dd onto a device (${of.slice(3)})`);
  } else if (/^mkfs(\.|$)/.test(prog) || prog === 'wipefs') {
    add(r, 'destructive', `${prog} erases a filesystem`);
  } else if (prog === 'shred') {
    add(r, 'destructive', 'shred destroys file contents');
  } else if (prog === 'truncate') {
    const files = args.filter((a, k) => !isOpt(a) && !/^(?:-s|--size|-r|--reference)$/.test(args[k - 1] ?? ''));
    for (const t of files) if (!SCRATCH.test(t)) { add(r, 'destructive', `truncate empties ${t}`); break; }
  } else if (prog === 'chmod') {
    const recursive = /R/.test(opts) || args.includes('--recursive');
    const mode = operands[0] ?? '';
    const world = /^0?777$/.test(mode) || /(?:^|,)(?:a|o|ugo)\+[rwxX]*w/.test(mode);
    if (recursive && world) add(r, 'destructive', `chmod -R ${mode} makes a tree world-writable`);
    else if (world) for (const t of operands.slice(1)) { const why = dangerousDeleteTarget(t) ?? sensitiveWriteTarget(t); if (why) { add(r, 'destructive', `chmod ${mode} on ${why}`); break; } }
  } else if (prog === 'chown' || prog === 'chgrp') {
    if (!/R/.test(opts) && !args.includes('--recursive')) return;
    for (const t of operands.slice(1)) {
      const why = dangerousDeleteTarget(t);
      if (why) { add(r, 'destructive', `${prog} -R on ${why}`); break; }
    }
  } else if (prog === 'tee') {
    for (const t of operands) { const why = sensitiveWriteTarget(t); if (why && !args.includes('-a')) add(r, 'destructive', `overwrites ${why}`); }
  } else if (prog === 'mv' || prog === 'cp') {
    const dest = operands[operands.length - 1];
    const why = dest && operands.length > 1 ? sensitiveWriteTarget(dest) : null;
    if (why) add(r, 'destructive', `overwrites ${why}`);
  }
}

function naiveSplit(cmd: string): ShellPiece[] {
  const out: ShellPiece[] = [];
  const re = /(\|\||&&|\||;|\n)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(cmd)) !== null) {
    out.push({ text: cmd.slice(last, m.index), joiner: (m[1] === '\n' ? '' : m[1]) as ShellPiece['joiner'] });
    last = m.index + m[1].length;
  }
  out.push({ text: cmd.slice(last), joiner: '' });
  return out;
}

function analyzeShellInto(cmd: string, r: ShellResult, depth: number) {
  const pieces = (splitTopLevel(cmd) ?? naiveSplit(cmd)).filter((p) => p.text.trim());
  pieces.forEach((p, i) => analyzeStatement(p, pieces[i + 1], r, depth));
  // Substitutions the splitter keeps whole: bash <(curl …), sh -c "$(curl …)".
  if (/\b(?:ba|z|da|k)?sh\b[^\n|;&]*(?:<\(|\$\()\s*(?:curl|wget)\b/.test(cmd)) {
    add(r, 'curl-pipe-shell', 'runs a downloaded script in a shell');
  }
  if (/(?:\$\(|`|<\()\s*(?:curl|wget)\s/.test(cmd)) bump(r, 'network');
}

/** A shell command's kind, the paths it names, and its flags. */
export function classifyShell(command: string): { kind: ActionKind; paths: string[]; flags: ActionFlag[]; reasons: string[] } {
  const r: ShellResult = { kind: 'shell', paths: [], flags: new Set(), reasons: [] };
  analyzeShellInto(command, r, 0);
  const secrets = findSecrets(command);
  if (secrets.length && !r.flags.has('secrets-in-diff')) {
    add(r, 'secret-in-command', `carries a credential (${[...new Set(secrets.map((h) => h.kind))].join(', ')})`);
  }
  return { kind: r.kind, paths: r.paths.map(redactSecrets), flags: order(r.flags), reasons: r.reasons };
}

const order = (flags: Set<ActionFlag>): ActionFlag[] => ACTION_FLAGS.filter((f) => flags.has(f));

// ── Tool calls ───────────────────────────────────────────────────────────────

/** Text a file tool wrote: Write's content, Edit's new_string, a patch's added lines. */
function writtenText(input: Input): string {
  const parts: string[] = [];
  for (const k of ['content', 'new_string', 'newString', 'new_str', 'new_source', 'file_text', 'contents', 'code_edit', 'text']) {
    const s = str(input[k]);
    if (s) parts.push(s);
  }
  if (Array.isArray(input.edits)) {
    for (const e of input.edits) if (e && typeof e === 'object') {
      const s = str((e as Input).new_string) ?? str((e as Input).newString);
      if (s) parts.push(s);
    }
  }
  const patch = str(input.patch) ?? str(input.input) ?? str(input.raw);
  if (patch) parts.push(patch.split('\n').filter((l) => l.startsWith('+') && !l.startsWith('+++')).join('\n'));
  return parts.join('\n');
}

function filePaths(input: Input): string[] {
  const out: string[] = [];
  for (const k of ['file_path', 'filePath', 'absolute_path', 'notebook_path', 'path', 'target_file', 'filename', 'file', 'dir_path', 'directory']) {
    const s = str(input[k]);
    if (s) out.push(s);
  }
  for (const k of ['paths', 'files', 'file_paths']) {
    const v = input[k];
    if (Array.isArray(v)) for (const p of v) if (typeof p === 'string') out.push(p);
  }
  const patch = str(input.patch) ?? str(input.input) ?? str(input.raw);
  if (patch) for (const m of patch.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)) out.push(m[1].trim());
  return [...new Set(out)].slice(0, MAX_PATHS);
}

/**
 * Classify one tool call, or null when it touched none of filesystem, git
 * or network (a todo list, a subagent, a question to the person).
 */
export function classifyToolCall(toolName: string | null | undefined, rawInput: unknown): ClassifiedAction | null {
  if (!toolName) return null;
  const input = parseToolInput(rawInput);
  const key = norm(toolName);
  const done = (kind: ActionKind, paths: string[], command: string | null, flags: Set<ActionFlag>, reasons: string[]): ClassifiedAction => ({
    kind,
    paths: paths.map(redactSecrets).slice(0, MAX_PATHS),
    command: command === null ? null : redactSecrets(command).slice(0, MAX_COMMAND),
    flags: order(flags),
    reasons,
  });

  if (SHELL_TOOLS.has(key)) {
    const cmd = shellText(input);
    if (!cmd) return null;
    const s = classifyShell(cmd);
    const flags = new Set(s.flags);
    return done(s.kind, s.paths, cmd, flags, s.reasons);
  }

  if (NETWORK_TOOLS.has(key) || toolName.startsWith('mcp__')) {
    const url = firstStr(input, ['url', 'uri', 'href']);
    const query = firstStr(input, ['query', 'q', 'search', 'prompt']);
    const paths: string[] = [];
    if (url) paths.push(url);
    if (!url && query) for (const m of query.matchAll(/https?:\/\/[^\s"')]+/g)) paths.push(m[0]);
    const server = toolName.startsWith('mcp__') ? toolName.split('__')[1] : null;
    if (server) paths.push(`mcp:${server}`);
    return done('network', paths, url ?? query ?? (server ? toolName : null), new Set(), []);
  }

  if (WRITE_TOOLS.has(key)) {
    // str_replace_editor's `view` is a read.
    const sub = str(input.command);
    if ((key === 'strreplaceeditor' || key === 'strreplacebasededittool') && sub === 'view') {
      return done('fs-read', filePaths(input), null, new Set(), []);
    }
    const paths = filePaths(input);
    const flags = new Set<ActionFlag>();
    const reasons: string[] = [];
    const hits = findSecrets(writtenText(input));
    if (hits.length) {
      flags.add('secrets-in-diff');
      reasons.push(`writes a credential (${[...new Set(hits.map((h) => h.kind))].join(', ')})`);
    }
    if (key === 'write' || key === 'writefile' || key === 'createfile') {
      for (const p of paths) {
        const why = sensitiveWriteTarget(p);
        if (why) { flags.add('destructive'); reasons.push(`overwrites ${why}`); }
      }
    }
    return done('fs-write', paths, null, flags, reasons);
  }

  if (READ_TOOLS.has(key)) {
    const pattern = firstStr(input, ['pattern', 'query', 'regex', 'glob']);
    return done('fs-read', filePaths(input), pattern, new Set(), []);
  }

  return null;
}
