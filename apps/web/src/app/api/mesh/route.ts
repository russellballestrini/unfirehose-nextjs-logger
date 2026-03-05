import { NextResponse } from 'next/server';
import { execSync } from 'child_process';
import { readFileSync } from 'fs';
import { homedir } from 'os';
import path from 'path';

/* eslint-disable @typescript-eslint/no-explicit-any */

interface MeshNode {
  hostname: string;
  reachable: boolean;
  cpuCores?: number;
  memTotalGB?: number;
  memUsedGB?: number;
  memAvailableGB?: number;
  loadAvg?: [number, number, number];
  uptime?: string;
  claudeProcesses?: number;
  swapUsedGB?: number;
  swapTotalGB?: number;
  error?: string;
}

// Discover mesh nodes from SSH config
function discoverNodes(): string[] {
  const nodes = new Set<string>();
  // Always include localhost
  nodes.add('localhost');

  try {
    const sshConfig = readFileSync(path.join(homedir(), '.ssh', 'config'), 'utf-8');
    // Look for Host entries that look like real machines (not wildcards, not git hosts)
    const hostRegex = /^Host\s+(.+)/gm;
    let match;
    while ((match = hostRegex.exec(sshConfig)) !== null) {
      const hosts = match[1].split(/\s+/);
      for (const h of hosts) {
        // Skip wildcards, git hosts, proxy hosts
        if (h.includes('*') || h.includes('git.') || h.includes('github')) continue;
        // Only include things that look like mesh nodes (hostnames, not service endpoints)
        if (h.includes('.foxhop.net') || (!h.includes('.') && h !== 'localhost')) {
          nodes.add(h);
        }
      }
    }
  } catch {
    // SSH config not readable
  }

  return [...nodes];
}

