import { NextResponse } from 'next/server';
import { execSync } from 'child_process';
import { discoverNodes } from '@unfirehose/core/mesh';

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface GeoIPResult {
  hostname: string;
  ip: string;
  city: string;
  region: string;
  regionCode: string;
  country: string;
  countryCode: string;
  isp: string;
  org: string;
  as: string;
  lat: number;
  lon: number;
  timezone: string;
  error?: string;
}

// Cache GeoIP results for 1 hour (keyed by hostname)
const cache = new Map<string, { result: GeoIPResult; ts: number }>();
const CACHE_TTL = 3600_000;

function getEgressIP(host: string): string | null {
  try {
    if (host === 'localhost') {
      // Local egress IP
      const ip = execSync("curl -s --max-time 5 ifconfig.me", { encoding: 'utf-8', timeout: 8000 }).trim();
      return ip || null;
    }
    const ip = execSync(
      `ssh -o ConnectTimeout=5 -o StrictHostKeyChecking=no ${host} 'curl -s --max-time 5 ifconfig.me'`,
      { encoding: 'utf-8', timeout: 15000 }
    ).trim();
    return ip || null;
  } catch {
    return null;
  }
}

async function lookupGeoIP(ip: string): Promise<Omit<GeoIPResult, 'hostname' | 'ip'> | null> {
  try {
    // ip-api.com — free, no key, 45 req/min, JSON by default
    const res = await fetch(`http://ip-api.com/json/${encodeURIComponent(ip)}?fields=status,message,city,regionName,region,country,countryCode,isp,org,as,lat,lon,timezone`, {
      signal: AbortSignal.timeout(5000),
    });
    const data = await res.json();
    if (data.status !== 'success') return null;
    return {
      city: data.city ?? '',
      region: data.regionName ?? '',
      regionCode: data.region ?? '',
      country: data.country ?? '',
      countryCode: data.countryCode ?? '',
      isp: data.isp ?? '',
      org: data.org ?? '',
      as: data.as ?? '',
      lat: data.lat ?? 0,
      lon: data.lon ?? 0,
      timezone: data.timezone ?? '',
    };
  } catch {
    return null;
  }
}

export async function GET() {
  const nodeHosts = discoverNodes();
  const results: GeoIPResult[] = [];

  for (const host of nodeHosts) {
    // Check cache
    const cached = cache.get(host);
    if (cached && Date.now() - cached.ts < CACHE_TTL) {
      results.push(cached.result);
      continue;
    }

    const ip = getEgressIP(host);
    if (!ip) {
      results.push({
        hostname: host,
        ip: '',
        city: '', region: '', regionCode: '', country: '', countryCode: '',
        isp: '', org: '', as: '', lat: 0, lon: 0, timezone: '',
        error: 'Could not determine egress IP',
      });
      continue;
    }

    const geo = await lookupGeoIP(ip);
    if (!geo) {
      results.push({
        hostname: host,
        ip,
        city: '', region: '', regionCode: '', country: '', countryCode: '',
        isp: '', org: '', as: '', lat: 0, lon: 0, timezone: '',
        error: 'GeoIP lookup failed',
      });
      continue;
    }

    const result: GeoIPResult = { hostname: host, ip, ...geo };
    cache.set(host, { result, ts: Date.now() });
    results.push(result);

    // Rate limit: ip-api.com allows 45/min. Pause 1.5s between lookups.
    if (nodeHosts.indexOf(host) < nodeHosts.length - 1) {
      await new Promise(r => setTimeout(r, 1500));
    }
  }

  return NextResponse.json({ nodes: results });
}
