/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * The Permacomputer Node Score, and the economics behind it.
 *
 * Five hundred lines of pure arithmetic — geo regions, haversine distance,
 * egress grouping, and the seven-lattice score for memory, CPU vintage,
 * storage, efficiency, uptime, diversity and GPU — lived inside a
 * 2,800-line React page. Nothing could reach it without rendering that page,
 * so nothing tested it, and the file it sat in carried the highest change
 * risk in the repo.
 *
 * None of it touches React. It moves here so it can be read and checked on
 * its own, and so the page becomes what it claims to be: a view.
 *
 * Every cap and tier is a multiple of seven. That is deliberate — the score
 * is a hexagonal lattice, so 42 rather than 40 — and the tests hold it to
 * that, because a stray 40 would still look plausible.
 */

export interface NodeEcon {
  ispCostMonthly: number;       // default $110
  electricityCostKwh: number;   // $/kWh, default 0.12
  location: string;             // "us-east-1", "home-boston", "eu-west-1"
  provider: string;             // "home", "aws", "gcp", "azure", "hetzner", "ovh", "colo", etc.
  linkMbps: number;             // uplink speed
  lat: number;                  // latitude
  lon: number;                  // longitude
  notes: string;
}

export const HARDCODED_DEFAULTS: NodeEcon = {
  ispCostMonthly: 110,
  electricityCostKwh: 0.31,
  location: '',
  provider: 'home',
  linkMbps: 100,
  lat: 0,
  lon: 0,
  notes: '',
};

// Geo-region keys mapped to lat/lon bounding boxes for auto-matching
export const GEO_REGION_BOUNDS: { key: string; latMin: number; latMax: number; lonMin: number; lonMax: number }[] = [
  { key: 'us-east', latMin: 24, latMax: 50, lonMin: -85, lonMax: -66 },
  { key: 'us-west', latMin: 30, latMax: 50, lonMin: -125, lonMax: -110 },
  { key: 'us-midwest', latMin: 36, latMax: 50, lonMin: -110, lonMax: -85 },
  { key: 'us-south', latMin: 24, latMax: 36, lonMin: -110, lonMax: -85 },
  { key: 'eu-west', latMin: 36, latMax: 60, lonMin: -10, lonMax: 3 },
  { key: 'eu-central', latMin: 45, latMax: 55, lonMin: 3, lonMax: 25 },
  { key: 'eu-north', latMin: 55, latMax: 72, lonMin: -10, lonMax: 30 },
  { key: 'ap-east', latMin: 30, latMax: 46, lonMin: 125, lonMax: 150 },
  { key: 'ap-south', latMin: 6, latMax: 36, lonMin: 68, lonMax: 98 },
  { key: 'ap-southeast', latMin: -10, latMax: 25, lonMin: 95, lonMax: 140 },
  { key: 'sa-east', latMin: -55, latMax: 15, lonMin: -82, lonMax: -34 },
  { key: 'oc', latMin: -48, latMax: -10, lonMin: 110, lonMax: 180 },
];

export function detectGeoRegion(lat: number, lon: number): string | null {
  for (const r of GEO_REGION_BOUNDS) {
    if (lat >= r.latMin && lat <= r.latMax && lon >= r.lonMin && lon <= r.lonMax) return r.key;
  }
  return null;
}

export function getDefaultEcon(settings: any): NodeEcon {
  return {
    ispCostMonthly: parseFloat(settings?.mesh_default_isp_cost) || HARDCODED_DEFAULTS.ispCostMonthly,
    electricityCostKwh: parseFloat(settings?.mesh_default_electricity_kwh) || HARDCODED_DEFAULTS.electricityCostKwh,
    location: '',
    provider: settings?.mesh_default_provider || HARDCODED_DEFAULTS.provider,
    linkMbps: parseFloat(settings?.mesh_default_link_mbps) || HARDCODED_DEFAULTS.linkMbps,
    lat: 0,
    lon: 0,
    notes: '',
  };
}

