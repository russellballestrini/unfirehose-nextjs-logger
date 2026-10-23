'use client';

import { useMemo, useState } from 'react';
import useSWR from 'swr';
import { fetcher } from '@unturf/unfirehose-ui/fetcher';
import { EmptyState } from '@unturf/unfirehose-ui/EmptyState';
import { encodeQr, qrPath } from '@/lib/qr';

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface LanEntry {
  address: string;
  iface: string;
  kind: 'lan' | 'vpn' | 'public';
  url: string;
  listening: boolean;
}

const KIND_LABEL: Record<LanEntry['kind'], string> = {
  lan: 'local network',
  vpn: 'VPN: a phone on that VPN',
  public: 'public address',
};

/** Our dashboard's URL as a QR code, dark on light whatever our theme: a camera wants contrast. */
export function QrSvg({ text, size = 240 }: { text: string; size?: number }) {
  const qr = useMemo(() => encodeQr(text, { ecl: 'M' }), [text]);
  const border = 4;
  const dim = qr.size + border * 2;
  return (
    <svg
      role="img"
      aria-label={`QR code for ${text}`}
      data-qr-version={qr.version}
      viewBox={`0 0 ${dim} ${dim}`}
      width={size}
      height={size}
      shapeRendering="crispEdges"
      className="block max-w-full h-auto rounded"
    >
      <rect width={dim} height={dim} fill="#ffffff" />
      <path d={qrPath(qr, border)} fill="#000000" />
    </svg>
  );
}

/**
 * Settings → Phone: open this dashboard on a phone on the same network.
 *
 * Lists this machine's LAN addresses (GET /api/lan), draws a QR for the one
 * chosen, and says whether our server answers there. There is no login in
 * front of this dashboard, so the copy says plainly: a trusted network only.
 */
export function PhoneAccess() {
  const { data, error } = useSWR<any>('/api/lan', fetcher, { refreshInterval: 30_000 });
  const [chosen, setChosen] = useState<string | null>(null);

  if (error) return <p className="text-[var(--color-error)]">Could not read this machine&apos;s addresses: {String(error.message ?? error)}</p>;
  if (!data) return <p className="text-[var(--color-muted)]">Looking for network addresses…</p>;

  const addresses: LanEntry[] = data.addresses ?? [];
  const port: number = data.port;

  if (addresses.length === 0) {
    return (
      <EmptyState
        what="A QR code for opening this dashboard on a phone appears here."
        action="This machine has no network address a phone could reach: no Wi-Fi or Ethernet connection, only loopback. Join a network, and this tab finds the address within 30 seconds."
      />
    );
  }

  const fallback = addresses.find((a) => a.listening && a.kind === 'lan') ?? addresses.find((a) => a.listening) ?? addresses[0];
  const current = addresses.find((a) => a.address === chosen) ?? fallback;
  const noneListening = addresses.every((a) => !a.listening);

  return (
    <div className="space-y-4" data-phone-access>
      <p className="text-base text-[var(--color-muted)]">
        Point a phone&apos;s camera at this code while it is on the same network as{' '}
        <span className="text-[var(--color-foreground)]">{data.hostname ?? 'this machine'}</span>, and it opens our dashboard.
        Nothing goes through a cloud: the phone talks to this machine directly.
      </p>

      <div className="grid grid-cols-1 md:grid-cols-[auto_1fr] gap-6 items-start">
        <div className="bg-[var(--color-surface)] rounded border border-[var(--color-border)] p-4 grid gap-3 justify-items-center">
          <QrSvg text={current.url} />
          <a href={current.url} className="font-mono text-base text-[var(--color-accent)] break-all hover:underline" data-qr-url>
            {current.url}
          </a>
        </div>

        <div className="space-y-4 min-w-0">
          <fieldset className="bg-[var(--color-surface)] rounded border border-[var(--color-border)] p-4 space-y-1">
            <legend className="px-1 text-base font-bold text-[var(--color-muted)]">Address</legend>
            {addresses.map((a) => (
              <label key={a.address} className="grid grid-cols-[auto_1fr] items-center gap-2 min-h-10 cursor-pointer" data-address={a.address}>
                <input
                  type="radio"
                  name="lan-address"
                  value={a.address}
                  checked={a.address === current.address}
                  onChange={() => setChosen(a.address)}
                  className="accent-[var(--color-accent)] w-4 h-4"
                />
                <span className="min-w-0">
                  <span className="font-mono">{a.address}</span>
                  <span className="text-[var(--color-muted)]"> · {a.iface} · {KIND_LABEL[a.kind]}</span>
                  <span
                    className="ml-2 text-sm font-bold"
                    style={{ color: a.listening ? 'var(--color-accent)' : 'var(--color-error)' }}
                    data-listening={a.listening ? 'yes' : 'no'}
                  >
                    {a.listening ? 'answering' : 'not answering'}
                  </span>
                </span>
              </label>
            ))}
          </fieldset>

          {current.listening ? (
            <p className="text-base" data-reach="yes">
              Our server answers on <span className="font-mono">{current.address}:{port}</span>. If the phone still cannot connect,
              a firewall on this machine may be blocking port {port}; allow it from your network only, for example{' '}
              <code className="rounded bg-[var(--color-background)] px-1 text-[var(--color-accent)]">sudo ufw allow from {subnetOf(current.address)} to any port {port} proto tcp</code>.
            </p>
          ) : (
            <div className="text-base space-y-2" data-reach="no">
              <p className="text-[var(--color-error)] font-bold">
                Our server does not answer on {current.address}:{port}{noneListening ? ', nor on any other address here' : ''}: it is listening on this machine only.
              </p>
              <p className="text-[var(--color-muted)]">
                <code className="text-[var(--color-accent)]">next dev</code> and <code className="text-[var(--color-accent)]">next start</code> listen on every interface (0.0.0.0) unless started with{' '}
                <code className="text-[var(--color-accent)]">-H 127.0.0.1</code>; restart without it, or with{' '}
                <code className="text-[var(--color-accent)]">-H 0.0.0.0</code>. In Docker, compose publishes{' '}
                <code className="text-[var(--color-accent)]">127.0.0.1:3000:3000</code>; change it to{' '}
                <code className="text-[var(--color-accent)]">3000:3000</code>. Behind a proxy, it is the proxy&apos;s bind that counts.
              </p>
            </div>
          )}

          <div className="rounded border border-[var(--color-error)] p-3 text-base space-y-1" data-trust-warning>
            <p className="font-bold text-[var(--color-error)]">Trusted networks only</p>
            <p className="text-[var(--color-muted)]">
              This dashboard has no login. Anyone on this network who opens the address sees every session, prompt,
              file path and cost it holds, and can use every action it offers. Use it at home or on a network you control,
              not on café or conference Wi-Fi; to keep it to this machine, start it with{' '}
              <code className="text-[var(--color-accent)]">-H 127.0.0.1</code>.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}

/** The /24 an address sits in, for a firewall rule a person can paste. */
export function subnetOf(ip: string): string {
  const p = ip.split('.');
  return p.length === 4 ? `${p[0]}.${p[1]}.${p[2]}.0/24` : ip;
}
