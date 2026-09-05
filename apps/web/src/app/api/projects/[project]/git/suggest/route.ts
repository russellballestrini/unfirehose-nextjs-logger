import { NextRequest, NextResponse } from 'next/server';
import { execFile } from 'child_process';
import { readFile } from 'fs/promises';
import { homedir } from 'os';
import { join } from 'path';
import { getAllSettings } from '@unturf/unfirehose/db/ingest';
import { repoPathForProject } from '@unturf/unfirehose/db/repo-path';
import { gitExec } from '@unturf/unfirehose/git-exec';
import { resolveProvider, type LlmProvider } from '@/lib/llm-provider';


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
  const repoPath = repoPathForProject(project);
  if (!repoPath) {
    return NextResponse.json({ error: 'Could not resolve repo path' }, { status: 404 });
  }

  const settings = getAllSettings() as Record<string, string>;
  // Vault key passed from browser (decrypted client-side, sent per-request)
  const vaultKey = request.headers.get('x-vault-api-key') || undefined;
  const provider = await resolveProvider(settings, vaultKey);

  if (!provider) {
    return NextResponse.json({
      error: 'No LLM provider available. Configure one in Settings, or sign in to Claude Code Max.',
      providers: [],
    }, { status: 400 });
  }

  try {
    const statusRaw = await gitExec(repoPath, ['status', '--porcelain']);
    if (!statusRaw.trim()) {
      return NextResponse.json({ error: 'No changes to describe' }, { status: 400 });
    }

    // git diff HEAD for tracked changes, plus diff of untracked files
    let diff = '';
    try { diff = await gitExec(repoPath, ['diff', 'HEAD']); } catch {}

    // For untracked files, try to show their content (first 2000 chars each)
    const untrackedFiles = statusRaw.trim().split('\n')
      .filter(l => l.startsWith('??'))
      .map(l => l.slice(3));
    for (const f of untrackedFiles.slice(0, 5)) {
      try {
        const raw = await readFile(repoPath + '/' + f, 'utf-8').catch(() => '(binary or unreadable)');
        diff += `\n--- /dev/null\n+++ b/${f}\n${raw.slice(0, 2000).split('\n').map((l: string) => '+' + l).join('\n')}\n`;
      } catch {}
    }

    if (!diff.trim() && !statusRaw.trim()) {
      return NextResponse.json({ error: 'No changes to describe' }, { status: 400 });
    }

    const maxDiffLen = 8000;
    const truncatedDiff = diff.length > maxDiffLen
      ? diff.slice(0, maxDiffLen) + `\n\n... (diff truncated, ${diff.length - maxDiffLen} more characters)`
      : diff;

    const userContent = `Files changed:\n${statusRaw}\n\nDiff:\n${truncatedDiff || '(no diff available — files may be untracked/binary)'}`;

    const message = provider.type === 'anthropic'
      ? await callAnthropic(provider, userContent)
      : await callOpenAI(provider, userContent);

    return NextResponse.json({ message, provider: provider.source });
  } catch (err) {
    return NextResponse.json({ error: 'Failed to generate commit message', detail: String(err) }, { status: 500 });
  }
}
