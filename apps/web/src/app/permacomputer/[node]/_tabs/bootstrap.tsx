'use client';

import { harnessesFor } from '@/lib/harnesses';
import { HarnessPicker } from '@/components/HarnessPicker';
import type { TabProps } from './shared';

const HARNESSES = harnessesFor('node');

/** The Bootstrap tab. */
export function BootstrapTab(props: TabProps) {
  const { bootFilter, bootHarness, bootHost, bootStatuses, isLocal, setBootFilter } = props;
  return (
    <HarnessPicker
      harnesses={HARNESSES}
      filter={bootFilter}
      setFilter={setBootFilter}
      statuses={bootStatuses}
      onBoot={bootHarness}
      header={
        <span className="text-sm text-[var(--color-muted)]">
          target: <span className="font-mono text-[var(--color-foreground)]">{bootHost}</span>
        </span>
      }
      footer={
        <>
          Installs and verifies harnesses on {bootHost}. For claude-code, also syncs OAuth credentials.
          {!isLocal && ' Requires SSH key access.'}
        </>
      }
    />
  );
}
