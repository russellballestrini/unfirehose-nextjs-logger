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

import { parseHarnessProcesses, countByHarness } from './harness-procs';
import { num, int } from './num';

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
  /** `uname -s` — Linux, FreeBSD, SunOS, Darwin, Windows_NT … */
  os?: string;
  osRelease?: string;
  /** Which userland plugin answered — see packages/core/userland. */
  userland?: string;
  /** The probe script was cut before END; fields after the cut are blank. */
  truncated?: boolean;
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
 *
 * Ordered most-specific first; first match wins. Tiered on purpose:
 *
 *   1. Mainstream families, where one generation-level pattern covers a
 *      sizable share of what people actually run: Intel Core / Xeon, AMD
 *      Ryzen / EPYC / Threadripper, Apple silicon, ARM servers, the
 *      popular SBCs, and the strings hypervisors show a guest.
 *   2. The long tail — Core 2, Netburst, FX, Opteron, POWER, the Chinese
 *      x86/MIPS/ARM vendors, RISC-V dev boards. Each is one line, and the
 *      second-life homelab market runs on exactly this silicon.
 *   3. Vendor fallbacks. A rough watt figure beats a $0 electricity bill:
 *      blanka's i5-3320M had no row, so its card priced power at nothing.
 *      Only a string with no recognisable vendor still returns null.
 *
 * Patterns run against the model string with `(R)` / `(TM)` removed —
 * real cpuinfo says `Core(TM) Ultra 7 155H` and `Core(TM)2 Duo`, which
 * `Core\s*Ultra` never matched.
 */
