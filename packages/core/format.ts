import { formatDistanceToNow, format, parseISO } from 'date-fns';

export function formatTokens(n: number): string {
  // Cache read alone runs into the billions on a coding-agent workload, and
  // "10188.0M" is a number nobody reads as ten billion. Carry the scale up.
  if (n >= 1_000_000_000_000) return `${(n / 1_000_000_000_000).toFixed(1)}T`;
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(1)}B`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

export function formatBytes(bytes: number): string {
  if (bytes >= 1_073_741_824) return `${(bytes / 1_073_741_824).toFixed(1)} GB`;
  if (bytes >= 1_048_576) return `${(bytes / 1_048_576).toFixed(1)} MB`;
  if (bytes >= 1_024) return `${(bytes / 1_024).toFixed(1)} KB`;
  return `${bytes} B`;
}

export function formatRelativeTime(iso: string): string {
  try {
    return formatDistanceToNow(parseISO(iso), { addSuffix: true });
  } catch {
    return iso;
  }
}

export function formatTimestamp(iso: string): string {
  try {
    return format(parseISO(iso), 'yyyy-MM-dd HH:mm:ss');
  } catch {
    return iso;
  }
}

export function formatDate(iso: string): string {
  try {
    return format(parseISO(iso), 'MMM d, yyyy');
  } catch {
    return iso;
  }
}

export function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const secs = seconds % 60;
  if (minutes < 60) return `${minutes}m ${secs}s`;
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  return `${hours}h ${mins}m`;
}

/**
 * Dollars, at the precision the amount deserves.
 *
 * Below a cent, two decimals would show every small figure as $0.00 — a
 * per-message cost is often four digits down. Absent reads as zero rather
 * than throwing: a missing field on an older payload should leave a dash on
 * the page, not a blank one.
 */
export function formatCost(usd: number | null | undefined): string {
  if (usd == null || !Number.isFinite(usd) || usd <= 0) return '$0.00';
  if (usd >= 0.01) return `$${usd.toFixed(2)}`;
  return `$${usd.toFixed(4)}`;
}

export function truncate(str: string, maxLen: number): string {
  if (str.length <= maxLen) return str;
  return str.slice(0, maxLen - 1) + '\u2026';
}

/**
 * Convert a git remote URL to a browsable web URL.
 * Supports GitHub, GitLab, and Gitea/Forgejo (e.g. git.unturf.com).
 */
export function gitRemoteToWebUrl(remoteUrl: string): string | null {
  // SSH with explicit port: ssh://git@host:port/path.git
  const sshUrlMatch = remoteUrl.match(/^ssh:\/\/git@([^:]+):\d+\/(.+?)(?:\.git)?$/);
  if (sshUrlMatch) {
    return `https://${sshUrlMatch[1]}/${sshUrlMatch[2]}`;
  }
  // SSH shorthand: git@host:owner/repo.git or git@host:owner/repo
  const sshMatch = remoteUrl.match(/^git@([^:]+):(.+?)(?:\.git)?$/);
  if (sshMatch) {
    return `https://${sshMatch[1]}/${sshMatch[2]}`;
  }
  // HTTPS: https://host/owner/repo.git or https://host/owner/repo
  const httpsMatch = remoteUrl.match(/^https?:\/\/([^/]+)\/(.+?)(?:\.git)?$/);
  if (httpsMatch) {
    return `https://${httpsMatch[1]}/${httpsMatch[2]}`;
  }
  return null;
}

/**
 * Build a commit URL for a given remote URL and commit hash.
 * GitLab uses /-/commit/, GitHub and Gitea use /commit/.
 */
export function commitUrl(remoteUrl: string, hash: string): string | null {
  const baseUrl = gitRemoteToWebUrl(remoteUrl);
  if (!baseUrl) return null;
  if (baseUrl.includes('gitlab.com')) {
    return `${baseUrl}/-/commit/${hash}`;
  }
  return `${baseUrl}/commit/${hash}`;
}

export function extractUserText(entry: { message: { content: unknown } }): string {
  const { content } = entry.message;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter((b: { type: string }) => b.type === 'text')
      .map((b: { text: string }) => b.text)
      .join('\n');
  }
  return '';
}
