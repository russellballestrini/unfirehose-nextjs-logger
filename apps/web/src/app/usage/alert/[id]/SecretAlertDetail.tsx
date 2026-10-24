'use client';

import Link from 'next/link';
import { PageContext } from '@unturf/unfirehose-ui/PageContext';
import { formatTimestamp } from '@unturf/unfirehose/format';
import type { SecretAlertDetails, SecretAlertWords } from '@unturf/unfirehose/secret-alert';

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * A secret_exposed alert: no usage window, so none of the forensic panels.
 * What kind, where, which session and project, when; never the value. The
 * session link lands on the tool call; the ledger link lists every flagged
 * action in that session.
 */
export function SecretAlertDetail({ alert, secret, words }: { alert: any; secret: SecretAlertDetails; words: SecretAlertWords }) {
  const acknowledge = async () => {
    await fetch('/api/alerts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'acknowledge', id: alert.id }),
    });
    window.location.reload();
  };
  const ledger = `/actions?flag=any${secret.session ? `&session=${encodeURIComponent(secret.session)}` : ''}`;
  const rows: Array<[string, string]> = [
    ['Kind', words.kinds],
    ['Where', words.where],
    ['Project', secret.projectDisplay || secret.project || 'unknown'],
    ['Session', secret.session ?? 'unknown'],
    ['Harness', secret.harness ?? 'unknown'],
    ['Seen at', secret.seenAt ? formatTimestamp(secret.seenAt) : 'unknown'],
    ['Times in this session', String(alert.actual_value ?? 1)],
  ];
  return (
    <div className="space-y-6 max-w-4xl" data-secret-alert>
      <PageContext
        pageType="alert-detail"
        summary={`Alert #${alert.id}: ${words.kinds} seen in ${words.where}, session ${secret.session ?? 'unknown'} of ${secret.project ?? 'unknown'}.`}
        metrics={{ alert_id: alert.id, alert_type: alert.alert_type, location: secret.location, times: alert.actual_value ?? 1 }}
      />
      <div className="flex items-center gap-3">
        <Link href="/usage" className="text-base text-[var(--color-accent)] hover:underline">&larr; Usage Monitor</Link>
        <span className="text-base text-[var(--color-border)]">/</span>
        <span className="text-base text-[var(--color-muted)]">Alert #{alert.id}</span>
      </div>
      <div className="bg-red-950/40 border border-red-900/60 rounded p-4 space-y-3">
        <h2 className="text-lg font-bold text-[var(--color-error)]">Credential seen: {words.kinds}</h2>
        <p className="text-base">{words.message}</p>
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-base">
          {rows.map(([k, v]) => (
            <div key={k} className="contents">
              <dt className="text-[var(--color-muted)]">{k}</dt>
              <dd className="font-mono break-all">{v}</dd>
            </div>
          ))}
        </dl>
        <div className="flex flex-wrap gap-3 items-center">
          {words.sessionPath && <Link href={words.sessionPath} className="text-[var(--color-accent)] hover:underline">Open the session at that tool call</Link>}
          <Link href={ledger} className="text-[var(--color-accent)] hover:underline">Flagged actions in this session</Link>
          {!alert.acknowledged && (
            <button onClick={acknowledge} className="px-3 py-1.5 rounded text-sm font-bold border border-[var(--color-border)] hover:border-[var(--color-accent)] cursor-pointer">
              Acknowledge
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