export function applyGeoRegionElectricity(econ: NodeEcon, settings: any): NodeEcon {
  if (!econ.lat && !econ.lon) return econ;
  const region = detectGeoRegion(econ.lat, econ.lon);
  if (!region) return econ;
  const regionRate = settings?.[`mesh_region_electricity_${region}`];
  if (!regionRate) return econ;
  return { ...econ, electricityCostKwh: parseFloat(regionRate) || econ.electricityCostKwh };
}

export const PROVIDERS = [
  { value: 'home', label: 'Home ISP' },
  { value: 'colo', label: 'Colocation' },
  { value: 'aws', label: 'AWS' },
  { value: 'gcp', label: 'Google Cloud' },
  { value: 'azure', label: 'Azure' },
  { value: 'hetzner', label: 'Hetzner' },
  { value: 'ovh', label: 'OVH' },
  { value: 'digitalocean', label: 'DigitalOcean' },
  { value: 'vultr', label: 'Vultr' },
  { value: 'linode', label: 'Linode/Akamai' },
  { value: 'oracle', label: 'Oracle Cloud' },
  { value: 'scaleway', label: 'Scaleway' },
  { value: 'unsandbox', label: 'unsandbox.com' },
  { value: 'other', label: 'Other' },
];

export const PRESET_LOCATIONS: { value: string; label: string; lat: number; lon: number }[] = [
  // AWS-style regions
  { value: 'us-east-1', label: 'US East (Virginia)', lat: 39.0, lon: -77.5 },
  { value: 'us-east-2', label: 'US East (Ohio)', lat: 40.4, lon: -82.9 },
  { value: 'us-west-1', label: 'US West (N. California)', lat: 37.4, lon: -121.9 },
  { value: 'us-west-2', label: 'US West (Oregon)', lat: 45.6, lon: -121.2 },
  { value: 'eu-west-1', label: 'EU West (Ireland)', lat: 53.3, lon: -6.3 },
  { value: 'eu-west-2', label: 'EU West (London)', lat: 51.5, lon: -0.1 },
  { value: 'eu-central-1', label: 'EU Central (Frankfurt)', lat: 50.1, lon: 8.7 },
  { value: 'ap-southeast-1', label: 'AP Southeast (Singapore)', lat: 1.3, lon: 103.9 },
  { value: 'ap-northeast-1', label: 'AP Northeast (Tokyo)', lat: 35.7, lon: 139.7 },
  { value: 'ap-south-1', label: 'AP South (Mumbai)', lat: 19.1, lon: 72.9 },
  { value: 'sa-east-1', label: 'SA East (Sao Paulo)', lat: -23.5, lon: -46.6 },
  // Common home locations
  { value: 'home-northeast-us', label: 'Home: NE US', lat: 42.4, lon: -71.1 },
  { value: 'home-southeast-us', label: 'Home: SE US', lat: 33.7, lon: -84.4 },
  { value: 'home-midwest-us', label: 'Home: Midwest US', lat: 41.9, lon: -87.6 },
  { value: 'home-southwest-us', label: 'Home: SW US', lat: 33.4, lon: -112.0 },
  { value: 'home-northwest-us', label: 'Home: NW US', lat: 47.6, lon: -122.3 },
  { value: 'home-uk', label: 'Home: UK', lat: 51.5, lon: -0.1 },
  { value: 'home-germany', label: 'Home: Germany', lat: 52.5, lon: 13.4 },
  { value: 'home-japan', label: 'Home: Japan', lat: 35.7, lon: 139.7 },
  { value: 'home-australia', label: 'Home: Australia', lat: -33.9, lon: 151.2 },
];

export function nodeEconKey(hostname: string): string {
  return `mesh_node_econ_${hostname.replace(/[^a-zA-Z0-9]/g, '_')}`;
}

export const EXCLUDED_HOSTS_KEY = 'mesh_excluded_hosts';

