/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * Reading a machine from the text it printed.
 *
 * A single SSH call gathers hostname, cores, cpuinfo, lsblk, meminfo,
 * loadavg, uptime, harness processes, RAPL energy counters and nvidia-smi,
 * separated by markers. Turning that back into numbers was 137 lines inside
 * an execFile callback: unreachable without an SSH connection to a real
 * host, and therefore never tested, while every power figure and node score
 * on the Permacomputer page is computed from what it returns.
 *
 * It is a string in and an object out. It belongs here.
 */

import { parseHarnessProcesses, countByHarness } from '@unturf/unfirehose/harness-procs';

export interface MeshNode {
  hostname: string;
  reachable: boolean;
  cpuCores?: number;
  memTotalGB?: number;
  memCapGB?: number;
  memUsedGB?: number;
  memAvailableGB?: number;
  loadAvg?: [number, number, number];
  uptime?: string;
  uptimeSeconds?: number;
  cpuYear?: number;
  claudeProcesses?: number;
  harnessCounts?: Record<string, number>;
  swapUsedGB?: number;
  swapTotalGB?: number;
  cpuModel?: string;
  cpuTdpWatts?: number;
  spinningDisks?: number;
  ssdCount?: number;
  powerWatts?: number;
  gpuPowerWatts?: number;
  gpuModel?: string;
  gpuMemTotalMB?: number;
  gpuMemUsedMB?: number;
  gpuUtil?: number;
  arch?: string;
  powerSource?: 'rapl' | 'nvidia' | 'tdp';
  error?: string;
}

// Deduplicate nodes that resolve to the same host
export function deduplicateNodes(nodes: MeshNode[]): MeshNode[] {
  const seen = new Map<string, MeshNode>();
  for (const node of nodes) {
    if (!node.reachable) {
      // Only add unreachable if we don't already have a reachable version
      if (!seen.has(node.hostname)) seen.set(node.hostname, node);
    } else {
      // Reachable always wins
      seen.set(node.hostname, node);
    }
  }
  return [...seen.values()];
}

/**
 * TDP lookup table — maps CPU model substrings to TDP in watts.
 * Checked against Intel ARK / AMD product specs.
 */
