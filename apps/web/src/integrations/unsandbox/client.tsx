'use client';

import { fetcher } from '@unturf/unfirehose-ui/fetcher';
import useSWR from 'swr';
import type { BootTargets, ClientIntegration, MeshContribution } from '../index';
import { UnsandboxPanel } from './MeshPanel';
import { UnsandboxNodeCard } from './NodeCard';
import UnsandboxNodePage from './NodePage';
import { unsandboxTerminal } from './terminal';
import { UnsandboxNewSession, UnsandboxSessions } from './Terminals';

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * The account as a node on /permacomputer, and its keys panel below the
 * fleet charts. Nothing is fetched while the integration is off.
 */
function useUnsandboxMesh(enabled: boolean): MeshContribution {
  const { data: status } = useSWR(enabled ? '/api/unsandbox' : null, fetcher, { refreshInterval: 60000 });
  const { data: services } = useSWR(
    enabled && status?.connected ? '/api/unsandbox?action=services' : null,
    fetcher, { refreshInterval: 60000 },
  );
  const service = (services?.services ?? []).find(
    (s: any) => s.name?.includes('unfirehose') || s.name?.includes('firehose'),
  );
  if (!enabled) return { nodes: 0, reachable: 0, cards: [], panels: [] };
  return {
    nodes: status?.connected ? 1 : 0,
    reachable: service ? 1 : 0,
    cards: status?.connected ? [<UnsandboxNodeCard key="unsandbox" status={status} service={service} />] : [],
    panels: [<UnsandboxPanel key="unsandbox" />],
  };
}

/** A connected account is somewhere a project page can boot a harness. */
function useUnsandboxBootTargets(enabled: boolean): BootTargets {
  const { data: status } = useSWR(enabled ? '/api/unsandbox' : null, fetcher, { revalidateOnFocus: false });
  // A container has no checkout of ours, so it clones the project's remote.
  return enabled && status?.connected
    ? [{ value: 'unsandbox', label: 'unsandbox.com', clonesRemote: true }]
    : [];
}

export const unsandboxClient: ClientIntegration = {
  id: 'unsandbox',
  terminal: unsandboxTerminal,
  terminals: {
    label: '◈ unsandbox',
    sub: 'cloud container',
    blurb: 'unsandbox containers',
    Sessions: UnsandboxSessions,
    NewSession: UnsandboxNewSession,
  },
  SettingsPanel: UnsandboxPanel,
  NodePage: UnsandboxNodePage,
  useMesh: useUnsandboxMesh,
  useBootTargets: useUnsandboxBootTargets,
};