const CPU_TDP_TABLE: [RegExp, number][] = [
  // ══════════════════════════════════════════════════════════
  // TIER 1 — mainstream
  // ══════════════════════════════════════════════════════════

  // ──────────────────────────────────────────────────────────
  // Intel Core Ultra, series 2 (Arrow Lake / Lunar Lake, 2024–)
  // ──────────────────────────────────────────────────────────
  [/Core\s*Ultra\s*[579]\s+2\d{2}KS?\b/i, 125],   // 285K / 265K / 245K desktop unlocked
  [/Core\s*Ultra\s*[579]\s+2\d{2}T\b/i, 35],      // desktop low power
  [/Core\s*Ultra\s*[579]\s+2\d{2}F?\b/i, 65],     // desktop standard (225, 235, 265F)
  [/Core\s*Ultra\s*[579]\s+2\d{2}HX/i, 55],
  [/Core\s*Ultra\s*[579]\s+2\d{2}H\b/i, 45],
  [/Core\s*Ultra\s*[579]\s+2\d{2}V\b/i, 17],      // Lunar Lake
  [/Core\s*Ultra\s*[579]\s+2\d{2}U\b/i, 15],
  // Intel Core Ultra, series 1 (Meteor Lake, 2023)
  [/Core\s*Ultra\s*9\s+1\d{2}H/i, 45],
  [/Core\s*Ultra\s*[57]\s+1\d{2}H/i, 28],
  [/Core\s*Ultra\s*[579]\s+1\d{2}U/i, 15],
  [/Core\s*Ultra\s*[579]/i, 28],                  // fallback Ultra
  // Intel Core 3/5/7 (2024 rebrand of Raptor Lake mobile: "Core 7 150U")
  [/Core\s*[3579]\s+\d{3}HX/i, 55],
  [/Core\s*[3579]\s+\d{3}H\b/i, 45],
  [/Core\s*[3579]\s+\d{3}U\b/i, 15],

  // ──────────────────────────────────────────────────────────
  // Intel Core i3/i5/i7/i9 mobile — suffix carries the class
  // ──────────────────────────────────────────────────────────
  // Pre-Broadwell (Nehalem → Haswell). First generation used three digits
  // (i5-520M), so \d{3,5}.
  [/i7-\d{3,5}XM/i, 55],            // Extreme mobile (i7-2920XM, i7-3940XM)
  [/i7-\d{3,5}[MH]Q/i, 47],          // Haswell quad (i7-4700MQ, i7-4700HQ)
  [/i7-\d{3,5}Q[ME]/i, 45],          // Sandy/Ivy quad (i7-2670QM, i7-3612QE)
  [/i[357]-\d{3,5}LM/i, 25],         // low-voltage dual (i7-620LM)
  [/i[357]-\d{3,5}UM/i, 18],         // ultra-low-voltage dual (i5-520UM)
  [/i[357]-\d{3,5}M\b/i, 35],        // standard dual mobile (i5-3320M, i7-3520M)
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
  // Core M (Broadwell/Skylake/Kaby fanless: m3-7Y30, M-5Y70)
  [/\bm[357]-\dY\d{2}/i, 5],
  [/\bM-5Y\d{2}/i, 5],

  // ──────────────────────────────────────────────────────────
  // Intel Core desktop — T / F / K / KF / KS / S / X suffixes
  // ──────────────────────────────────────────────────────────
  // T-series (low power desktop, 35W)
  [/i[3579]-\d{4,5}T/i, 35],
  // X / XE HEDT (i7-5960X, i9-7980XE, i9-10980XE)
  [/i[79]-\d{4,5}XE?\b/i, 140],
  // KS-series (special edition, 150W) — 12th+ gen
  [/i9-\d{4,5}KS/i, 150],
  // K-series, 2nd–9th gen: 77–95W (i7-2600K 95, i7-4790K 88, i9-9900K 95)
  [/i[579]-[2-9]\d{3}K[F]?\b/i, 95],
  // K/KF-series desktop, 10th+ gen
  [/i9-\d{5}K[F]?\b/i, 125],
  [/i7-\d{5}K[F]?\b/i, 125],
  [/i5-\d{5}K[F]?\b/i, 125],
  // F-series (no iGPU, same TDP as standard)
  [/i[3579]-\d{4,5}F\b/i, 65],
  // S-series (special, 65W) — 14th gen
  [/i[3579]-\d{4,5}S\b/i, 65],
  // Standard desktop (no suffix) — i3/i5/i7/i9: 65W base
  [/i[3579]-\d{4,5}\b/i, 65],
  // Nehalem-era cpuinfo has no hyphen: "Core i7 CPU 920", "Core i5 CPU M 520"
  [/i[357]\s+CPU\s+M\s+\d{3}/i, 35],
  [/i[357]\s+CPU\s+L\s+\d{3}/i, 25],
  [/i[357]\s+CPU\s+U\s+\d{3}/i, 18],
  [/i7\s+CPU\s+X?\s*9\d{2}/i, 130],  // i7-920..990X (Bloomfield/Gulftown)
  [/i[357]\s+CPU\s+\d{3}/i, 95],      // Lynnfield/Clarkdale desktop

  // ──────────────────────────────────────────────────────────
  // Intel Xeon 6 (Granite Rapids P-cores / Sierra Forest E-cores, 2024–)
  // cpuinfo: "Intel(R) Xeon(R) 6980P"
  // ──────────────────────────────────────────────────────────
  [/Xeon\s*(6\s+)?6[89]\d{2}P\b/i, 500],
  [/Xeon\s*(6\s+)?6[5-7]\d{2}P\b/i, 350],
  [/Xeon\s*(6\s+)?67\d{2}E\b/i, 330],
  [/Xeon\s*(6\s+)?6\d{3}[PE]\b/i, 250],

  // ──────────────────────────────────────────────────────────
  // Intel Xeon Scalable (1st–5th gen) + Max
  // ──────────────────────────────────────────────────────────
  [/Xeon.*Max\s*94\d{2}/i, 350],          // Sapphire Rapids HBM
  [/Xeon.*Platinum\s*85\d{2}/i, 350],     // 5th gen Platinum (Emerald Rapids)
  [/Xeon.*Platinum\s*84\d{2}/i, 350],     // 4th gen Platinum (Sapphire Rapids)
  [/Xeon.*Platinum\s*83\d{2}/i, 270],     // 3rd gen Platinum (Ice Lake)
  [/Xeon.*Platinum\s*82\d{2}/i, 205],     // 2nd gen Platinum (Cascade Lake)
  [/Xeon.*Platinum\s*81\d{2}/i, 205],     // 1st gen Platinum (Skylake-SP)
  [/Xeon.*Platinum/i, 250],               // Platinum fallback
  [/Xeon.*Gold\s*6[45]\d{2}/i, 250],      // 4th/5th gen Gold
  [/Xeon.*Gold\s*63\d{2}/i, 205],         // 3rd gen Gold
  [/Xeon.*Gold\s*6[12]\d{2}/i, 150],      // 1st/2nd gen Gold
  [/Xeon.*Gold\s*5[345]\d{2}/i, 165],     // 3rd–5th gen Gold 5000
  [/Xeon.*Gold\s*5[12]\d{2}/i, 85],       // 1st/2nd gen Gold 5000
  [/Xeon.*Gold/i, 150],                   // Gold fallback
  [/Xeon.*Silver\s*4[345]\d{2}/i, 150],   // 3rd–5th gen Silver
  [/Xeon.*Silver\s*4[12]\d{2}/i, 85],     // 1st/2nd gen Silver
  [/Xeon.*Silver/i, 100],                 // Silver fallback
  [/Xeon.*Bronze\s*3[45]\d{2}/i, 125],
  [/Xeon.*Bronze/i, 80],

  // ──────────────────────────────────────────────────────────
  // Intel Xeon W (workstation)
  // ──────────────────────────────────────────────────────────
  [/Xeon.*w9-[23]\d{3}X?/i, 350],         // w9 Sapphire Rapids (w9-3495X)
  [/Xeon.*w7-[23]\d{3}X?/i, 270],
  [/Xeon.*w[35]-[23]\d{3}X?/i, 220],
  [/Xeon.*W-[23]3\d{2}/i, 165],           // W-2300/W-3300 (Ice Lake)
  [/Xeon.*W-[23][12]\d{2}/i, 140],        // W-2100/W-2200/W-3200
  [/Xeon.*W-1[123]\d{2}/i, 80],           // W-1200/W-1300 (Comet/Rocket Lake)
  [/Xeon.*W-1\d{4}/i, 45],                // W-10855M etc. (mobile workstation)
  [/Xeon.*W\b/i, 140],                    // W fallback

  // ──────────────────────────────────────────────────────────
  // Intel Xeon E7 (4/8-socket) and E5 (Sandy Bridge → Broadwell)
  // ──────────────────────────────────────────────────────────
  [/Xeon.*E7-[48]8\d{2}\s*v[2-4]/i, 165],
  [/Xeon.*E7-/i, 130],
  [/Xeon.*E5-26[0-9]{2}\s*v4/i, 105],     // Broadwell-EP
  [/Xeon.*E5-26[0-9]{2}\s*v3/i, 120],     // Haswell-EP
  [/Xeon.*E5-26[0-9]{2}\s*v2/i, 95],      // Ivy Bridge-EP
  [/Xeon.*E5-26[0-9]{2}(\s+0|\s+@)/i, 115], // Sandy Bridge-EP (v1: "E5-2670 0" or "E5-2680 @")
  [/Xeon.*E5-46[0-9]{2}/i, 130],          // E5-4600 (4-socket)
  [/Xeon.*E5-24[0-9]{2}/i, 80],           // E5-2400 (lower-end)
  [/Xeon.*E5-16[0-9]{2}\s*v[34]/i, 140],  // E5-1600 v3/v4 (uniprocessor, Haswell/Broadwell)
  [/Xeon.*E5-16[0-9]{2}/i, 80],           // E5-1600 (uniprocessor)
  [/Xeon.*E5-/i, 95],                     // E5 fallback (hyphenated — E5520 is a different family)

  // ──────────────────────────────────────────────────────────
  // Intel Xeon E3 / E / D
  // ──────────────────────────────────────────────────────────
  [/Xeon.*E3-12[0-9]{2}L/i, 25],          // E3-1200L low power
  [/Xeon.*E3-15[0-9]{2}M/i, 45],          // E3-1500M mobile workstation
  [/Xeon.*E3-12[0-9]{2}\s*v[2-6]/i, 80],
  [/Xeon.*E3-12[0-9]{2}/i, 80],
  [/Xeon.*E-2[1-4]\d{2}/i, 80],           // Xeon E-2100/2200/2300/2400
  [/Xeon.*D-2\d{3}/i, 90],                // Xeon D-2100/2700 (Skylake-D / Ice Lake-D)
  [/Xeon.*D-1\d{3}/i, 45],                // Xeon D-1500/1700 (embedded)
  [/Xeon.*D-/i, 65],

  // ──────────────────────────────────────────────────────────
  // Intel Xeon 5500/5600 (Nehalem/Westmere-EP) and older Core-2-era Xeons —
  // still the floor of the used-server market
  // ──────────────────────────────────────────────────────────
  [/Xeon.*\bX5[56]\d{2}\b/i, 95],         // X5650 95W, X5690 130W
  [/Xeon.*\bE5[56]\d{2}\b/i, 80],         // E5620 80W
  [/Xeon.*\bL5[56]\d{2}\b/i, 60],         // L5640 60W
  [/Xeon.*\bW5\d{3}\b/i, 130],            // W5580
  [/Xeon.*\bW3[56]\d{2}\b/i, 130],        // W3520 / W3680
  [/Xeon.*\bX3[45]\d{2}\b/i, 95],         // X3440 (Lynnfield)
  [/Xeon.*\b[XE]5[34]\d{2}\b/i, 95],      // Harpertown E5450 80W, X5460 120W
  [/Xeon.*\bL5[34]\d{2}\b/i, 50],
  [/Xeon.*\bE3[12]\d{2}\b/i, 65],         // E3110 (Wolfdale)
  [/Xeon.*\b[XE]7\d{3}\b/i, 130],         // Dunnington / Tigerton
  [/Xeon.*Phi/i, 215],
  [/Xeon/i, 100],                          // Xeon fallback

  // ──────────────────────────────────────────────────────────
  // Intel small cores — N-series, Atom, Celeron, Pentium
  // ──────────────────────────────────────────────────────────
  [/Atom.*P5\d{3}/i, 80],                 // Atom P5000 (Snow Ridge, network)
  [/Atom.*C3\d{3}/i, 25],                 // Atom C3000 (Denverton)
  [/Atom.*C2\d{3}/i, 20],                 // Atom C2000 (Rangeley/Avoton)
  [/Atom.*x[0-9]/i, 4],                   // Atom mobile (x5/x6/x7 — before embedded: "x5-Z8350")
  [/Atom.*[CZE][0-9]{4}/i, 6],            // Atom embedded
  [/Atom.*\b[DN][2-5]\d{2}\b/i, 10],      // Atom D525 / N270 / N450 (netbook, nettop)
  [/Atom/i, 8],                            // Atom fallback
  [/Pentium.*Silver/i, 10],
  [/Pentium.*Gold\s*G/i, 54],
  [/Pentium.*G[0-9]{4}/i, 54],            // Pentium desktop G-series
  [/Pentium.*[JN][0-9]{4}/i, 10],         // Pentium J/N (Gemini/Jasper Lake)
  [/Pentium.*[0-9]{4}U/i, 15],            // Pentium mobile U
  [/Pentium.*[0-9]{4}[YT]/i, 9],          // Pentium Y (fanless)
  [/Celeron.*N[0-9]{4}/i, 6],             // Celeron mobile
  [/Celeron.*J[0-9]{4}/i, 10],            // Celeron embedded
  [/Celeron.*G[0-9]{4}/i, 54],            // Celeron desktop
  [/Celeron.*[0-9]{4}U/i, 15],            // Celeron mobile U
  [/Celeron/i, 15],                        // Celeron fallback
  [/\bN[0-9]{3,4}\b/i, 6],                 // Intel N-series (N100, N200, N305, N5105 etc.)

  // ──────────────────────────────────────────────────────────
  // AMD Ryzen mobile — U / HS / H / HX suffixes, AI, Z, Embedded, PRO
  // ──────────────────────────────────────────────────────────
  [/Ryzen\s*AI\s*9\s*HX/i, 55],
  [/Ryzen\s*AI\s*(MAX|Max)/i, 55],        // Ryzen AI Max (Strix Halo)
  [/Ryzen\s*AI\s*[579]/i, 28],
  [/Ryzen\s*Z[12]/i, 15],                 // handheld (Z1 Extreme, Z2)
  [/Ryzen\s*Embedded\s*R/i, 15],          // R1000/R2000
  [/Ryzen\s*Embedded/i, 25],              // V1000/V2000/V3000
  [/Ryzen.*PRO\s*\d{4}[UC]\b/i, 15],
  [/Ryzen.*PRO\s*\d{4}HS/i, 35],
  [/Ryzen.*PRO\s*\d{4}H/i, 45],
  [/Ryzen.*PRO\s*\d{4}GE\b/i, 35],
  [/Ryzen.*PRO\s*\d{4}G\b/i, 65],
  [/Ryzen.*PRO\s*\d{4}X\b/i, 105],
  [/Ryzen.*PRO\s*\d{4}\b/i, 65],
  [/Ryzen\s*[3579]\s*\d{4}[CE]\b/i, 9],   // C/E ultra-low power
  [/Ryzen\s*[3579]\s+\d{4}U/i, 15],
  [/Ryzen\s*[3579]\s+\d{4}HS/i, 35],
  [/Ryzen\s*[79]\s+\d{4}HX/i, 55],
  [/Ryzen\s*[79]\s+\d{4}H\b/i, 45],
  [/Ryzen\s*[3579]\s+\d{4}H\b/i, 35],

  // ──────────────────────────────────────────────────────────
  // AMD Ryzen desktop — X3D / X / GE / G / standard, by generation
  // ──────────────────────────────────────────────────────────
  [/Ryzen\s+[579]\s+\d{4}X3D/i, 120],
  [/Ryzen\s+9\s+[79]9\d{2}X\b/i, 170],    // 7950X / 9950X / 7900X / 9900X = 170W
  [/Ryzen\s+9\s+\d{4}X\b/i, 105],         // 3950X / 5950X / 5900X = 105W
  [/Ryzen\s+7\s+\d{4}X\b/i, 105],
  [/Ryzen\s+5\s+[79]\d{3}X\b/i, 105],     // 7600X / 9600X = 105W
  [/Ryzen\s+5\s+\d{4}X\b/i, 65],          // 3600X 95W, 5600X 65W
  [/Ryzen\s+[3579]\s+\d{4}GE\b/i, 35],    // low-power APU
  [/Ryzen\s+[3579]\s+\d{4}G\b/i, 65],     // APUs (G suffix)
  [/Ryzen\s+[3579]\s+\d{4}\b/i, 65],      // non-X desktop: 7900, 5900, 3900 all 65W

  // ──────────────────────────────────────────────────────────
  // AMD Ryzen Threadripper / Threadripper PRO
  // ──────────────────────────────────────────────────────────
  [/Threadripper\s*PRO\s*9\d{3}/i, 350],  // TR PRO 9000 (Shimada Peak)
  [/Threadripper\s*PRO\s*7\d{3}/i, 350],  // TR PRO 7000 (Storm Peak)
  [/Threadripper\s*PRO\s*5\d{3}/i, 280],  // TR PRO 5000 (Chagall)
  [/Threadripper\s*PRO\s*3\d{3}/i, 280],  // TR PRO 3000 (Castle Peak)
  [/Threadripper\s*9\d{3}/i, 350],        // TR 9000
  [/Threadripper\s*7\d{3}/i, 350],        // TR 7970X / 7980X
  [/Threadripper\s*39[0-9]{2}/i, 280],    // TR 3960X / 3970X / 3990X
  [/Threadripper\s*29[0-9]{2}/i, 250],    // TR 2000 series
  [/Threadripper\s*19[0-9]{2}/i, 180],    // TR 1000 series
  [/Threadripper/i, 280],                  // TR fallback

  // ──────────────────────────────────────────────────────────
  // AMD EPYC
  // ──────────────────────────────────────────────────────────
  [/EPYC\s*9[6-9]\d5(?!\d)/i, 400],           // 9005 high-end (Turin: 9755 500W, 9655 400W)
  [/EPYC\s*9\d{2}5(?!\d)/i, 280],             // 9005 standard
  [/EPYC\s*9[0-9]{3}P/i, 200],            // 9004 single-socket P
  [/EPYC\s*9[67][0-9]{2}/i, 360],         // 9004 high-end
  [/EPYC\s*9[0-5][0-9]{2}/i, 200],        // 9004 standard
  [/EPYC\s*8[0-9]{3}/i, 150],             // 8004 (Siena, 70–200W)
  [/EPYC\s*4[0-9]{3}/i, 105],             // 4004 (AM5 socket, 65–170W)
  [/EPYC\s*7[0-9]{3}X\b/i, 280],          // 7003X 3D V-Cache (Milan-X)
  [/EPYC\s*7[7-9][0-9]{2}/i, 225],        // 7003 high-end (Milan)
  [/EPYC\s*7[3-6][0-9]{2}/i, 155],        // 7003 mid (Milan)
  [/EPYC\s*7[0-2][0-9]{2}/i, 120],        // 7002 (Rome) / 7001 (Naples)
  [/EPYC\s*3[0-9]{3}/i, 45],              // EPYC Embedded 3000
  [/EPYC/i, 180],                          // EPYC fallback

  // ──────────────────────────────────────────────────────────
  // Apple silicon (Asahi Linux reports "Apple M1 Pro" etc.)
  // ──────────────────────────────────────────────────────────
  [/Apple\s*M[1-5]\s*Ultra/i, 120],
  [/Apple\s*M[1-5]\s*Max/i, 60],
  [/Apple\s*M[1-5]\s*Pro/i, 30],
  [/Apple\s*M[1-5]/i, 20],

  // ──────────────────────────────────────────────────────────
  // ARM servers and laptops
  // ──────────────────────────────────────────────────────────
  [/AmpereOne/i, 350],
  [/Ampere\s*Altra\s*Max/i, 250],
  [/Ampere\s*Altra/i, 210],
  [/Ampere/i, 210],
  [/Graviton\s*4/i, 210],                 // AWS Graviton4
  [/Graviton\s*3/i, 100],
  [/Graviton\s*2/i, 80],
  [/Graviton/i, 100],
  [/NVIDIA\s*Grace/i, 250],               // Grace CPU superchip (~500W for two)
  [/Snapdragon.*X\s*Elite/i, 45],
  [/Snapdragon.*X\s*Plus/i, 23],
  [/Snapdragon.*8cx/i, 7],
  [/Snapdragon\s*8/i, 8],
  [/Snapdragon/i, 5],
  [/Neoverse.*V[12]/i, 120],
  [/Neoverse.*N[12]/i, 60],
  [/Neoverse/i, 60],

  // ──────────────────────────────────────────────────────────
  // Single-board computers — by the `Model :` line on aarch64, or the SoC
  // ──────────────────────────────────────────────────────────
  [/Raspberry\s*Pi\s*5/i, 8],
  [/Raspberry\s*Pi\s*4/i, 6],
  [/Raspberry\s*Pi\s*(3|Compute Module 3)/i, 4],
  [/Raspberry\s*Pi\s*Zero/i, 2],
  [/Raspberry\s*Pi/i, 3],
  [/BCM2712/i, 8],                        // Pi 5
  [/BCM2711/i, 6],                        // Pi 4
  [/BCM2837/i, 4],                        // Pi 3
  [/BCM283[56]/i, 2],                     // Pi 1 / Zero / 2
  [/BCM2[0-9]{3}/i, 5],                   // other Broadcom
  [/RK3588/i, 8],                         // Rockchip flagship (Orange Pi 5, Rock 5)
  [/RK3399/i, 6],
  [/RK35\d{2}/i, 5],
  [/RK33\d{2}/i, 4],
  [/Rockchip/i, 5],
  [/Amlogic|\bS9[0-9]{2}[XYD]?\b|A311D/i, 4],
  [/Allwinner|\bsun\d+i\b/i, 3],
  [/i\.?MX\s*[689]/i, 3],                 // NXP i.MX
  [/Jetson.*Orin|Orin/i, 30],             // NVIDIA Jetson Orin (15–60W configurable)
  [/Jetson.*Xavier|Xavier/i, 20],
  [/Jetson|Tegra/i, 15],                  // NVIDIA Tegra/Jetson (TX1/TX2/Nano)
  [/ODROID|Odroid/i, 5],
  [/Orange\s*Pi|Banana\s*Pi|Rock\s*Pi|RockPro|Pine64|Khadas|Radxa|NanoPi/i, 5],
  [/BeagleBone/i, 3],

  // ──────────────────────────────────────────────────────────
  // What a hypervisor tells its guest
  // ──────────────────────────────────────────────────────────
  [/QEMU\s*Virtual\s*CPU|Common\s*KVM\s*processor|Virtual\s*CPU\b/i, 65],

  // ══════════════════════════════════════════════════════════
  // TIER 2 — long tail
  // ══════════════════════════════════════════════════════════

  // ──────────────────────────────────────────────────────────
  // Intel legacy desktop / mobile (Core 2, Netburst, Core Duo)
  // ──────────────────────────────────────────────────────────
  [/Core\s*2\s*Extreme/i, 130],
  [/Core\s*2\s*Quad/i, 95],
  [/Core\s*2\s*Duo\s*(CPU\s*)?[PTLSU]\d{4}/i, 25],  // mobile Core 2 (T7200 34W, P8400 25W, SU9400 10W)
  [/Core\s*2\s*Duo/i, 65],
  [/Core\s*2\s*Solo/i, 5],
  [/Core\s*2/i, 65],
  [/Core\s*(Duo|Solo)\b/i, 31],           // Yonah (2006) — before Core 2, after Core 2 rows
  [/Pentium\s*4\b/i, 95],                 // Netburst (84–115W)
  [/Pentium\s*D\b/i, 95],
  [/Pentium\s*Dual|Pentium.*E[2-6]\d{3}/i, 65],  // Pentium Dual-Core (Core 2 era)
  [/Pentium\s*M\b/i, 25],
  [/Pentium\s*III|Pentium\s*II\b|Pentium\s*Pro/i, 30],
  [/Pentium/i, 54],                        // Pentium fallback

  // ──────────────────────────────────────────────────────────
  // AMD legacy
  // ──────────────────────────────────────────────────────────
  [/Athlon.*\d{4}U/i, 15],                // Athlon mobile
  [/Athlon.*\d{3,4}GE?\b/i, 35],          // Athlon 200GE / 3000G APU
  [/Athlon\s*(64|X2|II)/i, 65],
  [/Athlon/i, 65],                         // Athlon fallback
  [/Sempron/i, 45],
  [/Turion/i, 35],
  [/FX-[89]\d{3}/i, 125],                 // FX-8xxx/9xxx
  [/FX-[46]\d{3}/i, 95],                  // FX-4xxx/6xxx
  [/Phenom/i, 95],
  [/Opteron.*\b6\d{3}\b/i, 115],          // 6100–6300 (G34) — "Opteron Processor 6272"
  [/Opteron.*\b4\d{3}\b/i, 75],           // 4100–4300 (C32)
  [/Opteron.*\bX\d{4}\b/i, 25],           // Opteron X (Kyoto, micro-server)
  [/Opteron.*\bA\d{4}\b/i, 25],           // Opteron A1100 (ARM)
  [/Opteron/i, 115],
  [/A[46]-\d{4}/i, 65],                   // AMD A-series APU
  [/A[89]-\d{4}/i, 65],
  [/A10-\d{4}/i, 95],
  [/A12-\d{4}/i, 35],                     // A12 mobile
  [/AMD\s*E[12]?-\d{3,4}/i, 18],          // E-350 / E1-2100 / E2-1800 (Brazos/Kabini)
  [/AMD\s*C-\d{2}/i, 9],                  // C-50 / C-60 (Ontario)
  [/\bGX-\d{3}/i, 6],                     // AMD G-series embedded (GX-412TC)
  [/AMD\s*G-T\d{2}/i, 6],

  // ──────────────────────────────────────────────────────────
  // IBM POWER (Talos/Blackbird workstations, second-life servers)
  // ──────────────────────────────────────────────────────────
  [/POWER10/i, 250],
  [/POWER9/i, 190],
  [/POWER8/i, 190],
  [/POWER7/i, 200],
  [/PowerPC|PPC/i, 30],

  // ──────────────────────────────────────────────────────────
  // Chinese x86 / ARM / MIPS vendors
  // ──────────────────────────────────────────────────────────
  [/Hygon/i, 180],                         // EPYC-derived (Dhyana)
  [/Zhaoxin|\bKX-[67]\d{3}/i, 70],         // VIA-derived
  [/\bKH-[34]\d{3}/i, 100],                // Zhaoxin server
  [/Kunpeng/i, 150],                       // HiSilicon Kunpeng 920
  [/Phytium|FT-2000|\bD2000\b|\bS2500\b/i, 60],
  [/Loongson.*3C/i, 130],                  // 3C5000/3C6000 server
  [/Loongson/i, 35],
  [/ThunderX/i, 100],                      // Cavium/Marvell
  [/Marvell.*Armada|Armada/i, 5],

  // ──────────────────────────────────────────────────────────
  // ARM cores by name (what `CPU part` resolves to when there is no Model)
  // ──────────────────────────────────────────────────────────
  [/Cortex-X\d/i, 6],
  [/Cortex-A7[2-9]|Cortex-A71\d/i, 5],
  [/Cortex-A[45]\d/i, 3],
  [/Cortex-A\d+/i, 3],
  [/Cortex-R\d|Cortex-M\d/i, 1],
  [/\bARMv[78]\b|\baarch64\b/i, 5],

  // ──────────────────────────────────────────────────────────
  // RISC-V / other
  // ──────────────────────────────────────────────────────────
  [/Sophgo|SG2042|Milk-V\s*Pioneer/i, 120],
  [/SiFive/i, 10],
  [/StarFive|JH7110|VisionFive/i, 5],
  [/Milk-V|Lichee|\bTH1520\b|\bC910\b/i, 5],
  [/RISC-V|\brv64/i, 5],
  [/MIPS/i, 5],
  [/VIA\s*(Nano|C7|Eden)/i, 15],
  [/Elbrus/i, 60],

  // ══════════════════════════════════════════════════════════
  // TIER 3 — vendor fallbacks: a guess beats a $0 bill
  // ══════════════════════════════════════════════════════════
  [/Core.*i[3579]/i, 65],
  [/Ryzen/i, 65],
  [/Intel/i, 65],
  [/AMD/i, 65],
  [/\bARM\b|\bARM64\b/i, 5],
];