export function parseExcludedHosts(settings: any): Set<string> {
  const raw = settings?.[EXCLUDED_HOSTS_KEY];
  if (!raw) return new Set();
  try {
    const arr = JSON.parse(raw);
    return new Set(Array.isArray(arr) ? arr : []);
  } catch { return new Set(); }
}

export function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// Group nodes by egress IP to identify shared pipes
// Matching is fuzzy: mesh hostname "cammy" matches geoip "cammy.foxhop.net",
// and "localhost" matches the first mesh node.
export function computeEgressGroups(
  nodes: { hostname: string; sshHostname?: string }[],
  geoipNodes: any[],
  firstMeshHostname?: string,
): Map<string, string[]> {
  const groups = new Map<string, string[]>();
  for (const n of nodes) {
    const geo = geoipNodes.find((g: any) =>
      g.hostname === n.hostname ||
      g.hostname === n.sshHostname ||
      (n.sshHostname && g.hostname?.startsWith(n.hostname + '.')) ||
      (g.hostname === 'localhost' && n.hostname === firstMeshHostname)
    );
    const egressIp = geo?.ip ?? n.hostname; // fallback to hostname if no geoip
    const group = groups.get(egressIp) ?? [];
    group.push(n.hostname);
    groups.set(egressIp, group);
  }
  return groups;
}

// Get the effective ISP cost for a node, splitting among nodes that share the same egress IP
export function getEffectiveIspCost(hostname: string, ispCost: number, egressGroups: Map<string, string[]>): number {
  for (const [, group] of egressGroups) {
    if (group.includes(hostname) && group.length > 1) {
      return ispCost / group.length;
    }
  }
  return ispCost;
}

export const HOURS_PER_MONTH = 24 * 30;

// SQLite emits timestamps as "YYYY-MM-DD HH:MM" or "...:SS" in UTC with no tz marker.
// Parse as UTC and let the browser format in the user's local timezone.
export function utcToLocalIso(utcStr: string): Date {
  const iso = utcStr.replace(' ', 'T') + (utcStr.length <= 16 ? ':00Z' : 'Z');
  return new Date(iso);
}
export function fmtLocalHHMM(utcStr: string): string {
  return utcToLocalIso(utcStr).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
}
export function fmtLocalDateTime(utcStr: string): string {
  return utcToLocalIso(utcStr).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
}

// Total draw for a node = CPU/system watts + GPU watts (nvidia-smi power.draw).
export function nodeTotalWatts(meshNode?: any): number {
  return (meshNode?.powerWatts ?? 0) + (meshNode?.gpuPowerWatts ?? 0);
}

// Monthly electricity cost for a node, folding in GPU draw.
export function nodeElecMonthly(econ: NodeEcon, meshNode?: any): number {
  const kwhMonth = (nodeTotalWatts(meshNode) * HOURS_PER_MONTH) / 1000;
  return kwhMonth * econ.electricityCostKwh;
}

// ============================================================
// Permacomputer Node Score (PNS)
// Formalization of the timehexon.com/permacomputer scoring doctrine.
// Full write-up: docs/architecture/node-score.md
// ============================================================

export const CURRENT_YEAR = new Date().getUTCFullYear();
// Hexagonal harmonics — every cap & tier lands on a multiple of 7.
export const CAP_WISDOM = 42;      // 7×6
export const CAP_STORAGE = 42;     // 7×6
export const CAP_EFFICIENCY = 42;  // 7×6 — soft asymptote; raw exposed on the card
export const CAP_DISTANCE = 42;    // 7×6
export const CAP_DIVERSITY = 21;   // 7×3
export const CAP_UPTIME = 21;      // 7×3
export const CAP_GPU = 49;         // 7×7 — VRAM (0-21) + compute class (0-28)
export const SAME_LOCATION_KM_PAYOUT = 49; // 7²