// Ordered most-specific first. First match wins.
const CPU_TDP_TABLE: [RegExp, number][] = [
  // ──────────────────────────────────────────────────────────
  // Intel Core Ultra (Meteor Lake / Arrow Lake / Lunar Lake)
  // ──────────────────────────────────────────────────────────
  [/Core\s*Ultra\s*[579]\s+\d{3}H/i, 45],
  [/Core\s*Ultra\s*[579]\s+\d{3}U/i, 15],
  [/Core\s*Ultra\s*[579]\s+2\d{2}[HVUSK]/i, 45],  // Arrow Lake mobile
  [/Core\s*Ultra\s*[579]/i, 28],                    // fallback Ultra

  // ──────────────────────────────────────────────────────────
  // Intel mobile — Y / U / G / P / H / HK / HX suffixes
  // ──────────────────────────────────────────────────────────
  // Y-series (fanless ultrabook, 4.5-9W)
  [/i[357]-\d{4,5}Y/i, 9],
  // U-series (ultrabook, 15W)
  [/i[3579]-\d{4,5}U/i, 15],
  [/i[3579]-\d{4,5}G[1-7]/i, 15],   // Ice Lake G-series
  // P-series (performance ultrabook, 28W) — 12th+ gen
  [/i[3579]-\d{4,5}P/i, 28],
  // H-series (mobile performance, 45W)
  [/i[3579]-\d{4,5}H\b/i, 45],
  [/i[3579]-\d{4,5}HK/i, 45],
  // HX-series (mobile extreme, 55W)
  [/i[79]-\d{4,5}HX/i, 55],

  // ──────────────────────────────────────────────────────────
  // Intel desktop — T / F / K / KF / KS / S suffixes
  // ──────────────────────────────────────────────────────────
  // T-series (low power desktop, 35W)
  [/i[3579]-\d{4,5}T/i, 35],
  // KS-series (special edition, 150W) — 12th+ gen
  [/i9-\d{4,5}KS/i, 150],
  // K/KF-series desktop
  [/i9-\d{4,5}K[F]?\b/i, 125],
  [/i7-\d{4,5}K[F]?\b/i, 125],
  [/i5-\d{4,5}K[F]?\b/i, 91],
  // F-series (no iGPU, same TDP as standard)
  [/i[3579]-\d{4,5}F\b/i, 65],
  // S-series (special, 65W) — 14th gen
  [/i[3579]-\d{4,5}S\b/i, 65],
  // Standard desktop (no suffix) — i3/i5: 65W, i7: 65W, i9: 65W base
  [/i[3579]-\d{4,5}\b/i, 65],

  // ──────────────────────────────────────────────────────────
  // Intel Xeon Scalable (1st-4th gen)
  // ──────────────────────────────────────────────────────────
  [/Xeon.*Platinum\s*8[45]\d{2}/i, 350],  // 4th gen Platinum (Sapphire Rapids)
  [/Xeon.*Platinum\s*83\d{2}/i, 270],     // 3rd gen Platinum (Ice Lake)
  [/Xeon.*Platinum\s*82\d{2}/i, 205],     // 2nd gen Platinum (Cascade Lake)
  [/Xeon.*Platinum\s*81\d{2}/i, 205],     // 1st gen Platinum (Skylake-SP)
  [/Xeon.*Platinum/i, 250],               // Platinum fallback
  [/Xeon.*Gold\s*6[45]\d{2}/i, 250],      // 4th gen Gold
  [/Xeon.*Gold\s*63\d{2}/i, 205],         // 3rd gen Gold
  [/Xeon.*Gold\s*6[12]\d{2}/i, 150],      // 1st/2nd gen Gold
  [/Xeon.*Gold\s*5[34]\d{2}/i, 165],      // 3rd/4th gen Gold 5000
  [/Xeon.*Gold\s*5[12]\d{2}/i, 85],       // 1st/2nd gen Gold 5000
  [/Xeon.*Gold/i, 150],                   // Gold fallback
  [/Xeon.*Silver\s*4[34]\d{2}/i, 150],    // 3rd/4th gen Silver
  [/Xeon.*Silver\s*4[12]\d{2}/i, 85],     // 1st/2nd gen Silver
  [/Xeon.*Silver/i, 100],                 // Silver fallback
  [/Xeon.*Bronze/i, 80],

  // ──────────────────────────────────────────────────────────
  // Intel Xeon W (workstation)
  // ──────────────────────────────────────────────────────────
  [/Xeon.*W-[23][123]\d{2}/i, 165],       // W-2300/W-3300 (Ice Lake)
  [/Xeon.*W-[23][12]\d{2}/i, 140],        // W-2100/W-2200/W-3200
  [/Xeon.*w[579]-\d{4}/i, 125],           // Xeon w5/w7/w9 (Sapphire Rapids)
  [/Xeon.*W/i, 140],                      // W fallback

  // ──────────────────────────────────────────────────────────
  // Intel Xeon E5 (v1/v2/v3/v4) — Sandy Bridge to Broadwell
  // ──────────────────────────────────────────────────────────
  [/Xeon.*E5-26[0-9]{2}\s*v4/i, 105],     // Broadwell-EP
  [/Xeon.*E5-26[0-9]{2}\s*v3/i, 120],     // Haswell-EP
  [/Xeon.*E5-26[0-9]{2}\s*v2/i, 95],      // Ivy Bridge-EP
  [/Xeon.*E5-26[0-9]{2}(\s+0|\s+@)/i, 115], // Sandy Bridge-EP (v1: "E5-2670 0" or "E5-2680 @")
  [/Xeon.*E5-46[0-9]{2}/i, 130],          // E5-4600 (4-socket)
  [/Xeon.*E5-24[0-9]{2}/i, 80],           // E5-2400 (lower-end)
  [/Xeon.*E5-16[0-9]{2}/i, 80],           // E5-1600 (uniprocessor)
  [/Xeon.*E5/i, 95],                      // E5 fallback

  // ──────────────────────────────────────────────────────────
  // Intel Xeon E3 / E / D
  // ──────────────────────────────────────────────────────────
  [/Xeon.*E3-12[0-9]{2}\s*v[2-6]/i, 80],
  [/Xeon.*E3-12[0-9]{2}/i, 80],
  [/Xeon.*E-2[1-4]\d{2}/i, 80],           // Xeon E-2100/2200/2300/2400
  [/Xeon.*D-[12]\d{3}/i, 65],             // Xeon D (embedded)

  // ──────────────────────────────────────────────────────────
  // Intel Xeon Phi
  // ──────────────────────────────────────────────────────────
  [/Xeon.*Phi/i, 215],

  // ──────────────────────────────────────────────────────────
  // Intel legacy / budget desktop
  // ──────────────────────────────────────────────────────────
  [/Core\s*2\s*Duo/i, 65],
  [/Core\s*2\s*Quad/i, 95],
  [/Core\s*2\s*Extreme/i, 130],
  [/Pentium.*G[0-9]{4}/i, 54],            // Pentium Gold desktop
  [/Pentium.*N[0-9]{4}/i, 6],             // Pentium mobile (Celeron-class)
  [/Pentium.*[0-9]{4}U/i, 15],            // Pentium mobile U
  [/Pentium/i, 54],                        // Pentium fallback
  [/Celeron.*N[0-9]{4}/i, 6],             // Celeron mobile
  [/Celeron.*J[0-9]{4}/i, 10],            // Celeron embedded
  [/Celeron.*G[0-9]{4}/i, 54],            // Celeron desktop
  [/Celeron/i, 15],                        // Celeron fallback
  [/Atom.*[CZE][0-9]{4}/i, 6],            // Atom embedded
  [/Atom.*x[0-9]/i, 4],                   // Atom mobile
  [/Atom/i, 8],                            // Atom fallback
  [/\bN[0-9]{3,4}\b/i, 6],                 // Intel N-series (N100, N200, N305, N5105 etc.)

  // ──────────────────────────────────────────────────────────
  // AMD Ryzen mobile — U / HS / H / HX suffixes
  // ──────────────────────────────────────────────────────────
  [/Ryzen\s*[3579]\s*\d{4}[CE]\b/i, 9],   // C/E ultra-low power
  [/Ryzen\s*[3579]\s+\d{4}U/i, 15],
  [/Ryzen\s*[3579]\s+\d{4}HS/i, 35],
  [/Ryzen\s*[79]\s+\d{4}HX/i, 55],
  [/Ryzen\s*[79]\s+\d{4}H\b/i, 45],
  [/Ryzen\s*[3579]\s+\d{4}H\b/i, 35],

  // ──────────────────────────────────────────────────────────
  // AMD Ryzen AI / Ryzen PRO mobile
  // ──────────────────────────────────────────────────────────
  [/Ryzen\s*AI\s*9\s*HX/i, 55],
  [/Ryzen\s*AI\s*[579]/i, 28],
  [/Ryzen.*PRO\s*\d{4}U/i, 15],
  [/Ryzen.*PRO\s*\d{4}H/i, 45],

  // ──────────────────────────────────────────────────────────
  // AMD Ryzen desktop — standard / X / X3D / G (APU)
  // ──────────────────────────────────────────────────────────
  [/Ryzen\s+9\s+\d{4}X3D/i, 120],
  [/Ryzen\s+7\s+\d{4}X3D/i, 120],
  [/Ryzen\s+9\s+\d{4}X\b/i, 170],         // Ryzen 9 X (e.g. 9950X = 170W)
  [/Ryzen\s+9\s+[0-9]{4}\b/i, 105],       // Ryzen 9 standard
  [/Ryzen\s+7\s+\d{4}X\b/i, 105],
  [/Ryzen\s+7\s+[0-9]{4}\b/i, 65],
  [/Ryzen\s+5\s+\d{4}X\b/i, 105],
  [/Ryzen\s+5\s+[0-9]{4}\b/i, 65],
  [/Ryzen\s+3\s+[0-9]{4}\b/i, 65],
  [/Ryzen\s+[3579]\s+\d{4}G/i, 65],       // APUs (G suffix)

  // ──────────────────────────────────────────────────────────
  // AMD Ryzen Threadripper / Threadripper PRO
  // ──────────────────────────────────────────────────────────
  [/Threadripper\s*PRO\s*7\d{3}/i, 350],  // TR PRO 7000 (Storm Peak)
  [/Threadripper\s*PRO\s*5\d{3}/i, 280],  // TR PRO 5000 (Chagall)
  [/Threadripper\s*PRO\s*3\d{3}/i, 280],  // TR PRO 3000 (Castle Peak)
  [/Threadripper\s*3990/i, 280],           // TR 3990X
  [/Threadripper\s*3970/i, 280],           // TR 3970X
  [/Threadripper\s*3960/i, 280],           // TR 3960X
  [/Threadripper\s*29[0-9]{2}/i, 250],     // TR 2000 series
  [/Threadripper\s*19[0-9]{2}/i, 180],     // TR 1000 series
  [/Threadripper/i, 280],                  // TR fallback

  // ──────────────────────────────────────────────────────────
  // AMD EPYC
  // ──────────────────────────────────────────────────────────
  [/EPYC\s*9[0-9]{3}P/i, 200],            // 9004 single-socket P
  [/EPYC\s*9[67][0-9]{2}/i, 360],         // 9004 high-end
  [/EPYC\s*9[0-5][0-9]{2}/i, 200],        // 9004 standard
  [/EPYC\s*7[7-9][0-9]{2}/i, 225],        // 7003 high-end (Milan)
  [/EPYC\s*7[3-6][0-9]{2}/i, 155],        // 7003 mid (Milan)
  [/EPYC\s*7[0-2][0-9]{2}/i, 120],        // 7002 (Rome) / 7001 (Naples)
  [/EPYC/i, 180],                          // EPYC fallback

  // ──────────────────────────────────────────────────────────
  // AMD legacy
  // ──────────────────────────────────────────────────────────
  [/Athlon.*\d{4}U/i, 15],                // Athlon mobile
  [/Athlon.*\d{4}G/i, 35],                // Athlon APU
  [/Athlon/i, 65],                         // Athlon fallback
  [/FX-[89]\d{3}/i, 125],                 // FX-8xxx/9xxx
  [/FX-[46]\d{3}/i, 95],                  // FX-4xxx/6xxx
  [/Phenom/i, 95],
  [/Opteron/i, 115],
  [/A[46]-\d{4}/i, 65],                   // AMD A-series APU
  [/A[89]-\d{4}/i, 65],
  [/A10-\d{4}/i, 95],
  [/A12-\d{4}/i, 35],                     // A12 mobile

  // ──────────────────────────────────────────────────────────
  // ARM / Apple / Qualcomm / Ampere
  // ──────────────────────────────────────────────────────────
  [/Apple\s*M[12]\s*Pro/i, 30],
  [/Apple\s*M[12]\s*Max/i, 60],
  [/Apple\s*M[12]\s*Ultra/i, 120],
  [/Apple\s*M[1-4]/i, 20],
  [/Snapdragon.*X\s*Elite/i, 45],
  [/Snapdragon.*X\s*Plus/i, 23],
  [/Snapdragon.*8cx/i, 7],
  [/Ampere\s*Altra\s*Max/i, 250],
  [/Ampere\s*Altra/i, 210],
  [/Graviton\s*4/i, 210],                 // AWS Graviton4
  [/Graviton\s*3/i, 100],
  [/Graviton\s*2/i, 80],
  [/Neoverse.*V[12]/i, 120],
  [/Neoverse.*N[12]/i, 60],
  [/Neoverse/i, 60],
  [/Cortex-A7[2-9]/i, 5],
  [/Cortex-A5[0-9]/i, 3],
  [/BCM2[0-9]{3}/i, 5],                   // Raspberry Pi
  [/Tegra/i, 15],                          // NVIDIA Tegra/Jetson

  // ──────────────────────────────────────────────────────────
  // RISC-V / other
  // ──────────────────────────────────────────────────────────
  [/SiFive/i, 10],
  [/RISC-V/i, 5],
  [/MIPS/i, 5],
  [/Loongson/i, 35],
];

