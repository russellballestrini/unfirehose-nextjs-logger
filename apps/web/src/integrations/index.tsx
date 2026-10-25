'use client';

import { fetcher } from '@unturf/unfirehose-ui/fetcher';
import type { ComponentType, MutableRefObject, ReactNode } from 'react';
import Link from 'next/link';
import useSWR from 'swr';
import {
  INTEGRATIONS,
  INTEGRATIONS_ENV,
  integrationForHost,
  type IntegrationId,
  type IntegrationSource,
} from './catalog';
import { unsandboxClient } from './unsandbox/client';

/**
 * Our page-side registration point for integrations: everything a shared
 * page may render from one, and nothing else. A page asks a hook here; the
 * hook asks `GET /api/integrations` whether the integration is on, and an
 * integration that is off fetches nothing and renders nothing.
 *
 * What exists is `catalog.ts`; what routes do is `server.ts`.
 */

export { INTEGRATIONS, integrationForHost };
export type { IntegrationId };

// ── What an integration may contribute ──────────────────────────────────────

/** A terminal widget for one container session on /tmux/<session>. */
export interface TerminalPaneProps {
  sessionId: string;
  interactive: boolean;
  sendKeysRef: MutableRefObject<((keys: string) => void) | null>;
  onConnect: (connected: boolean) => void;
  onServiceState: (state: string | null, message: string) => void;
}

/** How a session on one of an integration's hosts is drawn and driven. */
export interface TerminalProvider {
  /** Shown as `@label` beside the session name. */
  label: string;
  Pane: ComponentType<TerminalPaneProps>;
  footer: string;
  sendKeys: (sessionId: string, keys: string) => void;
  /** Disconnecting ends the session: a container is ours, not somebody's work. */
  kill: (sessionId: string) => void;
  onFirstConnect?: (sessionId: string) => void;
  /** Wake, redeploy, or fetch logs (returned) for a sleeping service. */
  serviceAction?: (sessionId: string, action: 'wake' | 'redeploy' | 'logs') => Promise<string | undefined>;
}

/** What /tmux hands an integration's session list. */
export interface TerminalSectionProps {
  nicknames: Record<string, { nickname: string; host: string; service_name: string }>;
  mutateNicknames: () => void;
  /** Open the New tab with this integration's form selected. */
  onLaunch: () => void;
}

export interface TerminalSection {
  label: string;
  sub: string;
  /** Finishes "tmux sessions and …" under the page title. */
  blurb: string;
  Sessions: ComponentType<TerminalSectionProps>;
  NewSession: ComponentType;
}

/** What an integration adds to /permacomputer. */
export interface MeshContribution {
  nodes: number;
  reachable: number;
  cards: ReactNode[];
  panels: ReactNode[];
}

/** Boot targets on a project page; `clonesRemote` boots from the project's git remote. */
export type BootTargets = { value: string; label: string; clonesRemote?: boolean }[];

export interface ClientIntegration {
  id: IntegrationId;
  terminal?: TerminalProvider;
  terminals?: TerminalSection;
  /** Rendered under the integration's toggle in Settings → Integrations while it is on. */
  SettingsPanel?: ComponentType;
  /** The page at /permacomputer/<id>. */
  NodePage?: ComponentType;
  /** Hooks: each is called on every render with whether the integration is on. */
  useMesh?: (enabled: boolean) => MeshContribution;
  useBootTargets?: (enabled: boolean) => BootTargets;
}

const CLIENT: Record<IntegrationId, ClientIntegration> = {
  unsandbox: unsandboxClient,
};

// ── Asking whether an integration is on ─────────────────────────────────────

export interface IntegrationStatus {
  id: IntegrationId;
  name: string;
  summary: string;
  href?: string;
  enabled: boolean;
  source: IntegrationSource;
}

export function useIntegrations() {
  const { data, mutate } = useSWR<{ integrations?: IntegrationStatus[] }>(
    '/api/integrations', fetcher, { revalidateOnFocus: false },
  );
  const list: IntegrationStatus[] = Array.isArray(data?.integrations) ? data.integrations : [];
  const on = new Set(list.filter((i) => i.enabled).map((i) => i.id));
  return {
    loaded: data !== undefined,
    list,
    enabled: (id: IntegrationId) => on.has(id),
    mutate,
  };
}

// ── What shared pages render ────────────────────────────────────────────────

/**
 * Extra nodes, node cards and panels for /permacomputer. One line per
 * integration, called unconditionally so the hook order never changes.
 */
export function useMeshIntegrations(): MeshContribution {
  const { enabled } = useIntegrations();
  const parts = [
    CLIENT.unsandbox.useMesh!(enabled('unsandbox')),
  ];
  return {
    nodes: parts.reduce((n, p) => n + p.nodes, 0),
    reachable: parts.reduce((n, p) => n + p.reachable, 0),
    cards: parts.flatMap((p) => p.cards),
    panels: parts.flatMap((p) => p.panels),
  };
}

/** Boot targets integrations add to a project page. */
export function useIntegrationBootTargets(): BootTargets {
  const { enabled } = useIntegrations();
  return [
    ...CLIENT.unsandbox.useBootTargets!(enabled('unsandbox')),
  ];
}

/** Session lists and launch forms /tmux shows for integrations that are on. */
export function useTerminalIntegrations(): (TerminalSection & { id: IntegrationId })[] {
  const { enabled } = useIntegrations();
  return Object.values(CLIENT)
    .filter((c) => c.terminals && enabled(c.id))
    .map((c) => ({ id: c.id, ...c.terminals! }));
}

/** The terminal for a session on an integration's host (whether or not it is on). */
export function terminalFor(id: IntegrationId): TerminalProvider | undefined {
  return CLIENT[id]?.terminal;
}

/** Where to turn an integration on, said in place of what it would have shown. */
export function IntegrationOffNotice({ id, loading = false }: { id: IntegrationId; loading?: boolean }) {
  if (loading) return <div className="p-4 text-sm text-[var(--color-muted)]">Loading…</div>;
  const info = INTEGRATIONS.find((i) => i.id === id);
  return (
    <div className="p-4 text-sm text-[var(--color-muted)] space-y-1">
      <div>The {info?.name ?? id} integration is off, so there is nothing here.</div>
      <div>
        Turn it on in{' '}
        <Link href="/settings#Integrations" className="text-[var(--color-accent)] hover:underline">
          Settings → Integrations
        </Link>
        , or start the app with <code className="font-mono">{INTEGRATIONS_ENV}={id}</code>.
      </div>
    </div>
  );
}

/** A page an integration owns, e.g. /permacomputer/unsandbox. */
export function IntegrationPage({ id }: { id: IntegrationId }) {
  const { loaded, enabled } = useIntegrations();
  const Page = CLIENT[id]?.NodePage;
  if (!loaded || !enabled(id) || !Page) return <IntegrationOffNotice id={id} loading={!loaded} />;
  return <Page />;
}

/** The panel an integration shows under its toggle in Settings. */
export function integrationSettingsPanel(id: IntegrationId): ComponentType | undefined {
  return CLIENT[id]?.SettingsPanel;
}
