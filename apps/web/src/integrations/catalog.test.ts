import { describe, it, expect } from 'vitest';
import {
  INTEGRATIONS, INTEGRATION_IDS, integrationForHost, integrationSettingKey,
  isIntegrationId, parseIntegrationsEnv, resolveIntegration,
} from './catalog';

/**
 * The switch every integration sits behind.
 *
 * Off is the default, so a fresh install talks to nobody it was not told
 * to. The environment, when set, is the whole answer — a deploy that says
 * which integrations run should not be overruled by a row somebody toggled
 * in a database — and otherwise the Settings toggle decides.
 */

const id = INTEGRATION_IDS[0];

describe('resolveIntegration', () => {
  it('is off with nothing said', () => {
    expect(resolveIntegration(id, undefined, null)).toEqual({ enabled: false, source: 'default' });
  });

  it('follows the setting when the environment is silent', () => {
    expect(resolveIntegration(id, undefined, 'true')).toEqual({ enabled: true, source: 'setting' });
    expect(resolveIntegration(id, '', 'true')).toEqual({ enabled: true, source: 'setting' });
    expect(resolveIntegration(id, undefined, 'false')).toEqual({ enabled: false, source: 'setting' });
  });

  it('lets the environment decide when it is set, either way', () => {
    expect(resolveIntegration(id, id, null)).toEqual({ enabled: true, source: 'env' });
    expect(resolveIntegration(id, `other, ${id.toUpperCase()}`, 'false').enabled).toBe(true);
    expect(resolveIntegration(id, 'none', 'true')).toEqual({ enabled: false, source: 'env' });
    expect(resolveIntegration(id, 'something-else', 'true')).toEqual({ enabled: false, source: 'env' });
  });

  it('treats only the string true as on', () => {
    expect(resolveIntegration(id, undefined, '1').enabled).toBe(false);
  });
});

describe('parseIntegrationsEnv', () => {
  it('reads commas and spaces, and an empty value as unset', () => {
    expect(parseIntegrationsEnv('a, b c')).toEqual(new Set(['a', 'b', 'c']));
    expect(parseIntegrationsEnv('  ')).toBeNull();
    expect(parseIntegrationsEnv(undefined)).toBeNull();
    expect(parseIntegrationsEnv('none')).toEqual(new Set());
  });
});

describe('the catalog', () => {
  it('names each integration once, with a settings key of its own', () => {
    expect(new Set(INTEGRATION_IDS).size).toBe(INTEGRATIONS.length);
    for (const i of INTEGRATIONS) {
      expect(isIntegrationId(i.id)).toBe(true);
      expect(integrationSettingKey(i.id)).toBe(`integration_${i.id}`);
    }
    expect(isIntegrationId('not-one')).toBe(false);
  });

  it('claims no host a machine we ssh to could have', () => {
    expect(integrationForHost('localhost')).toBeNull();
    expect(integrationForHost('cammy.foxhop.net')).toBeNull();
    expect(integrationForHost(undefined)).toBeNull();
    for (const i of INTEGRATIONS) for (const h of i.hosts) expect(integrationForHost(h)).toBe(i.id);
  });
});