export function lookupCpuTdp(model: string): number | null {
  for (const [pattern, tdp] of CPU_TDP_TABLE) {
    if (pattern.test(model)) return tdp;
  }
  return null;
}

// CPU release year lookup. Doctrine: older silicon > newer (proven > theoretical).
// Table is ordered most-specific first so "Xeon E5-26" matches before generic "Xeon".
// Add entries as we encounter new CPUs; unmatched CPUs return null (age = 0 in scoring).
const CPU_YEAR_TABLE: [RegExp, number][] = [
  // Intel Xeon E5 v1 (Sandy Bridge-EP) — cammy, guile family
  [/Xeon.*E5-26\d{2}\b(?!\s*v)/i, 2012],
  [/Xeon.*E5-46\d{2}\b(?!\s*v)/i, 2012],
  [/Xeon.*E5-16\d{2}\b(?!\s*v)/i, 2012],
  [/Xeon.*E5-\d{4}\s*v2\b/i, 2013],
  [/Xeon.*E5-\d{4}\s*v3\b/i, 2014],
  [/Xeon.*E5-\d{4}\s*v4\b/i, 2016],
  // Intel Xeon Scalable
  [/Xeon.*(Platinum|Gold|Silver|Bronze)\s*8[12]\d{2}\b/i, 2017],
  [/Xeon.*(Platinum|Gold|Silver|Bronze)\s*[8]2\d{2}\b/i, 2019],
  [/Xeon.*(Platinum|Gold|Silver|Bronze)\s*[8]3\d{2}\b/i, 2021],
  [/Xeon.*(Platinum|Gold|Silver|Bronze)\s*[8]4\d{2}\b/i, 2023],
  // Intel Core desktop
  [/i[3579]-2\d{3}[A-Z]?\b/i, 2011],
  [/i[3579]-3\d{3}[A-Z]?\b/i, 2012],
  [/i[3579]-4\d{3}[A-Z]?\b/i, 2013],
  [/i[3579]-5\d{3}[A-Z]?\b/i, 2015],
  [/i[3579]-6\d{3}[A-Z]?\b/i, 2015],
  [/i[3579]-7\d{3}[A-Z]?\b/i, 2017],
  [/i[3579]-8\d{3}[A-Z]?\b/i, 2018],
  [/i[3579]-9\d{3}[A-Z]?\b/i, 2018],
  [/i[3579]-10\d{3}[A-Z]?\b/i, 2020],
  [/i[3579]-11\d{3}[A-Z]?\b/i, 2021],
  [/i[3579]-12\d{3}[A-Z]?\b/i, 2022],
  [/i[3579]-13\d{3}[A-Z]?\b/i, 2023],
  [/i[3579]-14\d{3}[A-Z]?\b/i, 2024],
  // AMD Ryzen
  [/Ryzen.*1\d{3}[A-Z]?\b/i, 2017],
  [/Ryzen.*2\d{3}[A-Z]?\b/i, 2018],
  [/Ryzen.*3\d{3}[A-Z]?\b/i, 2019],
  [/Ryzen.*5\d{3}[A-Z]?\b/i, 2020],
  [/Ryzen.*7\d{3}[A-Z]?\b/i, 2022],
  [/Ryzen.*9\d{3}[A-Z]?\b/i, 2024],
  // AMD EPYC
  [/EPYC.*7[12]\d{2}\b/i, 2017],
  [/EPYC.*7[34]\d{2}\b/i, 2019],
  [/EPYC.*7[56]\d{2}\b/i, 2022],
  [/EPYC.*9\d{3}\b/i, 2022],
  // Apple Silicon
  [/Apple M1\b/i, 2020],
  [/Apple M2\b/i, 2022],
  [/Apple M3\b/i, 2023],
  [/Apple M4\b/i, 2024],
  // Generic fallbacks — very rough, avoids null for old chips
  [/Xeon.*\bX5\d{3}\b/i, 2010],
  [/Xeon.*\bE5\d{3}\b/i, 2011],
];