/** `(R)` and `(TM)` out of a cpuinfo model string, so patterns can read it. */
function plainModel(model: string): string {
  return model.replace(/\((?:R|TM|C)\)/gi, '');
}

export function lookupCpuTdp(model: string): number | null {
  const m = plainModel(model);
  for (const [pattern, tdp] of CPU_TDP_TABLE) {
    if (pattern.test(m)) return tdp;
  }
  return null;
}

// CPU release year lookup. Doctrine: older silicon > newer (proven > theoretical).
// Table is ordered most-specific first so "Xeon E5-26" matches before generic "Xeon".
// Same tiers as the TDP table. Unmatched CPUs return null (age = 0 in scoring).
const CPU_YEAR_TABLE: [RegExp, number][] = [
  // ── Intel Core Ultra / Core 3-5-7 ──
  [/Core\s*Ultra\s*[579]\s+2\d{2}/i, 2024],
  [/Core\s*Ultra\s*[579]\s+1\d{2}/i, 2023],
  [/Core\s*Ultra/i, 2024],
  [/Core\s*[3579]\s+\d{3}[A-Z]*\b/i, 2024],
  // ── Intel Core i-series (generation is the leading digit(s)) ──
  [/i[3579]-2\d{3}[A-Z]*\b/i, 2011],
  [/i[3579]-3\d{3}[A-Z]*\b/i, 2012],
  [/i[3579]-4\d{3}[A-Z]*\b/i, 2013],
  [/i[3579]-5\d{3}[A-Z]*\b/i, 2015],
  [/i[3579]-6\d{3}[A-Z]*\b/i, 2015],
  [/i[3579]-7\d{3}[A-Z]*\b/i, 2017],
  [/i[3579]-8\d{3}[A-Z]*\b/i, 2018],
  [/i[3579]-9\d{3}[A-Z]*\b/i, 2018],
  // 10th gen on: desktop keeps five digits (12900K), mobile four (1260P,
  // 1065G7) — the generation is the leading pair either way.
  [/i[3579]-10\d{2,3}[A-Z0-9]*\b/i, 2020],
  [/i[3579]-11\d{2,3}[A-Z0-9]*\b/i, 2021],
  [/i[3579]-12\d{2,3}[A-Z0-9]*\b/i, 2022],
  [/i[3579]-13\d{2,3}[A-Z0-9]*\b/i, 2023],
  [/i[3579]-14\d{2,3}[A-Z0-9]*\b/i, 2024],
  [/i[357]-[3-9]\d{2}[A-Z]*\b/i, 2010],   // first gen, three digits (i5-520M, i7-860)
  [/i[357]\s+CPU\s+/i, 2009],             // Nehalem cpuinfo form ("Core i7 CPU 920")
  [/\bm[357]-\dY\d{2}|\bM-5Y\d{2}/i, 2015],
  // ── Intel Xeon 6 / Scalable / Max ──
  [/Xeon\s*(6\s+)?6\d{3}[PE]\b/i, 2024],
  [/Xeon.*Max\s*94\d{2}/i, 2023],
  [/Xeon.*(Platinum|Gold|Silver|Bronze)\s*[3-8]1\d{2}[A-Z+]*\b/i, 2017],
  [/Xeon.*(Platinum|Gold|Silver|Bronze)\s*[3-8]2\d{2}[A-Z+]*\b/i, 2019],
  [/Xeon.*(Platinum|Gold|Silver|Bronze)\s*[3-8]3\d{2}[A-Z+]*\b/i, 2021],
  [/Xeon.*(Platinum|Gold|Silver|Bronze)\s*[3-8]4\d{2}[A-Z+]*\b/i, 2023],
  [/Xeon.*(Platinum|Gold|Silver|Bronze)\s*[3-8]5\d{2}[A-Z+]*\b/i, 2023],
  // ── Intel Xeon W ──
  [/Xeon.*w[3579]-[23]5\d{2}/i, 2024],
  [/Xeon.*w[3579]-[23]4\d{2}/i, 2023],
  [/Xeon.*W-[23]3\d{2}/i, 2021],
  [/Xeon.*W-[23]2\d{2}/i, 2019],
  [/Xeon.*W-[23]1\d{2}/i, 2017],
  [/Xeon.*W-13\d{2}/i, 2021],
  [/Xeon.*W-12\d{2}/i, 2020],
  [/Xeon.*W-1\d{4}/i, 2020],
  // ── Intel Xeon E5 / E7 / E3 / E / D ──
  [/Xeon.*E[57]-\d{4}\s*v4\b/i, 2016],
  [/Xeon.*E[57]-\d{4}\s*v3\b/i, 2014],
  [/Xeon.*E[57]-\d{4}\s*v2\b/i, 2013],
  [/Xeon.*E5-[1246]6\d{2}\b(?!\s*v)/i, 2012],   // Sandy Bridge-EP — cammy, guile family
  [/Xeon.*E5-24\d{2}\b(?!\s*v)/i, 2012],
  [/Xeon.*E7-\d{4}\b(?!\s*v)/i, 2011],
  [/Xeon.*E3-1[25]\d{2}[A-Z]?\s*v6\b/i, 2017],
  [/Xeon.*E3-1[25]\d{2}[A-Z]?\s*v5\b/i, 2015],
  [/Xeon.*E3-12\d{2}[A-Z]?\s*v4\b/i, 2015],
  [/Xeon.*E3-12\d{2}[A-Z]?\s*v3\b/i, 2013],
  [/Xeon.*E3-12\d{2}[A-Z]?\s*v2\b/i, 2012],
  [/Xeon.*E3-12\d{2}[A-Z]?\b(?!\s*v)/i, 2011],
  [/Xeon.*E-24\d{2}/i, 2024],
  [/Xeon.*E-23\d{2}/i, 2021],
  [/Xeon.*E-22\d{2}/i, 2019],
  [/Xeon.*E-21\d{2}/i, 2018],
  [/Xeon.*D-[12]7\d{2}/i, 2022],
  [/Xeon.*D-21\d{2}/i, 2018],
  [/Xeon.*D-15\d{2}/i, 2015],
  // ── Intel Xeon pre-E5 (Nehalem / Westmere / Core 2 era) ──
  [/Xeon.*\b[XELW]56\d{2}\b/i, 2010],
  [/Xeon.*\b[XELW]55\d{2}\b/i, 2009],
  [/Xeon.*\bW3[56]\d{2}\b/i, 2009],
  [/Xeon.*\bX34\d{2}\b/i, 2009],
  [/Xeon.*\b[XEL]5[34]\d{2}\b/i, 2007],
  [/Xeon.*\bE3[12]\d{2}\b/i, 2008],
  [/Xeon.*\b[XE]7[45]\d{2}\b/i, 2008],
  [/Xeon.*Phi/i, 2016],
  // ── Intel small cores (Atom first: N270 is an Atom, not an N-series) ──
  [/Atom.*P5\d{3}/i, 2020],
  [/Atom.*C3\d{3}/i, 2017],
  [/Atom.*x[567]/i, 2016],
  [/Atom.*C2\d{3}/i, 2013],
  [/Atom.*[DN][2-5]\d{2}\b/i, 2010],
  [/Atom/i, 2010],
  [/\bN[123]\d{2}\b/i, 2023],              // N100 / N200 / N305
  [/Celeron.*N5\d{3}|Pentium.*N6\d{3}|Celeron.*J6\d{3}/i, 2021],
  [/Celeron.*N4\d{3}|Pentium.*N5\d{3}|Celeron.*J4\d{3}|Pentium.*J5\d{3}|Pentium\s*Silver/i, 2018],
  [/Celeron.*N3\d{3}|Pentium.*N3\d{3}|Celeron.*J3\d{3}|Pentium.*J3\d{3}/i, 2015],
  [/Celeron.*N2\d{3}|Celeron.*J1\d{3}/i, 2013],
  [/Celeron.*G[67]\d{3}|Pentium.*G[67]\d{3}|Pentium\s*Gold/i, 2021],
  [/Celeron.*G[45]\d{3}|Pentium.*G[45]\d{3}/i, 2017],
  [/Celeron.*G[123]\d{3}|Pentium.*G[123]\d{3}/i, 2012],
  // ── AMD Ryzen (model number leading digit ≈ generation) ──
  [/Ryzen\s*AI/i, 2024],
  [/Ryzen\s*Z2/i, 2025],
  [/Ryzen\s*Z1/i, 2023],
  [/Ryzen\s*Embedded\s*V3|Ryzen\s*Embedded\s*R2/i, 2022],
  [/Ryzen\s*Embedded/i, 2018],
  [/Threadripper.*9\d{3}/i, 2025],
  [/Threadripper.*7\d{3}/i, 2023],
  [/Threadripper.*5\d{3}/i, 2022],
  [/Ryzen.*\b1\d{3}(?!\d)/i, 2017],
  [/Ryzen.*\b2\d{3}(?!\d)/i, 2018],
  [/Ryzen.*\b3\d{3}(?!\d)/i, 2019],
  [/Ryzen.*\b4\d{3}(?!\d)/i, 2020],
  [/Ryzen.*\b5\d{3}(?!\d)/i, 2020],
  [/Ryzen.*\b6\d{3}(?!\d)/i, 2022],
  [/Ryzen.*\b7\d{3}(?!\d)/i, 2022],
  [/Ryzen.*\b8\d{3}(?!\d)/i, 2024],
  [/Ryzen.*\b9\d{3}(?!\d)/i, 2024],
  // ── AMD EPYC ──
  // The trailing digit is the generation: 7xx1 Naples, 7xx2 Rome, 7xx3
  // Milan, 9xx4 Genoa/Bergamo, 9xx5 Turin. The hundreds are the tier.
  [/EPYC.*\b[49]\d{2}5(?!\d)/i, 2024],
  [/EPYC.*\b4\d{2}4(?!\d)/i, 2024],
  [/EPYC.*\b8\d{2}4(?!\d)/i, 2023],
  [/EPYC.*\b9\d{2}4(?!\d)/i, 2022],
  [/EPYC.*\b7\d{2}3(?!\d)/i, 2021],
  [/EPYC.*\b7\d{2}2(?!\d)/i, 2019],
  [/EPYC.*\b7\d{2}1(?!\d)/i, 2017],
  [/EPYC.*\b3\d{2}1(?!\d)/i, 2018],
  [/EPYC/i, 2019],
  // ── AMD legacy ──
  [/Athlon.*\d{3,4}GE?\b|Athlon.*\d{4}U/i, 2019],
  [/Athlon\s*II|Phenom\s*II/i, 2009],
  [/Athlon\s*(64|X2)/i, 2005],
  [/Phenom/i, 2008],
  [/FX-[4689]\d{3}/i, 2012],
  [/Opteron.*\b6[23]\d{2}\b/i, 2012],
  [/Opteron.*\b(6[01]\d{2}|4\d{3})\b/i, 2010],
  [/Opteron.*\b[AX]\d{4}\b/i, 2014],
  [/Opteron/i, 2007],
  [/A\d{1,2}-9\d{3}/i, 2016],
  [/A\d{1,2}-[78]\d{3}/i, 2015],
  [/A\d{1,2}-[56]\d{3}/i, 2013],
  [/A\d{1,2}-[34]\d{3}/i, 2012],
  [/AMD\s*E[12]?-\d{3,4}|AMD\s*C-\d{2}|\bGX-\d{3}|AMD\s*G-T/i, 2012],
  [/Sempron|Turion/i, 2006],
  // ── Apple silicon ──
  [/Apple M1\b/i, 2020],
  [/Apple M2\b/i, 2022],
  [/Apple M3\b/i, 2023],
  [/Apple M4\b/i, 2024],
  [/Apple M5\b/i, 2025],
  // ── ARM servers / laptops ──
  [/AmpereOne/i, 2023],
  [/Ampere\s*Altra/i, 2020],
  [/Graviton\s*4/i, 2023],
  [/Graviton\s*3/i, 2021],
  [/Graviton\s*2/i, 2019],
  [/Graviton/i, 2018],
  [/NVIDIA\s*Grace/i, 2023],
  [/Snapdragon.*X\s*(Elite|Plus)/i, 2024],
  [/Snapdragon.*8cx/i, 2019],
  [/Neoverse.*V2/i, 2022],
  [/Neoverse.*(V1|N2)/i, 2021],
  [/Neoverse.*N1/i, 2019],
  [/Kunpeng/i, 2019],
  [/ThunderX2/i, 2018],
  [/ThunderX/i, 2015],
  // ── SBCs ──
  [/Raspberry\s*Pi\s*5|BCM2712/i, 2023],
  [/Raspberry\s*Pi\s*Zero\s*2/i, 2021],
  [/Raspberry\s*Pi\s*4|BCM2711/i, 2019],
  [/Raspberry\s*Pi\s*3|BCM2837/i, 2016],
  [/Raspberry\s*Pi\s*2|BCM2836/i, 2015],
  [/Raspberry\s*Pi|BCM2835/i, 2012],
  [/RK3588/i, 2022],
  [/RK356\d/i, 2021],
  [/RK3399/i, 2016],
  [/RK3328|RK3288/i, 2017],
  [/Orin/i, 2022],
  [/Xavier/i, 2018],
  [/Jetson|Tegra/i, 2015],
  [/A311D|\bS922X\b/i, 2019],
  [/\bS905[XYD]?\b/i, 2016],
  // ── ARM cores by name ──
  [/Cortex-X[34]|Cortex-A7(15|20)/i, 2023],
  [/Cortex-X2|Cortex-A710/i, 2021],
  [/Cortex-X1|Cortex-A78/i, 2020],
  [/Cortex-A77/i, 2019],
  [/Cortex-A76/i, 2018],
  [/Cortex-A7[35]|Cortex-A55/i, 2017],
  [/Cortex-A72/i, 2015],
  [/Cortex-A5[37]|Cortex-A17/i, 2014],
  [/Cortex-A1[25]|Cortex-A7\b/i, 2012],
  [/Cortex-A9|Cortex-A8/i, 2009],
  // ── RISC-V / POWER / Chinese x86 ──
  [/Sophgo|SG2042|Pioneer/i, 2023],
  [/StarFive|JH7110|VisionFive/i, 2022],
  [/SiFive/i, 2020],
  [/TH1520|Lichee/i, 2023],
  [/POWER10/i, 2021],
  [/POWER9/i, 2017],
  [/POWER8/i, 2014],
  [/POWER7/i, 2010],
  [/Hygon/i, 2018],
  [/Zhaoxin|\bK[XH]-[67]\d{3}/i, 2019],
  [/Phytium|FT-2000|\bD2000\b/i, 2020],
  [/Loongson.*3A6000|Loongson.*3C6000/i, 2023],
  [/Loongson.*3[AC]5000/i, 2021],
  [/Loongson/i, 2017],
  [/Elbrus/i, 2018],
  [/VIA\s*(Nano|C7|Eden)/i, 2008],
  // ── Intel legacy ──
  [/Core\s*2\s*(Duo|Quad|Extreme)\s*(CPU\s*)?[A-Z]*[89]\d{3}/i, 2008],
  [/Core\s*2/i, 2007],
  [/Core\s*(Duo|Solo)\b/i, 2006],
  [/Pentium\s*Dual|Pentium.*E[2-6]\d{3}/i, 2008],
  [/Pentium\s*D\b/i, 2005],
  [/Pentium\s*M\b/i, 2004],
  [/Pentium\s*4\b/i, 2002],
  [/Pentium\s*III/i, 1999],
  // Generic fallbacks — very rough, avoids null for old chips
  [/Xeon.*\bX5\d{3}\b/i, 2010],
  [/Xeon.*\bE5\d{3}\b/i, 2011],
];

