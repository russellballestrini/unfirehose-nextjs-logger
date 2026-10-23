import { NextResponse } from 'next/server';
import { getSetting } from '@unturf/unfirehose/db/ingest';
import {
  INTEGRATIONS,
  INTEGRATIONS_ENV,
  integrationForHost,
  integrationSettingKey,
  resolveIntegration,
  type IntegrationId,
  type IntegrationState,
} from './catalog';
import { unsandboxServer } from './unsandbox/server';

/**
 * Our server-side registration point for integrations.
 *
 * Routes ask here whether an integration is on (`integrationState`), wrap
 * their handlers so they answer 404 while it is off (`gated`), and hand a
 * session host an integration owns to that integration (`hostIntegration`).
 * The catalog of what exists is `catalog.ts`; pages use `index.ts`.
 */

/** What the boot route lends an integration that boots on its own hosts. */
export interface BootContext {
  /** The system prompt an unattended (yolo) agent is given. */
  agentSystemPrompt: string;
  /** The origin fetch URL of a local checkout, when there is one. */
  localGitRemote: (projectPath: string) => Promise<string | null>;
}

/** What an integration adds to routes that are not its own. */
export interface ServerIntegration {
  /** `POST /api/boot` for one of this integration's hosts. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  boot?: (body: any, projectPath: string, repoUrl: string | undefined, ctx: BootContext) => Promise<Response>;
  /** `POST /api/tmux/upload` for one of this integration's hosts. */
  upload?: (session: string, safeName: string, buf: Buffer) => Promise<Response>;
}

const SERVER: Record<IntegrationId, ServerIntegration> = {
  unsandbox: unsandboxServer,
};

/** Whether an integration is on, and what decided it. */
export function integrationState(id: IntegrationId): IntegrationState {
  let setting: string | null = null;
  try {
    setting = getSetting(integrationSettingKey(id));
  } catch {
    // No database (a fresh box mid-migration): fall back to env or off.
  }
  return resolveIntegration(id, process.env[INTEGRATIONS_ENV], setting);
}

export function integrationEnabled(id: IntegrationId): boolean {
  return integrationState(id).enabled;
}

/** Every integration with its state, for `GET /api/integrations` and Settings. */
export function listIntegrations() {
  return INTEGRATIONS.map((i) => ({ ...i, ...integrationState(i.id) }));
}

/** The answer a route gives for an integration that is off: it is not there. */
export function integrationOff(id: IntegrationId): Response {
  return NextResponse.json(
    {
      error: 'Not found',
      integration: id,
      detail: `The ${id} integration is off. Turn it on in Settings → Integrations, or set ${INTEGRATIONS_ENV}=${id}.`,
    },
    { status: 404 },
  );
}

/** A route handler that answers 404 unless its integration is on. */
export function gated<A extends unknown[]>(
  id: IntegrationId,
  handler: (...args: A) => Response | Promise<Response>,
): (...args: A) => Promise<Response> {
  return async (...args: A) => (integrationEnabled(id) ? handler(...args) : integrationOff(id));
}

/**
 * The integration that owns a session host (`unsandbox`), with whether it is
 * on and what it adds; null for localhost and machines we ssh to.
 */
export function hostIntegration(host: string | null | undefined) {
  const id = integrationForHost(host);
  if (!id) return null;
  return { id, enabled: integrationEnabled(id), server: SERVER[id] };
}
