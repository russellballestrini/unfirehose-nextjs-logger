/**
 * One machine, several names.
 *
 * The mesh names a node by what it probed — the SSH alias when that has a
 * dot in it, else the remote's own hostname, sometimes `hostname -f` — and
 * a page links by an SSH entry's HostName, what we actually connect to.
 * ryu is the case that keeps biting: `Host ai-3060.foxhop.net` with
 * `HostName ryu.foxhop.net`. The sampler keys its rows by the alias, the
 * fleet page links by HostName, and compared literally the node page found
 * no node, no watts and no history.
 *
 * Pure string work, no fs: client pages import this.
 */

export interface SshNames {
  /** The `Host` alias. */
  name?: string;
  /** The `HostName` it connects to. */
  hostname?: string;
}

/**
 * The same box under two names: equal, or one is the other with a domain
 * after it — an alias and the fqdn the box reports, `hostname` against
 * `hostname -f`. Case-insensitive, as DNS is. An empty name matches nothing.
 */
export function sameBox(a: string | undefined | null, b: string | undefined | null): boolean {
  if (!a || !b) return false;
  const x = a.toLowerCase();
  const y = b.toLowerCase();
  return x === y || x.startsWith(y + '.') || y.startsWith(x + '.');
}

/** Whether an SSH config entry is the machine a mesh row names, by alias or by HostName. */
export function sshHostMatchesMesh(h: SshNames, meshHostname: string): boolean {
  return sameBox(h.name, meshHostname) || sameBox(h.hostname, meshHostname);
}

/**
 * The first of `items` whose names are this box, preferring a literal match
 * anywhere in the list over a fuzzy one earlier in it — `ai` must not claim
 * `ai.foxhop.net` when the list also holds `ai` itself.
 */
export function findSameBox<T>(items: readonly T[], target: string, namesOf: (item: T) => (string | undefined)[]): T | undefined {
  const t = target.toLowerCase();
  return items.find(i => namesOf(i).some(n => n?.toLowerCase() === t))
    ?? items.find(i => namesOf(i).some(n => sameBox(n, target)));
}

/** The SSH entry for a mesh hostname, literal matches first. */
export function sshHostForMesh<H extends SshNames>(hosts: readonly H[], meshHostname: string): H | undefined {
  if (!meshHostname) return undefined;
  return findSameBox(hosts, meshHostname, h => [h.name, h.hostname]);
}

/**
 * The mesh hostname a node page should read under, given the host in its
 * URL: the literal name when the mesh has it, else the mesh row of the SSH
 * entry that name belongs to, else what it was given.
 */
export function resolveMeshHostname(
  host: string,
  meshNodes: readonly { hostname: string }[] | undefined,
  sshHosts: readonly SshNames[] | undefined,
): string {
  if (!meshNodes?.length) return host;
  if (meshNodes.some(n => n.hostname === host)) return host;
  const ssh = sshHosts?.find(h => h.name === host || h.hostname === host);
  if (!ssh) return host;
  return findSameBox(meshNodes, ssh.name ?? '', n => [n.hostname])?.hostname
    ?? findSameBox(meshNodes, ssh.hostname ?? '', n => [n.hostname])?.hostname
    ?? host;
}
