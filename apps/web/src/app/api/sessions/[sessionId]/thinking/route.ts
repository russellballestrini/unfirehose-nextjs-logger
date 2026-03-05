import { claudePaths } from '@unfirehose/core/claude-paths';
import { streamJsonl } from '@unfirehose/core/jsonl-reader';
import { NextRequest, NextResponse } from 'next/server';
import type { ThinkingExcerpt, ContentBlock } from '@unfirehose/core/types';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyEntry = any;

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ sessionId: string }> }
) {
  const { sessionId } = await params;
  const url = new URL(request.url);
  const project = url.searchParams.get('project');

  if (!project) {
    return NextResponse.json(
      { error: 'project query param required' },
      { status: 400 }
    );
  }

  const filePath = claudePaths.sessionFile(project, sessionId);
  const results: ThinkingExcerpt[] = [];
  let lastUserText = '';

  try {
    for await (const entry of streamJsonl(filePath, {
      types: ['user', 'assistant'],
    })) {
      const e = entry as AnyEntry;
      if (e.type === 'user') {
        const content = e.message.content;
        if (typeof content === 'string') {
          lastUserText = content;
        } else if (Array.isArray(content)) {
          lastUserText = content
            .filter((b: ContentBlock) => b.type === 'text')
            .map((b) => ('text' in b ? b.text : ''))
            .join('\n');
        }
      } else if (e.type === 'assistant' && Array.isArray(e.message.content)) {
        for (const block of e.message.content) {
          if (block.type === 'thinking' && 'thinking' in block) {
            results.push({
              sessionId: e.sessionId,
              project,
              timestamp: e.timestamp ?? '',
              thinking: block.thinking,
              precedingPrompt: lastUserText,
              model: e.message.model,
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
