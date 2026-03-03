import { claudePaths } from '@/lib/claude-paths';
import { createJsonlReadableStream, collectJsonl } from '@/lib/jsonl-reader';
import { NextRequest, NextResponse } from 'next/server';
import { stat } from 'fs/promises';

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

  const filePath = claudePaths.sessionFile(project, sessionId);

  try {
    await stat(filePath);
  } catch {
    return NextResponse.json(
      { error: 'Session file not found', path: filePath },
      { status: 404 }
    );
  }

  const types = typesParam?.split(',') ?? undefined;

  if (isStream) {
    const readable = createJsonlReadableStream(filePath, {
      types,
      offset,
      limit,
    });
    return new Response(readable, {
      headers: {
        'Content-Type': 'application/x-ndjson',
        'Transfer-Encoding': 'chunked',
        'Cache-Control': 'no-cache',
      },
    });
  }

  const entries = await collectJsonl(filePath, { types, offset, limit });
  return NextResponse.json({ entries, count: entries.length, offset, limit });
}
