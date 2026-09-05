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

  // 4. Fallback: Qwen 3 Coder on the mesh — code-specialized, best for commit messages/PRs
  try {
    const res = await fetch('https://qwen.ai.unturf.com/v1/models', { signal: AbortSignal.timeout(3000) });
    if (res.ok) {
      const data = await res.json();
      const model = data?.data?.[0]?.id;
      if (model) {
        return {
          type: 'openai-compatible',
          endpoint: 'https://qwen.ai.unturf.com/v1/chat/completions',
          apiKey: '',
          model,
          source: 'qwen-mesh',
        };
      }
    }
  } catch { /* mesh unreachable, skip */ }

  // 5. Fallback: Hermes 3 on the mesh — general purpose
  try {
    const res = await fetch('https://hermes.ai.unturf.com/v1/models', { signal: AbortSignal.timeout(3000) });
    if (res.ok) {
      const data = await res.json();
      const model = data?.data?.[0]?.id;
      if (model) {
        return {
          type: 'openai-compatible',
          endpoint: 'https://hermes.ai.unturf.com/v1/chat/completions',
          apiKey: '',
          model,
          source: 'hermes-mesh',
        };
      }
    }
  } catch { /* mesh unreachable, skip */ }

  return null;
}