export function lookupCpuYear(model: string): number | null {
  const m = plainModel(model);
  for (const [pattern, year] of CPU_YEAR_TABLE) {
    if (pattern.test(m)) return year;
  }
  return null;
}

/**
 * ARM cores by the `CPU part` id /proc/cpuinfo reports on aarch64 when
 * there is no `Model` line to name the board. Implementer 0x41 is Arm
 * itself; the others put their own cores in the same field.
 */
const ARM_PARTS: Record<string, Record<string, string>> = {
  '0x41': {
    '0xd03': 'Cortex-A53', '0xd04': 'Cortex-A35', '0xd05': 'Cortex-A55', '0xd07': 'Cortex-A57',
    '0xd08': 'Cortex-A72', '0xd09': 'Cortex-A73', '0xd0a': 'Cortex-A75', '0xd0b': 'Cortex-A76',
    '0xd0c': 'Neoverse N1', '0xd0d': 'Cortex-A77', '0xd0e': 'Cortex-A76AE', '0xd40': 'Neoverse V1',
    '0xd41': 'Cortex-A78', '0xd42': 'Cortex-A78AE', '0xd44': 'Cortex-X1', '0xd46': 'Cortex-A510',
    '0xd47': 'Cortex-A710', '0xd48': 'Cortex-X2', '0xd49': 'Neoverse N2', '0xd4a': 'Neoverse E1',
    '0xd4b': 'Cortex-A78C', '0xd4d': 'Cortex-A715', '0xd4e': 'Cortex-X3', '0xd4f': 'Neoverse V2',
    '0xd80': 'Cortex-A520', '0xd81': 'Cortex-A720', '0xd82': 'Cortex-X4', '0xd84': 'Neoverse V3',
    '0xd85': 'Cortex-X925', '0xd87': 'Cortex-A725', '0xd8e': 'Neoverse N3',
    '0xc07': 'Cortex-A7', '0xc08': 'Cortex-A8', '0xc09': 'Cortex-A9', '0xc0d': 'Cortex-A12',
    '0xc0f': 'Cortex-A15', '0xc0e': 'Cortex-A17',
  },
  '0x43': { '0x0a1': 'ThunderX', '0x0af': 'ThunderX2', '0x0b8': 'ThunderX3' },
  '0x48': { '0xd01': 'Kunpeng 920' },
  '0x4e': { '0x004': 'NVIDIA Carmel (Xavier)', '0x003': 'NVIDIA Denver' },
  '0x51': { '0x800': 'Snapdragon Kryo', '0x801': 'Snapdragon Kryo', '0xc00': 'Snapdragon Falkor', '0x001': 'Snapdragon Oryon' },
  '0x61': { '0x022': 'Apple M1', '0x023': 'Apple M1', '0x024': 'Apple M1 Pro', '0x025': 'Apple M1 Pro', '0x028': 'Apple M1 Max', '0x029': 'Apple M1 Max', '0x032': 'Apple M2', '0x033': 'Apple M2', '0x034': 'Apple M2 Pro', '0x035': 'Apple M2 Pro', '0x038': 'Apple M2 Max', '0x039': 'Apple M2 Max' },
  '0xc0': { '0xac3': 'Ampere Altra', '0xac4': 'AmpereOne' },
};

