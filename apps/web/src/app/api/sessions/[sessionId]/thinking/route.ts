import { harnessFor } from '@unturf/unfirehose/session-paths';
import { streamJsonl } from '@unturf/unfirehose/jsonl-reader';
import { NextRequest, NextResponse } from 'next/server';
import type { ThinkingExcerpt } from '@unturf/unfirehose/types';

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * Pull reasoning excerpts out of a session.
 * Reads raw JSONL through the harness adapter so each line is normalized
 * to canonical unfirehose/1.0 (role-based, content blocks include `reasoning`).
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ sessionId: string }> }
) {
  const { sessionId } = await params;
  const url = new URL(request.url);
  const project = url.searchParams.get('project');

  if (!project) {
    return NextResponse.json({ error: 'project query param required' }, { status: 400 });
  }

  const { adapter, slug } = harnessFor(project);
  const filePath = adapter.sessionFile(slug, sessionId);
  const results: ThinkingExcerpt[] = [];
  let lastUserText = '';

  try {
    for await (const raw of streamJsonl<any>(filePath)) {
      const msg = adapter.normalize(raw);
      if (!msg) continue;

      if (msg.role === 'user') {
        const content = msg.content;
        if (Array.isArray(content)) {
          lastUserText = content
            .filter((b: any) => b.type === 'text')
            .map((b: any) => b.text ?? '')
            .join('\n');
        }
      } else if (msg.role === 'assistant' && Array.isArray(msg.content)) {
        for (const block of msg.content as any[]) {
          if (block.type === 'reasoning' && typeof block.text === 'string') {
            results.push({
              sessionId: msg.sessionId ?? sessionId,
              project,
              timestamp: msg.timestamp ?? '',
              thinking: block.text,
              precedingPrompt: lastUserText,
              model: msg.model ?? undefined,
            });
          }
        }
      }
    }
  } catch (err) {
    return NextResponse.json(
      { error: 'Failed to read session', detail: String(err) },
      { status: 500 }
    );
  }

  return NextResponse.json(results);
}
