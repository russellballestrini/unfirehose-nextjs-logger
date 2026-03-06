import { NextRequest, NextResponse } from 'next/server';
import { execFile } from 'child_process';
import { readFile } from 'fs/promises';
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

const DEFAULT_ENDPOINT = 'https://uncloseai.com/v1/chat/completions';
const DEFAULT_MODEL = 'deepseek-r1:32b';

const SYSTEM_PROMPT = `You are a commit message generator. Given a git diff, write a concise, professional commit message.

Rules:
- First line: imperative mood summary, max 72 characters (e.g. "Fix login redirect on expired sessions")
- If the change is complex, add a blank line then a brief body (2-3 lines max)
- Focus on the "why" and "what", not the "how"
- No quotes, no markdown, no prefixes like "feat:" unless the repo uses conventional commits
- No attribution lines
- Just the raw commit message text, nothing else`;

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
  const endpoint = settings.llm_commit_endpoint || DEFAULT_ENDPOINT;
  const apiKey = settings.llm_commit_api_key || '';
  const model = settings.llm_commit_model || DEFAULT_MODEL;

  if (!apiKey && !endpoint.includes('localhost') && !endpoint.includes('127.0.0.1')) {
    return NextResponse.json({
      error: 'No LLM API key configured. Set llm_commit_endpoint, llm_commit_api_key, and llm_commit_model in Settings.',
    }, { status: 400 });
  }

  try {
    // Get the diff
    const diff = await gitExec(repoPath, ['diff', 'HEAD']);
    if (!diff.trim()) {
      return NextResponse.json({ error: 'No changes to describe' }, { status: 400 });
    }

    // Truncate diff if too large (keep first ~8k chars to stay within context)
    const maxDiffLen = 8000;
    const truncatedDiff = diff.length > maxDiffLen
      ? diff.slice(0, maxDiffLen) + `\n\n... (diff truncated, ${diff.length - maxDiffLen} more characters)`
      : diff;

    // Also get the file list for context
    const statusRaw = await gitExec(repoPath, ['status', '--porcelain']);

    const userContent = `Files changed:\n${statusRaw}\n\nDiff:\n${truncatedDiff}`;

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (apiKey) {
      headers['Authorization'] = `Bearer ${apiKey}`;
    }

    const res = await fetch(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model,
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
      return NextResponse.json({
        error: `LLM API returned ${res.status}`,
        detail: errText.slice(0, 500),
      }, { status: 502 });
    }

    const data = await res.json();
    const message = data.choices?.[0]?.message?.content?.trim();

    if (!message) {
      return NextResponse.json({
        error: 'LLM returned empty response',
        detail: JSON.stringify(data).slice(0, 500),
      }, { status: 502 });
    }

    return NextResponse.json({ message });
  } catch (err) {
    return NextResponse.json({ error: 'Failed to generate commit message', detail: String(err) }, { status: 500 });
  }
}