// Memory tier — doctrine says 128G and 256G are qualitative jumps (local ML inference,
// fleet-wide services). Tiers on the 7-lattice: 7 → 14 → 21 → 49 (boost) → 77 (huge boost).
export function memoryScore(memTotalGB: number): number {
  if (memTotalGB >= 256) return 77; // 7×11
  if (memTotalGB >= 128) return 49; // 7×7
  if (memTotalGB >= 64) return 21;  // 7×3
  if (memTotalGB >= 32) return 14;  // 7×2
  return 7;                          // 7×1
}

// Wisdom — older silicon scores higher. Log curve so a 15-year Sandy Bridge doesn't
// infinitely out-score a 10-year Ivy Bridge. Cap 42. Unknown CPU → 0 (extend table).
export function wisdomScore(cpuYear?: number): number {
  if (!cpuYear || cpuYear <= 0) return 0;
  const ageYears = Math.max(0, CURRENT_YEAR - cpuYear);
  return Math.min(CAP_WISDOM, Math.round(Math.log2(1 + ageYears) * 10));
}

// Storage — Pass 1 uses disk counts as a rough proxy (spinning + SSD). Log scale
// so 100TB isn't 10x more useful than 10TB. Byte-accurate lsblk lands in Pass 3.
// Cap 42.
export function storageScore(spinningDisks: number, ssdCount: number): number {
  const disks = (spinningDisks ?? 0) + (ssdCount ?? 0);
  if (disks === 0) return 0;
  return Math.min(CAP_STORAGE, Math.round(Math.log10(disks + 1) * 28));
}

// Efficiency — hard cap 42 (fox's call). Raw exposed alongside for observability.
// Removing the cap later = one-line change. `200 / (w/c + 2)` gives ~40 at 3W/core,
// ~28 at 5W/core, ~16 at 10W/core, ~9 at 20W/core.
export function efficiencyScore(watts: number, cores: number): { capped: number; raw: number } {
  const wattsPerCore = watts > 0 && cores > 0 ? watts / cores : 20;
  const raw = Math.round(200 / (wattsPerCore + 2));
  return { capped: Math.min(CAP_EFFICIENCY, raw), raw };
}

// Uptime — sqrt curve so 1yr (18pts) isn't infinitely better than 6mo (13pts).
// Cap 21 because past ~49 days a machine has proven itself; more days don't prove more.
export function uptimeScore(uptimeSeconds?: number): number {
  if (!uptimeSeconds || uptimeSeconds <= 0) return 0;
  const days = uptimeSeconds / 86400;
  return Math.min(CAP_UPTIME, Math.round(Math.sqrt(days) * 3));
}

// Diversity — per-node version of the doctrine's "separate ISPs = gold" rule.
// +21 for each unique egress IP at same-location cluster; -7 for each shared pipe.
export function diversityScore(hostname: string, allConfigured: { hostname: string; econ: NodeEcon }[],
    thisEcon: NodeEcon, egressGroups: Map<string, string[]>, geoipNodes: any[]): number {
  let score = 0;
  const thisIp = [...egressGroups.entries()].find(([, hs]) => hs.includes(hostname))?.[0];
  if (!thisIp) return 0;
  for (const other of allConfigured) {
    if (other.hostname === hostname) continue;
    const dist = haversineKm(thisEcon.lat, thisEcon.lon, other.econ.lat, other.econ.lon);
    if (dist > SAME_LOCATION_KM_PAYOUT) continue;
    const otherIp = [...egressGroups.entries()].find(([, hs]) => hs.includes(other.hostname))?.[0];
    if (!otherIp) continue;
    if (otherIp !== thisIp) score += 21; // 7×3
    else score -= 7;                     // 7×1
  }
  // Silence geoipNodes-unused warning; kept in signature for future use.
  void geoipNodes;
  return Math.max(-CAP_DIVERSITY, Math.min(CAP_DIVERSITY, score));
}