export function lookupCpuYear(model: string): number | null {
  for (const [pattern, year] of CPU_YEAR_TABLE) {
    if (pattern.test(model)) return year;
  }
  return null;
}

/**
 * Read CPU model name from /proc/cpuinfo text.
 */
export function parseCpuModel(cpuinfoOrText: string): string | null {
  const match = cpuinfoOrText.match(/model name\s*:\s*(.+)/i);
  return match ? match[1].trim() : null;
}

/**
 * Count spinning disks (ROTA=1, not loop devices) from lsblk.
 */
export function countSpinningDisks(lsblkOutput: string): number {
  return lsblkOutput.split('\n').filter(l => {
    const parts = l.trim().split(/\s+/);
    return parts[1] === 'disk' && parts[parts.length - 1] === '1';
  }).length;
}

/**
 * Calculate total system power draw from components:
 * - CPU: TDP scaled by load (20% idle to 100% at full load)
 * - RAM: ~4W per DIMM (estimate 1 DIMM per 32GB for servers, per 8GB for desktops)
 * - Spinning disks: ~8W each
 * - SSDs/NVMe: ~3W each
 * - Motherboard + fans: ~25W server, ~5W laptop
 * - PSU efficiency loss: ~10% (servers/desktops only, laptops use DC adapter)
 */
