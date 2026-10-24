/**
 * Integrations: optional, separately-run products this app can talk to.
 *
 * An integration lives in one directory, `src/integrations/<id>/`, and is off
 * until someone turns it on. Nothing outside `src/integrations/` imports from
 * that directory except our thin route wrappers under `app/api/<id>/`, so
 * removing an integration is deleting its directory, its route wrappers, and
 * its line in this catalog and in the two registries beside it
 * (`index.ts` for pages, `server.ts` for routes). `boundary.test.ts`
 * enforces the import rule.
 *
 * This file is plain data so both sides can read it: a page never pulls in
 * server code, and a route never pulls in a React component.
 *
 * The switch, per integration:
 *   - `UNFIREHOSE_INTEGRATIONS` in the environment, a comma- or
 *     space-separated list of ids (`UNFIREHOSE_INTEGRATIONS=unsandbox`), wins
 *     when set: listed ids are on, every other id is off, and the Settings
 *     toggle is shown locked. `none` turns every integration off.
 *   - Otherwise the settings key `integration_<id>` (`'true'` is on), which
 *     Settings → Integrations writes.
 *   - Otherwise off.
 */

export const INTEGRATIONS_ENV = 'UNFIREHOSE_INTEGRATIONS';

export interface IntegrationInfo {
  id: string;
  /** What Settings calls it. */
  name: string;
  /** One sentence: what turning it on adds. */
  summary: string;
  /** Session hosts this integration owns, as `?host=` and boot targets spell them. */
  hosts: readonly string[];
  /** Where to learn more. */
  href?: string;
}

export const INTEGRATIONS = [
  {
    id: 'unsandbox',
    name: 'unsandbox.com',
    summary:
      'Cloud containers as a mesh node: boot a harness in one, open its shell under Terminals, sync its sessions back for ingest. Needs a key pair from unsandbox.com; its requests are signed with them.',
    hosts: ['unsandbox'],
    href: 'https://unsandbox.com',
  },
] as const satisfies readonly IntegrationInfo[];

export type IntegrationId = (typeof INTEGRATIONS)[number]['id'];

export const INTEGRATION_IDS: readonly IntegrationId[] = INTEGRATIONS.map((i) => i.id);

export function integrationSettingKey(id: IntegrationId): string {
  return `integration_${id}`;
}

export function isIntegrationId(id: unknown): id is IntegrationId {
  return typeof id === 'string' && (INTEGRATION_IDS as readonly string[]).includes(id);
}

/** Which integration owns a session host, whether or not it is on. */
export function integrationForHost(host: string | null | undefined): IntegrationId | null {
  if (!host) return null;
  const hit = INTEGRATIONS.find((i) => (i.hosts as readonly string[]).includes(host));
  return hit ? hit.id : null;
}

export type IntegrationSource = 'env' | 'setting' | 'default';

export interface IntegrationState {
  enabled: boolean;
  source: IntegrationSource;
}

/**
 * The ids an `UNFIREHOSE_INTEGRATIONS` value turns on, or null when it is
 * unset or blank (and so decides nothing).
 */
export function parseIntegrationsEnv(raw: string | undefined): Set<string> | null {
  if (raw === undefined || raw.trim() === '') return null;
  const ids = raw.split(/[\s,]+/).map((s) => s.trim().toLowerCase()).filter(Boolean);
  return new Set(ids.filter((s) => s !== 'none'));
}

/** The flag for one integration, from an env value and a stored setting. */
export function resolveIntegration(
  id: IntegrationId,
  envRaw: string | undefined,
  setting: string | null | undefined,
): IntegrationState {
  const env = parseIntegrationsEnv(envRaw);
  if (env) return { enabled: env.has(id), source: 'env' };
  if (setting === 'true') return { enabled: true, source: 'setting' };
  if (setting === 'false') return { enabled: false, source: 'setting' };
  return { enabled: false, source: 'default' };
}
