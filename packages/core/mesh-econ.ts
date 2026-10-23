/**
 * Where a node's economics live in settings, read by both the fleet page and
 * the monthly cost report. One definition, so a report cannot price a node
 * from a key the page never writes.
 */

/** Settings key holding one node's NodeEcon as JSON. */
export function nodeEconKey(hostname: string): string {
  return `mesh_node_econ_${hostname.replace(/[^a-zA-Z0-9]/g, '_')}`;
}

/** Settings key holding the JSON array of hosts hidden from every fleet view. */
export const EXCLUDED_HOSTS_KEY = 'mesh_excluded_hosts';

/** A connection's monthly bill when nobody has said what it costs. */
export const DEFAULT_ISP_COST_MONTHLY = 110;

export function parseExcludedHosts(settings: Record<string, unknown> | null | undefined): Set<string> {
  const raw = settings?.[EXCLUDED_HOSTS_KEY];
  if (typeof raw !== 'string' || !raw) return new Set();
  try {
    const arr = JSON.parse(raw);
    return new Set(Array.isArray(arr) ? arr : []);
  } catch { return new Set(); }
}
