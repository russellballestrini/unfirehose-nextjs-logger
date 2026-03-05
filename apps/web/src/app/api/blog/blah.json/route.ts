import { NextResponse } from 'next/server';
import { getPosts, getAllSettings, type PostRow } from '@unfirehose/core/db/ingest';

// Serves the blog as a jsonblog.org-compatible feed (we call ours blah.json)
export async function GET() {
  const settings = getAllSettings();
  const posts = getPosts(100);

  const handle = settings['unfirehose_handle'] || '';
  const displayName = settings['unfirehose_display_name'] || handle;
  const bio = settings['unfirehose_bio'] || '';

  // jsonblog schema: site, basics, posts
  const blogJson = {
    site: {
      title: `${displayName || 'my'} blah`,
      description: bio,
    },
    basics: {
      name: displayName,
      label: handle ? `@${handle}` : undefined,
      url: handle ? `https://unfirehose.com/@${handle}` : undefined,
      summary: bio || undefined,
    },
    posts: posts.map((p: PostRow) => ({
      title: p.title,
      description: p.description,
      source: p.source,
      createdAt: p.created_at,
      updatedAt: p.updated_at,
    })),
    meta: {
      canonical: handle ? `https://unfirehose.com/@${handle}/blah.json` : undefined,
      version: '1.0.0',
      lastModified: posts[0]?.updated_at ?? new Date().toISOString(),
    },
  };

  return NextResponse.json(blogJson, {
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
    },
  });
}
