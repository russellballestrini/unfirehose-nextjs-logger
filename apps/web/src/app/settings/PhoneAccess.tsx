'use client';

import { useMemo, useState } from 'react';
import useSWR from 'swr';
import { fetcher } from '@unturf/unfirehose-ui/fetcher';
import { EmptyState } from '@unturf/unfirehose-ui/EmptyState';
import { encodeQr, qrPath } from '@/lib/qr';

export interface LanEntry {
  address: string;
  iface: string;
  kind: 'lan' | 'vpn' | 'public';
  url: string;
  listening: boolean;
}

/** Where our server listens and what the next start would pick (GET /api/lan `bind`). */
export interface BindState {
  running: string | null;
  runningLan: boolean | null;
  saved: { lan: boolean; setAt: string | null };
  next: { host: string; lan: boolean; source: 'env' | 'settings' | 'default' };
  override: string | null;
  file: string;
  restartNeeded: boolean;
  container: boolean;
}

interface LanAnswer {
  hostname?: string;
  port: number;
  addresses?: LanEntry[];
  bind?: BindState;
}

const KIND_LABEL: Record<LanEntry['kind'], string> = {
  lan: 'local network',
  vpn: 'VPN: a phone on that VPN',
  public: 'public address',
};

const code = 'rounded bg-[var(--color-background)] px-1 text-[var(--color-accent)]';

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

/** What opening it to the network means, said plainly. Shown before the opt-in and beside the QR. */
function TrustWarning() {
  return (
    <div className="rounded border border-[var(--color-error)] p-3 text-base space-y-1" data-trust-warning>
      <p className="font-bold text-[var(--color-error)]">There is no login</p>
      <p>
        Anyone on the same network can read every session, push commits, and type into tmux.
      </p>
      <p className="text-[var(--color-muted)]">
        Every prompt, file path and cost this dashboard holds, and every action it offers, is theirs too. Use it at home or on
        a network you control, never on café, hotel or conference Wi-Fi.
      </p>
    </div>
  );
}

/** The bind is fixed when our server starts; say how to restart it. */
function RestartNote({ bind }: { bind: BindState }) {
  const opening = bind.next.lan;
  return (
    <div className="rounded border border-[var(--color-border)] bg-[var(--color-surface)] p-3 text-base space-y-1" data-restart-needed>
      <p className="font-bold">Restart needed</p>
      <p className="text-[var(--color-muted)]">
        Saved: {opening ? 'open to this network' : 'this machine only'} ({bind.file}). Our server picks its address when it starts, so
        this takes effect on the next start: stop <code className={code}>make dev</code> with Ctrl-C and run it again, or run{' '}
        <code className={code}>make service-restart</code> for the systemd units.
      </p>
    </div>
  );
}

async function saveLan(lan: boolean): Promise<string | null> {
  try {
    const res = await fetch('/api/lan', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(lan ? { lan, understood: true } : { lan }),
    });
    if (res.ok) return null;
    const body = await res.json().catch(() => ({}));
    return String(body.error ?? `HTTP ${res.status}`);
  } catch (e) {
    return String((e as Error).message ?? e);
  }
}

/** Not reachable from the network: explain, warn, and offer the opt-in. No QR. */
function OptIn({ data, bind, onSaved }: { data: LanAnswer; bind: BindState | undefined; onSaved: () => void }) {
  const [understood, setUnderstood] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const port = data.port;
  const save = async (lan: boolean) => {
    setBusy(true);
    setFailure(null);
    const err = await saveLan(lan);
    setBusy(false);
    if (err) setFailure(err); else onSaved();
  };

  return (
    <div className="space-y-4 max-w-3xl" data-phone-access data-lan-optin>
      <p className="text-base">
        <span className="font-bold">Our dashboard listens on this machine only</span>
        {bind?.running ? <> (<span className="font-mono">{bind.running}:{port}</span>)</> : <>: no address here answers on port {port}</>}, so a
        phone cannot open it and no QR code is offered. That is our default.
      </p>
      <p className="text-base text-[var(--color-muted)]">
        To open it on a phone on the same network as <span className="text-[var(--color-foreground)]">{data.hostname ?? 'this machine'}</span>,
        let our server listen on every interface. Nothing goes through a cloud: the phone talks to this machine directly.
      </p>

      <TrustWarning />

      {bind?.override != null ? (
        <p className="text-base" data-lan-override>
          <code className={code}>UNFIREHOSE_HOST={bind.override}</code> decides where our server listens, so this tab cannot change it.
          Unset it to choose here, or start with <code className={code}>UNFIREHOSE_HOST=0.0.0.0 make dev</code>.
        </p>
      ) : bind?.saved.lan ? (
        <div className="space-y-3">
          <RestartNote bind={bind} />
          <button type="button" disabled={busy} onClick={() => save(false)} data-lan-off
            className="min-h-10 px-3 rounded border border-[var(--color-border)] hover:border-[var(--color-accent)] disabled:opacity-50">
            Keep it to this machine instead
          </button>
        </div>
      ) : (
        <div className="space-y-3">
          <label className="grid grid-cols-[auto_1fr] items-start gap-2 cursor-pointer text-base">
            <input type="checkbox" checked={understood} onChange={(e) => setUnderstood(e.target.checked)}
              className="accent-[var(--color-accent)] w-4 h-4 mt-1" data-lan-understood />
            <span>I understand: anyone on this network can read every session, push commits, and type into tmux, with no login.</span>
          </label>
          <button type="button" disabled={!understood || busy} onClick={() => save(true)} data-lan-on
            className="min-h-10 px-3 rounded bg-[var(--color-error)] text-white font-bold disabled:opacity-50">
            Open to this network on next start
          </button>
          <p className="text-sm text-[var(--color-muted)]">
            Saved in {bind?.file ?? '$UNFIREHOSE_DIR/web-bind.json'}; takes effect when our server restarts (<code className={code}>make dev</code> again,
            or <code className={code}>make service-restart</code>). For one run only: <code className={code}>UNFIREHOSE_HOST=0.0.0.0 make dev</code>.
          </p>
        </div>
      )}
      {failure && <p className="text-[var(--color-error)]" data-lan-error>Could not save: {failure}</p>}
    </div>
  );
}

