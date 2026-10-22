'use client';

import { useState } from 'react';
import { type NodeEcon, getDefaultEcon } from '@/lib/mesh-score';
import type { SshHost } from './types';

/* eslint-disable @typescript-eslint/no-explicit-any */

// ============================================================
// Add Node Button (inline card)
// ============================================================

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function AddNodeButton({ hosts: _hosts, keys, configHash, mutate, seedEcon, settings }: { hosts: SshHost[]; keys: string[]; configHash?: string; mutate: () => void; seedEcon?: (hostname: string, econ: NodeEcon) => Promise<void>; settings?: any }) {
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState<SshHost>({ name: '', hostname: '', port: '22', user: '', identityFile: '', forwardAgent: 'yes' });
  const [saving, setSaving] = useState(false);

  const save = async () => {
    if (!form.name) return;
    setSaving(true);
    try {
      const res = await fetch('/api/ssh-config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...form, hash: configHash }) });
      if (res.status === 409) {
        mutate();
        alert('SSH config changed on disk since this page loaded — reloaded it. Please re-apply your entry.');
        return;
      }
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        alert(err.error ?? 'Failed to save host');
        return;
      }
      if (res.ok) {
        // Seed a placeholder econ so the new node shows up immediately under the
        // "configured-only" filter. User refines from the node detail page.
        if (seedEcon) {
          const econ: NodeEcon = { ...getDefaultEcon(settings), location: form.name };
          await seedEcon(form.name, econ);
        }
        mutate();
        setAdding(false);
        setForm({ name: '', hostname: '', port: '22', user: '', identityFile: '', forwardAgent: 'yes' });
      }
    } finally { setSaving(false); }
  };

  if (!adding) {
    return (
      <button
        onClick={() => setAdding(true)}
        className="border border-dashed border-[var(--color-border)] rounded p-4 flex items-center justify-center gap-2 text-base text-[var(--color-muted)] hover:text-[var(--color-foreground)] hover:border-[var(--color-accent)]/50 transition-colors cursor-pointer min-h-[120px]"
      >
        <span className="text-lg">+</span> Add Node
      </button>
    );
  }

  return (
    <div className="border border-[var(--color-accent)]/30 rounded p-4 space-y-3 col-span-1 md:col-span-2 xl:col-span-3">
      <HostForm form={form} setForm={setForm} keys={keys} onSave={save} onCancel={() => setAdding(false)} saving={saving} isNew />
    </div>
  );
}

// ============================================================
// Host Form
// ============================================================

function HostForm({ form, setForm, keys, onSave, onCancel, saving, isNew }: {
  form: SshHost; setForm: (f: SshHost) => void; keys: string[];
  onSave: () => void; onCancel: () => void; saving: boolean; isNew?: boolean;
}) {
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
        <div>
          <label className="text-base text-[var(--color-muted)] block mb-1">Host Alias</label>
          <input type="text" value={form.name} onChange={e => setForm({ ...form, name: e.target.value })}
            placeholder="e.g. cammy" disabled={!isNew}
            className="w-full bg-[var(--color-background)] border border-[var(--color-border)] rounded px-3 py-1.5 text-base font-mono disabled:opacity-50" />
        </div>
        <div>
          <label className="text-base text-[var(--color-muted)] block mb-1">HostName</label>
          <input type="text" value={form.hostname ?? ''} onChange={e => setForm({ ...form, hostname: e.target.value })}
            placeholder="e.g. cammy.foxhop.net"
            className="w-full bg-[var(--color-background)] border border-[var(--color-border)] rounded px-3 py-1.5 text-base font-mono" />
        </div>
        <div>
          <label className="text-base text-[var(--color-muted)] block mb-1">Port</label>
          <input type="text" value={form.port ?? ''} onChange={e => setForm({ ...form, port: e.target.value })}
            placeholder="22"
            className="w-full bg-[var(--color-background)] border border-[var(--color-border)] rounded px-3 py-1.5 text-base font-mono" />
        </div>
        <div>
          <label className="text-base text-[var(--color-muted)] block mb-1">User</label>
          <input type="text" value={form.user ?? ''} onChange={e => setForm({ ...form, user: e.target.value })}
            placeholder="e.g. fox"
            className="w-full bg-[var(--color-background)] border border-[var(--color-border)] rounded px-3 py-1.5 text-base font-mono" />
        </div>
        <div>
          <label className="text-base text-[var(--color-muted)] block mb-1">Identity File</label>
          <select value={form.identityFile ?? ''} onChange={e => setForm({ ...form, identityFile: e.target.value })}
            className="w-full bg-[var(--color-background)] border border-[var(--color-border)] rounded px-3 py-1.5 text-base font-mono">
            <option value="">default</option>
            {keys.map(k => <option key={k} value={`~/.ssh/${k}`}>~/.ssh/{k}</option>)}
          </select>
        </div>
        <div>
          <label className="text-base text-[var(--color-muted)] block mb-1">Forward Agent</label>
          <div className="flex gap-2 mt-0.5">
            {['yes', 'no'].map(v => (
              <button key={v} onClick={() => setForm({ ...form, forwardAgent: v })}
                className={`flex-1 px-3 py-1.5 text-base rounded border transition-colors cursor-pointer ${
                  form.forwardAgent === v ? 'border-[var(--color-accent)] bg-[var(--color-accent)]/10 text-[var(--color-accent)] font-bold' : 'border-[var(--color-border)] hover:border-[var(--color-muted)]'
                }`}>
                {v}
              </button>
            ))}
          </div>
        </div>
      </div>
      {/* Any machine with an sshd and a shell is a node: the probe speaks
          GNU/Linux, busybox, Android, the BSDs, macOS, Solaris/illumos, AIX,
          HP-UX, IRIX, Tru64, SCO, Haiku, QNX, Cygwin and PowerShell. The
          one thing it cannot fix is a modern ssh refusing an old daemon's
          crypto — that is a per-host setting in ~/.ssh/config. */}
      <div className="text-sm text-[var(--color-muted)]">
        Any OS with an sshd works — Linux, BSD, macOS, Solaris, AIX, Windows and the long tail.
        A pre-2015 sshd may need <span className="font-mono">HostKeyAlgorithms +ssh-rsa</span> and{' '}
        <span className="font-mono">KexAlgorithms +diffie-hellman-group1-sha1,diffie-hellman-group14-sha1</span> in{' '}
        <span className="font-mono">~/.ssh/config</span> before this client will connect at all.
      </div>
      <div className="flex items-center gap-3">
        <button onClick={onSave} disabled={saving || !form.name}
          className="px-4 py-1.5 text-base font-bold rounded border border-[var(--color-accent)] text-[var(--color-accent)] hover:bg-[var(--color-accent)]/10 transition-colors disabled:opacity-50 cursor-pointer">
          {saving ? 'Saving...' : isNew ? 'Add Host' : 'Save'}
        </button>
        <button onClick={onCancel}
          className="px-4 py-1.5 text-base rounded border border-[var(--color-border)] text-[var(--color-muted)] hover:text-[var(--color-foreground)] transition-colors cursor-pointer">
          Cancel
        </button>
      </div>
    </div>
  );
}
