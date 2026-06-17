import { harnessFor } from '@unturf/unfirehose/session-paths';
import { streamJsonl } from '@unturf/unfirehose/jsonl-reader';
import { NextRequest, NextResponse } from 'next/server';
import { stat } from 'fs/promises';

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * Stream or collect a session's messages as canonical unfirehose/1.0 entries.
 * The harness adapter resolves the on-disk JSONL path and normalizes the source
 * shape (claude-code, uncloseai-cli, etc.) into unfirehose/1.0 before emit.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ sessionId: string }> }
) {
  const { sessionId } = await params;
  const url = new URL(request.url);
  const project = url.searchParams.get('project');
  const typesParam = url.searchParams.get('types');
  const offset = parseInt(url.searchParams.get('offset') ?? '0');
  const limit = parseInt(url.searchParams.get('limit') ?? '500');
  const isStream = url.searchParams.get('stream') === 'true';

  if (!project) {
    return NextResponse.json(
      { error: 'project query param required' },
      { status: 400 }
    );
  }

  const { adapter, slug } = harnessFor(project);
  const filePath = adapter.sessionFile(slug, sessionId);

  try {
    await stat(filePath);
  } catch {
    return NextResponse.json(
      { error: 'Session file not found', path: filePath, harness: adapter.name },
      { status: 404 }
    );
  }

  // `types` filter operates on the canonical role: user, assistant, system, tool.
  // Default: all roles. Front-end can pass e.g. types=user,assistant.
  const roleFilter = typesParam
    ? new Set(typesParam.split(',').map((t) => t.trim()).filter(Boolean))
    : null;

  async function* normalized(): AsyncGenerator<any> {
    // Raw lines — no type filter at reader level (the filter must run after normalize).
    let matched = 0;
    let emitted = 0;
    for await (const raw of streamJsonl<any>(filePath)) {
      const msg = adapter.normalize(raw);
      if (!msg) continue;
      if (roleFilter && !roleFilter.has(msg.role)) continue;
      matched++;
      if (matched <= offset) continue;
      yield msg;
      emitted++;
      if (emitted >= limit) break;
    }
  }

  if (isStream) {
    const encoder = new TextEncoder();
    const gen = normalized();
    const readable = new ReadableStream({
      async pull(controller) {
        const { done, value } = await gen.next();
        if (done) {
          controller.close();
          return;
        }
        controller.enqueue(encoder.encode(JSON.stringify(value) + '\n'));
      },
      cancel() {
        gen.return(undefined);
      },
    });
    return new Response(readable, {
      headers: {
        'Content-Type': 'application/x-ndjson',
        'Transfer-Encoding': 'chunked',
        'Cache-Control': 'no-cache',
      },
    });
  }

  const entries: any[] = [];
  for await (const msg of normalized()) entries.push(msg);
  return NextResponse.json({ entries, count: entries.length, offset, limit });
}