/** In a container we see the container's addresses; compose's port mapping is what counts. */
function ContainerNote() {
  return (
    <div className="space-y-4 max-w-3xl" data-phone-access data-lan-container>
      <p className="text-base">
        Our server runs in a container, so the addresses it can see are the container&apos;s, not ones a phone could open, and no
        QR code is offered. What a phone can reach is decided by the port mapping: our <code className={code}>docker-compose.yml</code>{' '}
        publishes <code className={code}>127.0.0.1:3000:3000</code>, this machine only. To open it to your network, change that line to{' '}
        <code className={code}>3000:3000</code> and run <code className={code}>docker compose up -d</code>, then open{' '}
        <span className="font-mono">http://&lt;this machine&apos;s address&gt;:3000/</span> on the phone.
      </p>
      <TrustWarning />
    </div>
  );
}

/**
 * Settings → Phone: open this dashboard on a phone on the same network.
 *
 * Our server listens on 127.0.0.1 unless someone opted in, so the usual
 * state is the opt-in: what it exposes, said plainly, and a restart to take
 * effect. Once our server answers on a LAN address (GET /api/lan probes
 * each), a QR for it, and a way back to this machine only.
 */
export function PhoneAccess() {
  const { data, error, mutate } = useSWR<LanAnswer>('/api/lan', fetcher, { refreshInterval: 30_000 });
  const [chosen, setChosen] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  if (error) return <p className="text-[var(--color-error)]">Could not read this machine&apos;s addresses: {String(error.message ?? error)}</p>;
  if (!data) return <p className="text-[var(--color-muted)]">Looking for network addresses…</p>;

  const addresses: LanEntry[] = data.addresses ?? [];
  const bind = data.bind;
  const port = data.port;

  if (bind?.container) return <ContainerNote />;

  if (addresses.length === 0) {
    return (
      <EmptyState
        what="A QR code for opening this dashboard on a phone appears here."
        action="This machine has no network address a phone could reach: no Wi-Fi or Ethernet connection, only loopback. Join a network, and this tab finds the address within 30 seconds."
      />
    );
  }

  // Offered only where our server answers, and never while it was started on
  // loopback: then something else holds that port, not our dashboard.
  const reachable = bind?.runningLan === false ? [] : addresses.filter((a) => a.listening);
  if (reachable.length === 0) return <OptIn data={data} bind={bind} onSaved={() => { void mutate(); }} />;

  const current = reachable.find((a) => a.address === chosen) ?? reachable.find((a) => a.kind === 'lan') ?? reachable[0];
  const silent = addresses.filter((a) => !reachable.includes(a));
  const close = async () => {
    setBusy(true);
    setFailure(null);
    const err = await saveLan(false);
    setBusy(false);
    if (err) setFailure(err); else void mutate();
  };

  return (
    <div className="space-y-4" data-phone-access data-lan-open>
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
            {reachable.map((a) => (
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
                </span>
              </label>
            ))}
            {silent.length > 0 && (
              <p className="text-sm text-[var(--color-muted)] pt-1" data-not-answering>
                Not answering on {silent.map((a) => `${a.address} (${a.iface})`).join(', ')}.
              </p>
            )}
          </fieldset>

          <p className="text-base" data-reach="yes">
            Our server answers on <span className="font-mono">{current.address}:{port}</span>. If the phone still cannot connect,
            a firewall on this machine may be blocking port {port}; allow it from your network only, for example{' '}
            <code className={code}>sudo ufw allow from {subnetOf(current.address)} to any port {port} proto tcp</code>.
          </p>

          <TrustWarning />

          {bind?.restartNeeded && <RestartNote bind={bind} />}

          {bind?.override != null ? (
            <p className="text-base" data-lan-override>
              <code className={code}>UNFIREHOSE_HOST={bind.override}</code> decides where our server listens; unset it and restart to keep
              it to this machine.
            </p>
          ) : bind && !bind.restartNeeded ? (
            <button type="button" disabled={busy} onClick={close} data-lan-off
              className="min-h-10 px-3 rounded border border-[var(--color-border)] hover:border-[var(--color-accent)] disabled:opacity-50">
              Keep it to this machine on next start
            </button>
          ) : null}
          {failure && <p className="text-[var(--color-error)]" data-lan-error>Could not save: {failure}</p>}
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