export function calcSystemWatts(opts: {
  tdpWatts: number;
  cores: number;
  load1m: number;
  memTotalGB: number;
  spinningDisks: number;
  ssdCount: number;
  isServer: boolean;
  isLaptop: boolean;
}): number {
  const cpuIdle = 0.2;
  const utilization = Math.min(opts.load1m / opts.cores, 1.1);
  const cpuWatts = opts.tdpWatts * (cpuIdle + utilization * (1 - cpuIdle));

  // RAM: servers use larger DIMMs (~3W each), laptops use SODIMMs (~2W each)
  const dimmSize = opts.isServer ? 32 : 8;
  const wattsPerDimm = opts.isLaptop ? 2 : 3;
  const ramWatts = Math.ceil(opts.memTotalGB / dimmSize) * wattsPerDimm;
  const hddWatts = opts.spinningDisks * 8;
  const ssdWatts = opts.ssdCount * 3;
  const baselineWatts = opts.isLaptop ? 5 : (opts.isServer ? 25 : 15);

  const subtotal = cpuWatts + ramWatts + hddWatts + ssdWatts + baselineWatts;
  return round(opts.isLaptop ? subtotal : subtotal / 0.9);
}

/**
 * Calculate non-CPU system power: RAM, disks, baseline, PSU loss.
 * Used when RAPL provides CPU watts but we still need the rest.
 */