const ARM_IMPLEMENTERS: Record<string, string> = {
  '0x41': 'ARM', '0x42': 'Broadcom', '0x43': 'Cavium', '0x48': 'HiSilicon', '0x4e': 'NVIDIA',
  '0x50': 'APM', '0x51': 'Qualcomm', '0x53': 'Samsung', '0x61': 'Apple', '0x66': 'Faraday',
  '0x69': 'Intel', '0x70': 'Phytium', '0xc0': 'Ampere',
};

/**
 * A CPU's name from /proc/cpuinfo text, whichever field the architecture
 * puts it in. x86 says `model name`; MIPS `cpu model`; aarch64 boards name
 * themselves in a trailing `Model` (device tree) or 32-bit `Hardware`
 * line, or say nothing but `CPU implementer` + `CPU part`; ppc64 uses
 * `cpu`. Order is precedence: a Pi 4's `Hardware` still says BCM2835.
 */
export function parseCpuModel(cpuinfoOrText: string): string | null {
  const grab = (re: RegExp) => cpuinfoOrText.match(re)?.[1]?.trim() || null;
  const named = grab(/^model name\s*:\s*(.+)$/im)
    ?? grab(/^cpu model\s*:\s*(.+)$/im)
    ?? grab(/^Model\s*:\s*(.+)$/im)
    ?? grab(/^Hardware\s*:\s*(.+)$/im)
    ?? grab(/^cpu\s*:\s*(.+)$/im);
  if (named) {
    // ppc64 appends capability notes: "POWER9 (raw), altivec supported".
    return named.replace(/\s*\(raw\).*$|,\s*altivec supported$/i, '').trim();
  }
  // Not anchored: the remote probe pastes implementer and part onto one line.
  const part = grab(/CPU part\s*:\s*(0x[0-9a-f]+)/i)?.toLowerCase();
  if (!part) return null;
  const impl = grab(/CPU implementer\s*:\s*(0x[0-9a-f]+)/i)?.toLowerCase() ?? '0x41';
  const core = ARM_PARTS[impl]?.[part];
  if (!core) return `${ARM_IMPLEMENTERS[impl] ?? 'ARM'} aarch64 part ${part}`;
  // Arm's own cores carry no vendor in the table; every other entry does.
  return /^(Cortex|Neoverse)/.test(core) ? `ARM ${core}` : core;
}

