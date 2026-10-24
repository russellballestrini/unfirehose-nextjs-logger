import { describe, it, expect } from 'vitest';
import { findSecrets, mayHoldSecret, redactSecrets } from './pii';

/**
 * Credentials, as the action ledger looks for them. Fixtures are assembled
 * at runtime so no literal credential sits in the source for a scanner to
 * find, which is also why this file exists apart from pii.test.ts.
 */

const gh = 'ghp' + '_' + 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8';
const ant = 'sk-ant-' + 'api03-' + 'Zq8xW2vB7nM4kL9pR3tY6uE1oA5sD0fG';
const pem = '-----BEGIN ' + 'OPENSSH PRIVATE KEY-----';

describe('findSecrets', () => {
  it('finds vendor-shaped tokens by kind', () => {
    expect(findSecrets(`token=${gh}`).map((s) => s.kind)).toEqual(['github_token']);
    expect(findSecrets(`ANTHROPIC_API_KEY=${ant}`).map((s) => s.kind)).toEqual(['anthropic_key']);
    expect(findSecrets(`${pem}\nb3BlbnNzaC1rZXk=\n`).map((s) => s.kind)).toEqual(['private_key']);
    expect(findSecrets('AKIA' + 'IOSFODNN7EXAMPLE').map((s) => s.kind)).toEqual(['aws_access_key']);
  });

  it('finds a credential-named assignment only when its value looks random', () => {
    expect(findSecrets('DB_PASSWORD=Hk38dPq0zLm2Wv9x').map((s) => s.kind)).toEqual(['assigned_secret']);
    expect(findSecrets('DB_PASSWORD=changeme-changeme')).toEqual([]);
    expect(findSecrets('API_KEY=your-api-key-here-123')).toEqual([]);
    expect(findSecrets('const apiKey = process.env.API_KEY')).toEqual([]);
    expect(findSecrets('placeholder: sk-ant-...')).toEqual([]);
    expect(findSecrets('')).toEqual([]);
  });

  it('never reports two overlapping spans', () => {
    const hits = findSecrets(`ANTHROPIC_API_KEY=${ant} and OPENAI_API_KEY=${ant}`);
    for (let i = 1; i < hits.length; i++) expect(hits[i].start).toBeGreaterThanOrEqual(hits[i - 1].end);
  });
});

describe('mayHoldSecret', () => {
  // One example per kind findSecrets knows; the prefilter must pass each,
  // or findSecrets would never look at it.
  const r = 'Zq8xW2vB7nM4kL9pR3tY6uE1oA5sD0fGh2Jk';
  const examples: Record<string, string> = {
    private_key: pem,
    aws_access_key: 'AKIA' + 'IOSFODNN7EXAMPLE',
    github_token: gh,
    gitlab_token: 'glpat' + '-' + r.slice(0, 24),
    anthropic_key: ant,
    openai_key: 'sk' + '-proj-' + r,
    unsandbox_key: 'unsb' + '-sk-' + r.slice(0, 20),
    slack_token: 'xox' + 'b-' + r.slice(0, 20),
    stripe_key: 'sk' + '_live_' + r.slice(0, 24),
    google_api_key: 'AIza' + r.slice(0, 35).padEnd(35, 'x'),
    npm_token: 'npm' + '_' + (r + r).slice(0, 36),
    bearer_token: 'Authorization: Bearer ' + r,
    assigned_secret: 'DB_PASSWORD=Hk38dPq0zLm2Wv9x',
  };

  it.each(Object.entries(examples))('passes every %s findSecrets would report', (kind, text) => {
    expect(findSecrets(text).map((s) => s.kind)).toContain(kind);
    expect(mayHoldSecret(text)).toBe(true);
  });

  it('turns away ordinary tool output in one scan', () => {
    expect(mayHoldSecret('total 48\ndrwxr-xr-x  5 fox fox 4096 Oct 24 README.md\n')).toBe(false);
    expect(mayHoldSecret('')).toBe(false);
  });
});

describe('redactSecrets', () => {
  it('replaces each credential by kind and leaves the rest', () => {
    expect(redactSecrets(`curl -H "Authorization: Bearer ${gh}" https://api.github.com`))
      .toBe('curl -H "Authorization: Bearer __SECRET_GITHUB_TOKEN__" https://api.github.com');
    expect(redactSecrets('nothing here')).toBe('nothing here');
  });
});