// Deduplicate nodes that resolve to the same host
function deduplicateNodes(nodes: MeshNode[]): MeshNode[] {
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

function getLocalStats(): MeshNode {
  try {
    const hostname = execSync('hostname', { encoding: 'utf-8' }).trim();

    // CPU cores
    const cpuCores = parseInt(execSync('nproc', { encoding: 'utf-8' }).trim());

    // Memory from /proc/meminfo (more precise than free)
    const meminfo = readFileSync('/proc/meminfo', 'utf-8');
    const memTotal = parseInt(meminfo.match(/MemTotal:\s+(\d+)/)?.[1] ?? '0') / 1024 / 1024;
    const memAvailable = parseInt(meminfo.match(/MemAvailable:\s+(\d+)/)?.[1] ?? '0') / 1024 / 1024;
    const swapTotal = parseInt(meminfo.match(/SwapTotal:\s+(\d+)/)?.[1] ?? '0') / 1024 / 1024;
    const swapFree = parseInt(meminfo.match(/SwapFree:\s+(\d+)/)?.[1] ?? '0') / 1024 / 1024;

    // Load average
    const loadavg = readFileSync('/proc/loadavg', 'utf-8').trim().split(/\s+/);
    const loadAvg: [number, number, number] = [
      parseFloat(loadavg[0]),
      parseFloat(loadavg[1]),
      parseFloat(loadavg[2]),
    ];

    // Uptime
    const uptimeSeconds = parseFloat(readFileSync('/proc/uptime', 'utf-8').split(/\s/)[0]);
    const uptime = formatUptime(uptimeSeconds);

    // Claude processes
    let claudeProcesses = 0;
    try {
      const ps = execSync("ps aux | grep -i '[c]laude' | wc -l", { encoding: 'utf-8' });
      claudeProcesses = parseInt(ps.trim()) || 0;
    } catch { /* no claudes */ }

    return {
      hostname,
      reachable: true,
      cpuCores,
      memTotalGB: round(memTotal),
      memUsedGB: round(memTotal - memAvailable),
      memAvailableGB: round(memAvailable),
      loadAvg,
      uptime,
      claudeProcesses,
      swapTotalGB: round(swapTotal),
      swapUsedGB: round(swapTotal - swapFree),
    };
  } catch (e: any) {
    return { hostname: 'localhost', reachable: false, error: String(e) };
  }
}

function getRemoteStats(host: string): MeshNode {
  try {
    const cmd = `ssh -o ConnectTimeout=5 -o StrictHostKeyChecking=no ${host} 'hostname && nproc && cat /proc/meminfo && cat /proc/loadavg && cat /proc/uptime && ps aux | grep -i "[c]laude" | wc -l'`;
    const output = execSync(cmd, { encoding: 'utf-8', timeout: 10000 });
    const lines = output.trim().split('\n');

    const hostname = lines[0];
    const cpuCores = parseInt(lines[1]);

    // Parse meminfo from remote
    const meminfoLines = lines.slice(2);
    const meminfoText = meminfoLines.join('\n');
    const memTotal = parseInt(meminfoText.match(/MemTotal:\s+(\d+)/)?.[1] ?? '0') / 1024 / 1024;
    const memAvailable = parseInt(meminfoText.match(/MemAvailable:\s+(\d+)/)?.[1] ?? '0') / 1024 / 1024;
    const swapTotal = parseInt(meminfoText.match(/SwapTotal:\s+(\d+)/)?.[1] ?? '0') / 1024 / 1024;
    const swapFree = parseInt(meminfoText.match(/SwapFree:\s+(\d+)/)?.[1] ?? '0') / 1024 / 1024;

    // Find loadavg line (5 space-separated numbers/fractions)
    const loadLine = meminfoLines.find(l => /^\d+\.\d+\s+\d+\.\d+\s+\d+\.\d+/.test(l));
    const loadParts = loadLine?.split(/\s+/) ?? ['0', '0', '0'];
    const loadAvg: [number, number, number] = [
      parseFloat(loadParts[0]),
      parseFloat(loadParts[1]),
      parseFloat(loadParts[2]),
    ];

    // Find uptime line (single or two numbers)
    const uptimeLine = meminfoLines.find(l => /^\d+\.\d+\s+\d+\.\d+$/.test(l.trim()));
    const uptimeSeconds = parseFloat(uptimeLine?.split(/\s/)[0] ?? '0');
    const uptime = formatUptime(uptimeSeconds);

    // Last line is claude count
    const claudeProcesses = parseInt(lines[lines.length - 1]) || 0;

    return {
      hostname,
      reachable: true,
      cpuCores,
      memTotalGB: round(memTotal),
      memUsedGB: round(memTotal - memAvailable),
      memAvailableGB: round(memAvailable),
      loadAvg,
      uptime,
      claudeProcesses,
      swapTotalGB: round(swapTotal),
      swapUsedGB: round(swapTotal - swapFree),
    };
  } catch (e: any) {
    return {
      hostname: host,
      reachable: false,
      error: e.message?.includes('ETIMEDOUT') ? 'Connection timed out' : 'Unreachable',
    };
  }
}

function formatUptime(seconds: number): string {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${mins}m`;
  return `${mins}m`;
}

function round(n: number): number {
  return Math.round(n * 10) / 10;
}

export async function GET() {
  const nodeHosts = discoverNodes();

  const rawResults: MeshNode[] = [];

  for (const host of nodeHosts) {
    if (host === 'localhost') {
      rawResults.push(getLocalStats());
    } else {
      rawResults.push(getRemoteStats(host));
    }
  }

  const results = deduplicateNodes(rawResults);

  // Summary stats
  const reachable = results.filter(n => n.reachable);
  const totalClaudes = reachable.reduce((s, n) => s + (n.claudeProcesses ?? 0), 0);
  const totalCores = reachable.reduce((s, n) => s + (n.cpuCores ?? 0), 0);
  const totalMemGB = reachable.reduce((s, n) => s + (n.memTotalGB ?? 0), 0);
  const totalMemUsedGB = reachable.reduce((s, n) => s + (n.memUsedGB ?? 0), 0);

  return NextResponse.json({
    nodes: results,
    summary: {
      totalNodes: nodeHosts.length,
      reachableNodes: reachable.length,
      totalClaudes,
      totalCores,
      totalMemGB: round(totalMemGB),
      totalMemUsedGB: round(totalMemUsedGB),
    },
  });
}
