import { NextRequest, NextResponse } from 'next/server';
import { execFile } from 'child_process';
import { readFile } from 'fs/promises';
import { homedir } from 'os';
import { join } from 'path';
import { getAllSettings } from '@unfirehose/core/db/ingest';
import { claudePaths } from '@unfirehose/core/claude-paths';
import type { SessionsIndex } from '@unfirehose/core/types';

/* eslint-disable @typescript-eslint/no-explicit-any */

function gitExec(cwd: string, args: string[], timeout = 10000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, timeout, maxBuffer: 1024 * 1024 * 5 }, (err, stdout) => {
      if (err) reject(err);
      else resolve(stdout);
    });
  });
}

async function resolveRepoPath(projectName: string): Promise<string | null> {
  try {
    const raw = await readFile(claudePaths.sessionsIndex(projectName), 'utf-8');
    const index: SessionsIndex = JSON.parse(raw);
    return index.originalPath ?? null;
  } catch {
    return null;
  }
}

// Auto-detect Claude Max OAuth token from filesystem
async function getClaudeMaxToken(): Promise<{ accessToken: string; expiresAt: number } | null> {
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

interface LlmProvider {
  type: 'anthropic' | 'openai-compatible';
  endpoint: string;
  apiKey: string;
  model: string;
  source: string; // 'claude-max' | 'settings' | etc
}

async function resolveProvider(settings: Record<string, string>): Promise<LlmProvider | null> {
  // 1. User-configured provider takes priority
  if (settings.llm_commit_endpoint) {
    const apiKey = settings.llm_commit_api_key || '';
    const isLocal = settings.llm_commit_endpoint.includes('localhost') || settings.llm_commit_endpoint.includes('127.0.0.1');
    if (!apiKey && !isLocal) return null;
    return {
      type: 'openai-compatible',
      endpoint: settings.llm_commit_endpoint,
      apiKey,
      model: settings.llm_commit_model || 'gpt-4o-mini',
      source: 'settings',
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

  return null;
}

const SYSTEM_PROMPT = `You are a commit message generator. Given a git diff, write a concise, professional commit message.

Rules:
- First line: imperative mood summary, max 72 characters (e.g. "Fix login redirect on expired sessions")
- If the change is complex, add a blank line then a brief body (2-3 lines max)
- Focus on the "why" and "what", not the "how"
- No quotes, no markdown, no prefixes like "feat:" unless the repo uses conventional commits
- No attribution lines
- Just the raw commit message text, nothing else`;

async function callAnthropic(provider: LlmProvider, userContent: string): Promise<string> {
  const res = await fetch(provider.endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': provider.apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: provider.model,
      max_tokens: 300,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userContent }],
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Anthropic API returned ${res.status}: ${errText.slice(0, 500)}`);
  }

  const data = await res.json();
  const text = data.content?.[0]?.text?.trim();
  if (!text) throw new Error('Anthropic returned empty response');
  return text;
}

async function callOpenAI(provider: LlmProvider, userContent: string): Promise<string> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (provider.apiKey) headers['Authorization'] = `Bearer ${provider.apiKey}`;

  const res = await fetch(provider.endpoint, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model: provider.model,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: userContent },
      ],
      max_tokens: 300,
      temperature: 0.3,
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`LLM API returned ${res.status}: ${errText.slice(0, 500)}`);
  }

  const data = await res.json();
  const text = data.choices?.[0]?.message?.content?.trim();
  if (!text) throw new Error('LLM returned empty response');
  return text;
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ project: string }> }
) {
  const { project } = await params;
  const repoPath = await resolveRepoPath(project);
  if (!repoPath) {
    return NextResponse.json({ error: 'Could not resolve repo path' }, { status: 404 });
  }

  const settings = getAllSettings() as Record<string, string>;
  const provider = await resolveProvider(settings);

  if (!provider) {
    return NextResponse.json({
      error: 'No LLM provider available. Configure one in Settings, or sign in to Claude Code Max.',
      providers: [],
    }, { status: 400 });
  }

  try {
    const diff = await gitExec(repoPath, ['diff', 'HEAD']);
    if (!diff.trim()) {
      return NextResponse.json({ error: 'No changes to describe' }, { status: 400 });
    }

    const maxDiffLen = 8000;
    const truncatedDiff = diff.length > maxDiffLen
      ? diff.slice(0, maxDiffLen) + `\n\n... (diff truncated, ${diff.length - maxDiffLen} more characters)`
      : diff;

    const statusRaw = await gitExec(repoPath, ['status', '--porcelain']);
    const userContent = `Files changed:\n${statusRaw}\n\nDiff:\n${truncatedDiff}`;

    const message = provider.type === 'anthropic'
      ? await callAnthropic(provider, userContent)
      : await callOpenAI(provider, userContent);

    return NextResponse.json({ message, provider: provider.source });
  } catch (err) {
    return NextResponse.json({ error: 'Failed to generate commit message', detail: String(err) }, { status: 500 });
  }
}