/**
 * Count spinning disks (ROTA=1, not loop devices) from lsblk.
 */
/**
 * Solid-state disks, by the same rotational flag that finds the spinning
 * ones: lsblk's last column is 1 for a platter and 0 for flash.
 *
 * The local and remote probes each counted these with the same inline
 * expression while calling a named function for the spinning ones, so half
 * the pair had a name and half did not.
 */
export function countSsds(lsblkOutput: string): number {
  return lsblkOutput.split('\n').filter((line) => {
    const parts = line.trim().split(/\s+/);
    return parts[1] === 'disk' && parts[parts.length - 1] === '0';
  }).length;
}

/** /proc/meminfo in gigabytes. Its own figures are kilobytes. */
export function parseMeminfo(text: string): {
  totalGB: number; availableGB: number; swapTotalGB: number; swapFreeGB: number;
} {
  const field = (name: string) =>
    parseInt(text.match(new RegExp(`${name}:\\s+(\\d+)`))?.[1] ?? '0') / 1024 / 1024;
  return {
    totalGB: field('MemTotal'),
    availableGB: field('MemAvailable'),
    swapTotalGB: field('SwapTotal'),
    swapFreeGB: field('SwapFree'),
  };
}

/** The three figures at the head of /proc/loadavg. */
export function parseLoadavg(text: string): [number, number, number] {
  const parts = text.trim().split(/\s+/);
  return [0, 1, 2].map((i) => num(parts[i])) as [number, number, number];
}

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
 * One node, parsed from the wire our userland probe script emits. The
 * reader lives in userland/parse.ts beside the plugins that write it;
 * this name is kept because the web route and the worker import it here.
 */
export { parseWireProbe as parseRemoteProbe } from './userland/parse';
