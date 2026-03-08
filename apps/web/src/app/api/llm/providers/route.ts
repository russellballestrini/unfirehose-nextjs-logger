import { NextResponse } from 'next/server';
import { readFile } from 'fs/promises';
import { homedir } from 'os';
import { join } from 'path';
import { getAllSettings } from '@unturf/unfirehose/db/ingest';

/* eslint-disable @typescript-eslint/no-explicit-any */

interface DetectedProvider {
  id: string;
  name: string;
  source: 'filesystem' | 'settings';
  type: 'anthropic' | 'openai-compatible';
  model: string;
  ready: boolean;
  detail?: string;
}

export async function GET() {
  const providers: DetectedProvider[] = [];
  const settings = getAllSettings() as Record<string, string>;

  // 1. Check Claude Max OAuth token
  try {
    const credPath = join(homedir(), '.claude', '.credentials.json');
    const raw = await readFile(credPath, 'utf-8');
    const creds = JSON.parse(raw);
    const oauth = creds?.claudeAiOauth;
    if (oauth?.accessToken) {
      const expired = oauth.expiresAt <= Date.now();
      providers.push({
        id: 'claude-max',
        name: `Claude Max (${oauth.subscriptionType ?? 'oauth'})`,
        source: 'filesystem',
        type: 'anthropic',
        model: settings.llm_commit_model || 'claude-haiku-4-5-20251001',
        ready: !expired,
        detail: expired
          ? `Token expired ${new Date(oauth.expiresAt).toISOString()}`
          : `~/.claude/.credentials.json — expires ${new Date(oauth.expiresAt).toISOString()}`,
      });
    }
  } catch {
    // no claude credentials
  }

  // 2. Check user-configured provider
  if (settings.llm_commit_endpoint || settings.llm_commit_api_key) {
    const endpoint = settings.llm_commit_endpoint || 'https://api.openai.com/v1/chat/completions';
    const hasKey = !!settings.llm_commit_api_key;
    const isLocal = endpoint.includes('localhost') || endpoint.includes('127.0.0.1');

    providers.push({
      id: 'custom',
      name: 'Custom Provider',
      source: 'settings',
      type: 'openai-compatible',
      model: settings.llm_commit_model || 'gpt-4o-mini',
      ready: hasKey || isLocal,
      detail: endpoint,
    });
  }

  // 3. Auto-detect Qwen 3 Coder on the mesh (no keys needed)
  try {
    const res = await fetch('https://qwen.ai.unturf.com/v1/models', { signal: AbortSignal.timeout(3000) });
    if (res.ok) {
      const data = await res.json();
      const model = data?.data?.[0]?.id;
      if (model) {
        providers.push({
          id: 'qwen-mesh',
          name: 'Qwen 3 Coder (mesh)',
          source: 'filesystem',
          type: 'openai-compatible',
          model,
          ready: true,
          detail: 'https://qwen.ai.unturf.com — local mesh inference, no API key',
        });
      }
    }
  } catch { /* mesh unreachable */ }

  return NextResponse.json({ providers });
}
