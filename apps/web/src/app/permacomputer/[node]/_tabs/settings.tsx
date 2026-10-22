'use client';

import { KV } from '@unturf/unfirehose-ui/KV';
import { Section, SshField, TunableRow, type TabProps } from './shared';

/* eslint-disable @typescript-eslint/no-explicit-any */

/** The Settings tab. */
export function SettingsTab(props: TabProps) {
  const {
    diskOverride,
    host,
    ispCost,
    kwhRate,
    node,
    saveSetting,
    saveSshHost,
    setDiskOverride,
    setIspCost,
    setKwhRate,
    setSshEditing,
    setSshForm,
    setWattsOverride,
    sshEditing,
    sshForm,
    sshSaving,
    wattsOverride,
  } = props;
  return (
      <div className="max-w-lg">
        <Section title="Cost Tunables">
          <div className="space-y-3">
            <TunableRow label="Electricity rate" unit="$/kWh" step={0.01}
              value={kwhRate}
              onChange={(v) => { setKwhRate(v); saveSetting(`electricity_rate_${host}`, String(v)); }}
            />
            <TunableRow label="ISP cost" unit="$/mo" step={1}
              value={ispCost}
              onChange={(v) => { setIspCost(v); saveSetting(`isp_cost_${host}`, String(v)); }}
            />
            <TunableRow label="Spinning disks" unit="HDDs" step={1}
              value={diskOverride ?? ''}
              placeholder={String(node?.spinningDisks ?? 0)}
              onChange={(v) => { setDiskOverride(v || undefined); saveSetting(`disk_override_${host}`, String(v)); }}
            />
            <TunableRow label="Watts override" unit="W" step={1}
              value={wattsOverride ?? ''}
              placeholder="auto"
              onChange={(v) => { setWattsOverride(v || undefined); saveSetting(`watts_override_${host}`, String(v)); }}
            />
            <div className="text-xs text-[var(--color-muted)] pt-1">
              Auto-detected: {node?.spinningDisks ?? '?'} HDDs, {node?.ssdCount ?? '?'} SSDs via lsblk
              {node?.cpuTdpWatts && <> &middot; {node.cpuTdpWatts}W CPU TDP</>}
            </div>
          </div>
        </Section>

        <Section title="SSH Configuration">
          {!sshEditing ? (
            <div className="space-y-2">
              <div className="grid grid-cols-2 gap-x-6 gap-y-1 text-sm">
                <KV label="Host" value={sshForm.name} />
                <KV label="Hostname" value={sshForm.hostname || host} />
                <KV label="Port" value={sshForm.port || '22'} />
                <KV label="User" value={sshForm.user || '(default)'} />
                <KV label="Identity File" value={sshForm.identityFile || '(default)'} />
                <KV label="Forward Agent" value={sshForm.forwardAgent || 'no'} />
              </div>
              <button
                onClick={() => setSshEditing(true)}
                className="text-xs text-[var(--color-accent)] hover:underline cursor-pointer mt-2"
              >
                Edit SSH Config
              </button>
            </div>
          ) : (
            <div className="space-y-3">
              <SshField label="Host (alias)" value={sshForm.name}
                onChange={(v) => setSshForm((f: any) => ({ ...f, name: v }))} />
              <SshField label="Hostname" value={sshForm.hostname ?? ''} placeholder={host}
                onChange={(v) => setSshForm((f: any) => ({ ...f, hostname: v || undefined }))} />
              <SshField label="Port" value={sshForm.port ?? ''} placeholder="22"
                onChange={(v) => setSshForm((f: any) => ({ ...f, port: v || undefined }))} />
              <SshField label="User" value={sshForm.user ?? ''} placeholder="(default)"
                onChange={(v) => setSshForm((f: any) => ({ ...f, user: v || undefined }))} />
              <SshField label="Identity File" value={sshForm.identityFile ?? ''} placeholder="~/.ssh/id_rsa"
                onChange={(v) => setSshForm((f: any) => ({ ...f, identityFile: v || undefined }))} />
              <div className="flex items-center gap-2">
                <span className="text-sm text-[var(--color-muted)] w-32">Forward Agent</span>
                <label className="flex items-center gap-2 text-sm cursor-pointer">
                  <input
                    type="checkbox"
                    checked={sshForm.forwardAgent === 'yes'}
                    onChange={(e) => setSshForm((f: any) => ({ ...f, forwardAgent: e.target.checked ? 'yes' : undefined }))}
                    className="accent-[var(--color-accent)]"
                  />
                  <span className="text-[var(--color-muted)]">yes</span>
                </label>
              </div>
              <div className="flex gap-2 pt-1">
                <button
                  onClick={saveSshHost}
                  disabled={sshSaving || !sshForm.name.trim()}
                  className="px-4 py-1.5 text-sm font-bold bg-[var(--color-accent)] text-[var(--color-background)] rounded hover:opacity-90 disabled:opacity-40 cursor-pointer"
                >
                  {sshSaving ? 'Saving...' : 'Save'}
                </button>
                <button
                  onClick={() => setSshEditing(false)}
                  className="px-4 py-1.5 text-sm text-[var(--color-muted)] hover:text-[var(--color-foreground)] cursor-pointer"
                >
                  Cancel
                </button>
              </div>
            </div>
          )}
        </Section>
      </div>
  );
}
