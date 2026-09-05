/**
 * Which model writes our commit message, and on whose credential.
 *
 * The order here is the whole decision: an endpoint the user configured
 * wins, then a Claude Max token already on this machine, then a bare API
 * key, then two unauthenticated models on our own mesh. The last two are
 * why this can answer at all on a fresh install — without them, a machine
 * with no key configured gets nothing rather than a free local model.
 *
 * Nothing here reads a credential it was not pointed at, and nothing logs
 * one. The token this returns goes straight into an Authorization header.
 *
 * Separate from the route because Next validates a `route.ts` export
 * surface, so nothing defined there can be reached by a test.
 */

import { readFile } from 'fs/promises';
import { homedir } from 'os';
import { join } from 'path';

export interface LlmProvider {
  type: 'anthropic' | 'openai-compatible';
  endpoint: string;
  apiKey: string;
  model: string;
  /** Which rule above answered — shown in the UI so the cost is legible. */
  source: string;
}

// Auto-detect Claude Max OAuth token from filesystem
export async function getClaudeMaxToken(): Promise<{ accessToken: string; expiresAt: number } | null> {
  try {
    const credPath = join(homedir(), '.claude', '.credentials.json');
    const raw = await readFile(credPath, 'utf-8');
    const creds = JSON.parse(raw);
    const oauth = creds?.claudeAiOauth;
    if (oauth?.accessToken && oauth?.expiresAt > Date.now()) {
      return { accessToken: oauth.accessToken, expiresAt: oauth.expiresAt };
    }
    return null;
  } catch {
    return null;
  }
}


/**
 * Models on our own mesh, in the order we would rather use them.
 *
 * Both were written out twice, twenty lines each, differing only in a
 * hostname and a label — which is how one of them would eventually get a
 * timeout change the other did not.
 */
const MESH_FALLBACKS: ReadonlyArray<readonly [host: string, source: string]> = [
  ['qwen.ai.unturf.com', 'qwen-mesh'],
  ['hermes.ai.unturf.com', 'hermes-mesh'],
];

/**
 * The first model a mesh box will admit to serving, or null.
 *
 * A box that is up but has loaded nothing answers with an empty list, and
 * that is the same as being down for our purposes: there is no model to
 * name in a request.
 */
async function firstModelOn(host: string): Promise<string | null> {
  try {
    const res = await fetch(`https://${host}/v1/models`, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) return null;
    const data = await res.json();
    return data?.data?.[0]?.id ?? null;
  } catch {
    // Mesh unreachable. Not an error — this is a fallback.
    return null;
  }
}

export async function resolveProvider(settings: Record<string, string>, vaultKey?: string): Promise<LlmProvider | null> {
  // 1. User-configured provider + vault key takes priority
  if (settings.llm_commit_endpoint) {
    const apiKey = vaultKey || settings.llm_commit_api_key || '';
    const isLocal = settings.llm_commit_endpoint.includes('localhost') || settings.llm_commit_endpoint.includes('127.0.0.1');
    if (!apiKey && !isLocal) return null;
    return {
      type: 'openai-compatible',
      endpoint: settings.llm_commit_endpoint,
      apiKey,
      model: settings.llm_commit_model || 'gpt-4o-mini',
      source: 'vault',
    };
  }

  // 2. Auto-detect Claude Max OAuth token
  const claude = await getClaudeMaxToken();
  if (claude) {
    return {
      type: 'anthropic',
      endpoint: 'https://api.anthropic.com/v1/messages',
      apiKey: claude.accessToken,
      model: settings.llm_commit_model || 'claude-haiku-4-5-20251001',
      source: 'claude-max',
    };
  }

  // 3. User has an API key but no endpoint (assume OpenAI)
  if (settings.llm_commit_api_key) {
    return {
      type: 'openai-compatible',
      endpoint: 'https://api.openai.com/v1/chat/completions',
      apiKey: settings.llm_commit_api_key,
      model: settings.llm_commit_model || 'gpt-4o-mini',
      source: 'settings',
    };
  }

  // 4 and 5. Our own mesh, in preference order: the code model first
  // because these are commit messages, then the general one. Both are
  // unauthenticated, which is what makes a fresh install work at all.
  for (const [host, source] of MESH_FALLBACKS) {
    const model = await firstModelOn(host);
    if (model) {
      return {
        type: 'openai-compatible',
        endpoint: `https://${host}/v1/chat/completions`,
        apiKey: '',
        model,
        source,
      };
    }
  }

  return null;
}
