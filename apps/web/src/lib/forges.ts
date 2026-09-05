/**
 * The forges we can ask whether a repository is public.
 *
 * One row per forge: how to recognise its remote, and how to turn the
 * captured path into an API endpoint and a browsable URL. It was three
 * near-identical match-and-return blocks, which is three places to get the
 * `.git` suffix or the ssh-versus-https shape subtly different — and a
 * wrong API URL answers 404, which reads exactly like "this repo is
 * private" rather than like a defect.
 */
const FORGES = [
  {
    name: 'github',
    // ssh (git@github.com:owner/repo.git) and https alike.
    match: /github\.com[:/]([^/]+\/[^/]+?)(?:\.git)?$/,
    api: (path: string) => `https://api.github.com/repos/${path}`,
    web: (path: string) => `https://github.com/${path}`,
  },
  {
    name: 'gitlab',
    // Our own GitLab, which may carry a port: ssh://git@git.unturf.com:2222/group/repo.git
    match: /git\.unturf\.com(?::\d+)?\/(.+?)(?:\.git)?$/,
    // GitLab addresses a project by its URL-encoded full path, not by owner/repo.
    api: (path: string) => `https://git.unturf.com/api/v4/projects/${encodeURIComponent(path)}`,
    web: (path: string) => `https://git.unturf.com/${path}`,
  },
  {
    name: 'codeberg',
    match: /codeberg\.org[:/]([^/]+\/[^/]+?)(?:\.git)?$/,
    api: (path: string) => `https://codeberg.org/api/v1/repos/${path}`,
    web: (path: string) => `https://codeberg.org/${path}`,
  },
] as const;

/** Parse a remote URL into a forge API check. Returns null if unsupported. */
export function parseRemoteForCheck(url: string): { apiUrl: string; webUrl: string } | null {
  for (const forge of FORGES) {
    const m = url.match(forge.match);
    if (m) return { apiUrl: forge.api(m[1]), webUrl: forge.web(m[1]) };
  }
  return null;
}