export function calcNonCpuWatts(opts: {
  memTotalGB: number; spinningDisks: number; ssdCount: number;
  isServer: boolean; isLaptop: boolean;
}): number {
  const dimmSize = opts.isServer ? 32 : 8;
  const wattsPerDimm = opts.isLaptop ? 2 : 3;
  const ramWatts = Math.ceil(opts.memTotalGB / dimmSize) * wattsPerDimm;
  const hddWatts = opts.spinningDisks * 8;
  const ssdWatts = opts.ssdCount * 3;
  const baselineWatts = opts.isLaptop ? 5 : (opts.isServer ? 25 : 15);
  const subtotal = ramWatts + hddWatts + ssdWatts + baselineWatts;
  return round(opts.isLaptop ? subtotal : subtotal / 0.9);
}

export function formatUptime(seconds: number): string {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${mins}m`;
  return `${mins}m`;
}

export function round(n: number): number {
  return Math.round(n * 10) / 10;
}

/**
 * Linux's /proc/meminfo reports the kernel's usable RAM, which is the DIMM
 * total minus reserved regions — typically ~1.5GB short on a server. Real
 * DIMM sizes are powers-of-2 (4 / 8 / 16 / 32 / 64 / 128 / 256GB), so
 * rounding up to the next power-of-2 recovers the actual hardware cap.
 *
 * The rounding is capped at 1.5x so a machine well below the next power of
 * two keeps its reported figure — 40GB stays 40 rather than becoming 64.
 * Note the bound is a ratio, not a list of known sizes: 94GB is within 1.36x
 * of 128 and so does round up, even though 96GB (64+32) is a real
 * configuration. Tightening that would need actual DIMM data from lsmem,
 * which the probe does not collect.
 */
export function memCapGB(memTotalGB: number): number {
  if (memTotalGB <= 0) return 0;
  let cap = 1;
  while (cap < memTotalGB) cap *= 2;
  return cap <= memTotalGB * 1.5 ? cap : Math.round(memTotalGB);
}

// ── Stale-while-revalidate cache ──────────────────────────────
let meshCache: { data: any; ts: number } | null = null;
let refreshing = false;
const MESH_CACHE_TTL = 15_000; // 15 seconds

/**
 * One node, parsed from the combined output of our probe script.
 *
 * `host` wins over the hostname the machine reports when it carries a
 * domain, because that is what our SSH config calls it and what everything
 * else keys on.
 */
export function parseRemoteProbe(host: string, stdout: string): MeshNode {
  const fullOutput = stdout.trim();
  const statsEnd = fullOutput.indexOf('---STATS_END---');
  const raplEnd = fullOutput.indexOf('---RAPL_END---');
  const gpuEnd = fullOutput.indexOf('---GPU_END---');

  const statsSection = fullOutput.slice(0, statsEnd).trim();
  const raplSection = fullOutput.slice(statsEnd + '---STATS_END---'.length, raplEnd).trim();
  const gpuSection = fullOutput.slice(raplEnd + '---RAPL_END---'.length, gpuEnd).trim();

  const lines = statsSection.split('\n');

  const remoteHostname = lines[0];
  const hostname = host.includes('.') ? host : (remoteHostname.includes('.') ? remoteHostname : host);
  const cpuCores = parseInt(lines[1]);
  const cpuModel = parseCpuModel(lines[2]);
  const arch = lines[3]?.trim() || undefined;

  const lsblkEndIdx = lines.findIndex(l => l.trim() === '---LSBLK_END---');
  let spinningDisks = 0;
  let ssdCount = 0;
  if (lsblkEndIdx > 4) {
    const lsblkText = lines.slice(4, lsblkEndIdx).join('\n');
    spinningDisks = countSpinningDisks(lsblkText);
    ssdCount = lsblkText.split('\n').filter(l => {
      const p = l.trim().split(/\s+/);
      return p[1] === 'disk' && p[p.length - 1] === '0';
    }).length;
  }

  const meminfoLines = lines.slice(lsblkEndIdx > 0 ? lsblkEndIdx + 1 : 3);
  const meminfoText = meminfoLines.join('\n');
  const memTotal = parseInt(meminfoText.match(/MemTotal:\s+(\d+)/)?.[1] ?? '0') / 1024 / 1024;
  const memAvailable = parseInt(meminfoText.match(/MemAvailable:\s+(\d+)/)?.[1] ?? '0') / 1024 / 1024;
  const swapTotal = parseInt(meminfoText.match(/SwapTotal:\s+(\d+)/)?.[1] ?? '0') / 1024 / 1024;
  const swapFree = parseInt(meminfoText.match(/SwapFree:\s+(\d+)/)?.[1] ?? '0') / 1024 / 1024;

  const loadLine = meminfoLines.find(l => /^\d+\.\d+\s+\d+\.\d+\s+\d+\.\d+/.test(l));
  const loadParts = loadLine?.split(/\s+/) ?? ['0', '0', '0'];
  const loadAvg: [number, number, number] = [parseFloat(loadParts[0]), parseFloat(loadParts[1]), parseFloat(loadParts[2])];

  const uptimeLine = meminfoLines.find(l => /^\d+\.\d+\s+\d+\.\d+$/.test(l.trim()));
  const uptimeSeconds = parseFloat(uptimeLine?.split(/\s/)[0] ?? '0');
  const uptime = formatUptime(uptimeSeconds);

  // Harness lines are prefixed HPROC so they survive being mixed into
  // the single combined stats payload alongside meminfo, loadavg etc.
  const remoteProcs = parseHarnessProcesses(
    lines.filter((l: string) => l.startsWith('HPROC ')).map((l: string) => l.slice(6)).join('\n'),
  );
  const harnessCounts = countByHarness(remoteProcs);
  const claudeProcesses = harnessCounts.claude ?? 0;

  // Power
  const cpuTdpWatts = cpuModel ? lookupCpuTdp(cpuModel) : null;
  const isServer = cpuModel ? /xeon|epyc/i.test(cpuModel) : false;
  const isLaptop = cpuModel ? /[0-9]U\b|[0-9]G[1-7]\b/i.test(cpuModel) : false;
  let powerWatts: number | undefined;
  let gpuPowerWatts: number | undefined;
  let powerSource: MeshNode['powerSource'] | undefined;

  // Parse RAPL
  if (raplSection) {
    const parts = raplSection.split(/\s+/).map(Number);
    if (parts.length >= 2 && !isNaN(parts[0]) && !isNaN(parts[2])) {
      let delta0 = parts[2] - parts[0];
      if (delta0 < 0) delta0 += 2 ** 32;
      let delta1 = 0;
      if (!isNaN(parts[1]) && !isNaN(parts[3])) {
        delta1 = parts[3] - parts[1];
        if (delta1 < 0) delta1 += 2 ** 32;
      }
      const cpuWatts = round((delta0 + delta1) / (0.1 * 1e6));
      if (cpuWatts > 0 && cpuWatts < 10000) {
        powerWatts = cpuWatts + calcNonCpuWatts({ memTotalGB: memTotal, spinningDisks, ssdCount, isServer, isLaptop });
        powerSource = 'rapl';
      }
    }
  }

  // Parse nvidia-smi
  let gpuModel: string | undefined;
  let gpuMemTotalMB: number | undefined;
  let gpuMemUsedMB: number | undefined;
  let gpuUtil: number | undefined;
  if (gpuSection) {
    let totalPower = 0;
    for (const line of gpuSection.split('\n')) {
      const parts = line.split(',').map(s => s.trim());
      const w = parseFloat(parts[0]);
      if (!isNaN(w)) totalPower += w;
      if (!gpuModel && parts[1]) gpuModel = parts[1];
      if (parts[2]) gpuMemTotalMB = (gpuMemTotalMB ?? 0) + (parseFloat(parts[2]) || 0);
      if (parts[3]) gpuMemUsedMB = (gpuMemUsedMB ?? 0) + (parseFloat(parts[3]) || 0);
      if (parts[4]) gpuUtil = Math.max(gpuUtil ?? 0, parseFloat(parts[4]) || 0);
    }
    if (totalPower > 0) gpuPowerWatts = round(totalPower);
  }

  // TDP fallback
  if (!powerWatts && cpuTdpWatts !== null) {
    powerWatts = calcSystemWatts({
      tdpWatts: cpuTdpWatts, cores: cpuCores, load1m: loadAvg[0],
      memTotalGB: memTotal, spinningDisks, ssdCount, isServer, isLaptop,
    });
    powerSource = 'tdp';
  }

  return {
    hostname, reachable: true,
    cpuModel: cpuModel ?? undefined, cpuTdpWatts: cpuTdpWatts ?? undefined,
    spinningDisks, ssdCount, cpuCores,
    memTotalGB: round(memTotal), memCapGB: memCapGB(memTotal), memUsedGB: round(memTotal - memAvailable), memAvailableGB: round(memAvailable),
    loadAvg, uptime, uptimeSeconds,
    cpuYear: cpuModel ? lookupCpuYear(cpuModel) ?? undefined : undefined,
    claudeProcesses,
    harnessCounts,
    swapTotalGB: round(swapTotal), swapUsedGB: round(swapTotal - swapFree),
    powerWatts, gpuPowerWatts: gpuPowerWatts ?? undefined,
    gpuModel, gpuMemTotalMB: gpuMemTotalMB ? Math.round(gpuMemTotalMB) : undefined,
    gpuMemUsedMB: gpuMemUsedMB ? Math.round(gpuMemUsedMB) : undefined,
    gpuUtil, arch, powerSource,
  };
}