// GPU class — CUDA generation + tensor / RT / neural cores by architecture.
// Model-name lookup: nvidia-smi doesn't report cores directly, so we key on gpuModel.
// Tiers on the 7-lattice: 7 (no tensor), 14 (1st-gen tensor), 21 (2nd-gen), 28 (3rd-gen+).
// Unknown GPU with valid gpuMemTotalMB gets 7 (present but architecture unknown).
export function gpuComputeClass(gpuModel?: string): number {
  if (!gpuModel) return 0;
  const m = gpuModel;
  // Ada Lovelace / Hopper / Blackwell — 3rd-gen+ tensor, 3rd-gen RT
  if (/RTX ?40|RTX ?50|H100|H200|B100|B200|L40|L4\b|GH200/i.test(m)) return 28;
  // Ampere — 2nd-gen tensor, 2nd-gen RT
  if (/RTX ?30|RTX ?A\d|A100|A40|A30|A10\b/i.test(m)) return 21;
  // Turing — 1st-gen tensor, 1st-gen RT
  if (/RTX ?20|GTX ?16|Tesla ?T4|Quadro RTX|T4\b/i.test(m)) return 14;
  // Volta — 1st-gen tensor, no RT
  if (/V100|Titan V/i.test(m)) return 14;
  // Pascal / Maxwell / Kepler — no tensor cores (cammy's Tesla P40 lands here)
  if (/GTX ?10|Tesla ?P|Tesla ?K|Tesla ?M|GTX ?9|Titan X\b|Titan Xp|Quadro P|Quadro M|Quadro K/i.test(m)) return 7;
  // Apple Silicon — Neural Engine as tensor equivalent
  if (/Apple M[234]/.test(m)) return 21;
  if (/Apple M1/.test(m)) return 14;
  // AMD ROCm datacenter
  if (/MI[23]\d\d|MI3\d{2}X/i.test(m)) return 28;
  if (/MI[12]\d\d|MI2\d{2}X/i.test(m)) return 21;
  // AMD Radeon Pro / RX 7000
  if (/RX ?7\d{3}|Radeon Pro W7/i.test(m)) return 14;
  if (/RX ?6\d{3}|RX ?5\d{3}|Radeon Pro W6/i.test(m)) return 7;
  // Present but unknown architecture — still worth something
  return 7;
}

// GPU score — VRAM tier + compute class, capped 49.
export function gpuScore(gpuModel?: string, gpuMemTotalMB?: number): { total: number; vram: number; compute: number } {
  const vramGB = (gpuMemTotalMB ?? 0) / 1024;
  const vram = vramGB >= 24 ? 21
             : vramGB >= 16 ? 14
             : vramGB >= 8  ? 7
             : vramGB >= 4  ? 7
             : 0;
  const compute = gpuComputeClass(gpuModel);
  return { total: Math.min(CAP_GPU, vram + compute), vram, compute };
}

// Distance — sum of (peer_km × min_link_mbps / 1000) averaged over peers. Cap 42.
export function distanceScore(hostname: string, econ: NodeEcon,
    configured: { hostname: string; econ: NodeEcon }[]): number {
  const peers = configured.filter(n => n.hostname !== hostname);
  if (peers.length === 0) return 0;
  let sum = 0;
  for (const p of peers) {
    const d = haversineKm(econ.lat, econ.lon, p.econ.lat, p.econ.lon);
    const linkFactor = Math.min(econ.linkMbps, p.econ.linkMbps) / 1000;
    sum += d * linkFactor;
  }
  return Math.min(CAP_DISTANCE, Math.round(sum / peers.length));
}

// Payout gate — doctrine: 2 nodes max paid per location; 3rd+ is a donation.
// Same location = haversine < 50km AND same egress IP.
export function computePaidGates(configured: { hostname: string; econ: NodeEcon }[],
    egressGroups: Map<string, string[]>): Map<string, { paid: boolean; donation: boolean }> {
  const result = new Map<string, { paid: boolean; donation: boolean }>();
  // Group by (rough_location, egressIp)
  const buckets = new Map<string, string[]>();
  for (const n of configured) {
    const ip = [...egressGroups.entries()].find(([, hs]) => hs.includes(n.hostname))?.[0] ?? n.hostname;
    // Bucket key: quantized lat/lon to 0.5deg (~55km) + egress IP
    const key = `${Math.round(n.econ.lat * 2) / 2},${Math.round(n.econ.lon * 2) / 2}|${ip}`;
    const b = buckets.get(key) ?? [];
    b.push(n.hostname);
    buckets.set(key, b);
  }
  for (const [, hosts] of buckets) {
    hosts.forEach((h, i) => {
      result.set(h, { paid: i < 2, donation: i >= 2 });
    });
  }
  return result;
}

