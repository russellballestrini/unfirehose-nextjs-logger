'use client';

import useSWR from 'swr';
import { fetcher } from './fetcher';
import type { ChainVerdict } from './ChainBadge';

export interface ChainSummary {
  state: ChainVerdict;
  anchor: 'intact' | 'rewritten' | 'missing' | null;
  breaks: number;
  firstBreak: number | null;
}

/**
 * Chain verdict and witness state for a set of session ids, refreshed
 * every 15 s, for the list views (live, active, logs) that show many
 * sessions at once. Ids are sorted and joined so the SWR key is stable
 * across re-renders that only reorder them.
 */
export function useChainStates(ids: string[], refreshInterval = 15000): Record<string, ChainSummary> {
  const key = [...new Set(ids.filter(Boolean))].sort().join(',');
  const { data } = useSWR<{ chains: Record<string, ChainSummary> }>(
    key ? `/api/sessions/chains?ids=${encodeURIComponent(key)}` : null,
    fetcher,
    { refreshInterval },
  );
  return data?.chains ?? {};
}
