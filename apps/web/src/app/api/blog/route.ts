import { NextRequest, NextResponse } from 'next/server';
import {
  getPosts,
  createPost,
  deletePost,
} from '@sexy-logger/core/db/ingest';

export async function GET(req: NextRequest) {
  const { searchParams } = req.nextUrl;
  const limit = Number(searchParams.get('limit') ?? 50);
  const offset = Number(searchParams.get('offset') ?? 0);
  const posts = getPosts(limit, offset);
  return NextResponse.json(posts);
}

export async function POST(req: NextRequest) {
  const body = await req.json();
  const { title, description, source, content, url } = body;

  if (!title?.trim()) {
    return NextResponse.json({ error: 'title required' }, { status: 400 });
  }

  const id = createPost({
    title: title.trim(),
    description: description?.trim() || undefined,
    source: source?.trim() || undefined,
    content: content?.trim() || undefined,
    url: url?.trim() || undefined,
  });

  return NextResponse.json({ ok: true, id });
}

export async function DELETE(req: NextRequest) {
  const { id } = await req.json();
  if (!id) return NextResponse.json({ error: 'id required' }, { status: 400 });
  deletePost(id);
  return NextResponse.json({ ok: true });
}