export interface NodeScoreDetail {
  hostname: string;
  score: number;
  paid: boolean;
  donation: boolean;
  components: {
    wisdom: number;
    storage: number;
    memory: number;
    efficiency: number;
    efficiencyRaw: number;
    gpu: number;
    gpuVram: number;
    gpuCompute: number;
    distance: number;
    diversity: number;
    uptime: number;
  };
  distanceScore: number;   // legacy alias (breakdown line)
  efficiencyScore: number; // legacy alias (breakdown line)
}

export function computeMeshScore(
  nodes: { hostname: string; sshHostname?: string; econ: NodeEcon; meshNode?: any }[],
  geoipNodes?: any[],
  firstMeshHostname?: string,
): {
  totalScore: number;
  totalMonthlyCost: number;
  totalIspCost: number;
  totalElecCost: number;
  totalWatts: number;
  totalGpuWatts: number;
  blendedKwhRate: number;
  avgDistance: number;
  geoDiversityBonus: number;
  ispDiversityBonus: number;
  pipeDiversityBonus: number;
  sameLocationPenalty: number;
  egressGroups: Map<string, string[]>;
  nodeScores: NodeScoreDetail[];
} {
  const configured = nodes.filter(n => n.econ.lat !== 0 || n.econ.lon !== 0);
  const egressGroups = computeEgressGroups(nodes, geoipNodes ?? [], firstMeshHostname);
  const emptyResult = { totalScore: 0, totalMonthlyCost: 0, totalIspCost: 0, totalElecCost: 0, totalWatts: 0, totalGpuWatts: 0, blendedKwhRate: 0, avgDistance: 0, geoDiversityBonus: 0, ispDiversityBonus: 0, pipeDiversityBonus: 0, sameLocationPenalty: 0, egressGroups, nodeScores: [] };
  if (configured.length === 0) return emptyResult;

  // Monthly cost — ISP (shared pipes split) plus electricity (CPU + GPU watts).
  const totalIspCost = nodes.reduce((s, n) =>
    s + getEffectiveIspCost(n.hostname, n.econ.ispCostMonthly, egressGroups), 0);
  const totalElecCost = nodes.reduce((s, n) => s + nodeElecMonthly(n.econ, n.meshNode), 0);
  const totalMonthlyCost = totalIspCost + totalElecCost;

  // Fleet power draw — CPU/system + GPU. Blended $/kWh is derived from real
  // per-node rates so any cost chart stays consistent with this headline.
  const totalWatts = nodes.reduce((s, n) => s + nodeTotalWatts(n.meshNode), 0);
  const totalGpuWatts = nodes.reduce((s, n) => s + (n.meshNode?.gpuPowerWatts ?? 0), 0);
  const energyKwhMonth = (totalWatts * HOURS_PER_MONTH) / 1000;
  const blendedKwhRate = energyKwhMonth > 0 ? totalElecCost / energyKwhMonth : 0;

  // Pairwise distances
  let totalDist = 0;
  let pairCount = 0;
  for (let i = 0; i < configured.length; i++) {
    for (let j = i + 1; j < configured.length; j++) {
      totalDist += haversineKm(configured[i].econ.lat, configured[i].econ.lon, configured[j].econ.lat, configured[j].econ.lon);
      pairCount++;
    }
  }
  const avgDistance = pairCount > 0 ? Math.round(totalDist / pairCount) : 0;

  // Geographic diversity: count distinct continents (rough)
  const continents = new Set(configured.map(n => {
    const { lat, lon } = n.econ;
    if (lat > 10 && lon < -30) return 'NA';
    if (lat < -10 && lon < -30) return 'SA';
    if (lat > 35 && lon > -30 && lon < 60) return 'EU';
    if (lat < 35 && lon > 20 && lon < 60) return 'AF';
    if (lon >= 60) return 'AS';
    if (lat < -10 && lon > 100) return 'OC';
    return 'OTHER';
  }));
  const geoDiversityBonus = Math.max(0, (continents.size - 1) * 20);

  // ISP/provider diversity
  const providers = new Set(nodes.map(n => n.econ.provider));
  const ispDiversityBonus = Math.max(0, (providers.size - 1) * 10);

  // Pipe diversity: same location but different egress IPs = different pipes = bonus
  // Same location = within 50km of each other
  let pipeDiversityBonus = 0;
  let sameLocationPenalty = 0;
  const SAME_LOCATION_KM = 50;
  for (let i = 0; i < configured.length; i++) {
    for (let j = i + 1; j < configured.length; j++) {
      const dist = haversineKm(configured[i].econ.lat, configured[i].econ.lon, configured[j].econ.lat, configured[j].econ.lon);
      if (dist < SAME_LOCATION_KM) {
        // Same location — check if different pipes
        const geoI = (geoipNodes ?? []).find((g: any) => g.hostname === configured[i].hostname);
        const geoJ = (geoipNodes ?? []).find((g: any) => g.hostname === configured[j].hostname);
        const ipI = geoI?.ip;
        const ipJ = geoJ?.ip;
        if (ipI && ipJ && ipI !== ipJ) {
          pipeDiversityBonus += 15; // different pipes at same location = resilience
        } else {
          sameLocationPenalty += 5; // same pipe, same location = redundancy risk
        }
      }
    }
  }

  // Per-node PNS — 7 components, each capped, decomposed for the UI.
  const paidGates = computePaidGates(configured, egressGroups);
  const nodeScores: NodeScoreDetail[] = configured.map(n => {
    const wisdom = wisdomScore(n.meshNode?.cpuYear);
    const storage = storageScore(n.meshNode?.spinningDisks ?? 0, n.meshNode?.ssdCount ?? 0);
    const memory = memoryScore(n.meshNode?.memTotalGB ?? 0);
    const watts = nodeTotalWatts(n.meshNode);
    const cores = n.meshNode?.cpuCores ?? 1;
    const eff = efficiencyScore(watts, cores);
    const gpu = gpuScore(n.meshNode?.gpuModel, n.meshNode?.gpuMemTotalMB);
    const distance = distanceScore(n.hostname, n.econ, configured);
    const diversity = diversityScore(n.hostname, configured, n.econ, egressGroups, geoipNodes ?? []);
    const uptime = uptimeScore(n.meshNode?.uptimeSeconds);
    const gate = paidGates.get(n.hostname) ?? { paid: true, donation: false };

    const score = wisdom + storage + memory + eff.capped + gpu.total + distance + diversity + uptime;
    return {
      hostname: n.hostname,
      score,
      paid: gate.paid,
      donation: gate.donation,
      components: {
        wisdom, storage, memory,
        efficiency: eff.capped,
        efficiencyRaw: eff.raw,
        gpu: gpu.total, gpuVram: gpu.vram, gpuCompute: gpu.compute,
        distance, diversity, uptime,
      },
      distanceScore: distance,
      efficiencyScore: eff.capped,
    };
  });

  const totalScore = nodeScores.reduce((s, n) => s + n.score, 0);

  return { totalScore, totalMonthlyCost, totalIspCost, totalElecCost, totalWatts, totalGpuWatts, blendedKwhRate, avgDistance, geoDiversityBonus, ispDiversityBonus, pipeDiversityBonus, sameLocationPenalty, egressGroups, nodeScores };
}

// ============================================================
// Main Page
