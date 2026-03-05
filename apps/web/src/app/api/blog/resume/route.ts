import { NextRequest, NextResponse } from 'next/server';

let resumeCache: { data: unknown; fetchedAt: number } | null = null;
const CACHE_TTL = 15 * 60 * 1000; // 15 minutes

export async function GET(req: NextRequest) {
  const url = req.nextUrl.searchParams.get('url');

  // Default to fox's resume
  const resumeUrl = url || 'https://russell.ballestrini.net/uploads/russell.ballestrini.resume.json';

  // Return cached if fresh
  if (resumeCache && Date.now() - resumeCache.fetchedAt < CACHE_TTL) {
    return NextResponse.json(resumeCache.data);
  }

  try {
    const res = await fetch(resumeUrl, {
      headers: { 'Accept': 'application/json' },
      signal: AbortSignal.timeout(10000),
    });

    if (!res.ok) {
      return NextResponse.json(
        { error: `Failed to fetch resume: ${res.status}` },
        { status: 502 }
      );
    }

    const data = await res.json();
    resumeCache = { data, fetchedAt: Date.now() };
    return NextResponse.json(data);
  } catch (err) {
    return NextResponse.json(
      { error: `Resume fetch failed: ${err instanceof Error ? err.message : 'unknown'}` },
      { status: 502 }
    );
  }
}
