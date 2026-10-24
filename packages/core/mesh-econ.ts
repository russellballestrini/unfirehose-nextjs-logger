/**
 * Where a node's economics live in settings, read by both the fleet page and
 * the monthly cost report. One definition, so a report cannot price a node
 * from a key the page never writes.
 */

import { getKwhRate } from './pricing';

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

/**
 * The $/kWh a node's energy is priced at: its saved economics, else the
 * fleet default from settings, else our one system-wide rate. The monthly
 * cost report and our energy attribution both read it here, so a node's
 * standing cost on the fleet page and its electricity line on a claim are
 * the same price.
 */
export function kwhRateForHost(settings: Record<string, string | undefined>, hostname: string): number {
  const raw = settings[nodeEconKey(hostname)];
  if (raw) {
    try {
      const v = Number((JSON.parse(raw) as { electricityCostKwh?: unknown }).electricityCostKwh);
      if (Number.isFinite(v) && v > 0) return v;
    } catch { /* a torn row prices at the default */ }
  }
  const fleet = parseFloat(settings.mesh_default_electricity_kwh ?? '');
  return Number.isFinite(fleet) && fleet > 0 ? fleet : getKwhRate();
}
