import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@unturf/unfirehose/db/schema';
import { getSessionChains } from '@unturf/unfirehose/db/provenance-ingest';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

/**
 * GET /api/sessions/chains?ids=a,b,c
 *
 * The chain verdict and witness state for many sessions in one call —
 * what a list view needs beside each session id. A session the
 * ingester has not recorded yet is simply absent from the answer.
 */
export async function GET(request: NextRequest) {
  const raw = request.nextUrl.searchParams.get('ids') ?? '';
  const ids = raw.split(',').map((s) => s.trim()).filter(Boolean).slice(0, 2000);
  if (ids.length === 0) return NextResponse.json({ chains: {} });
  return NextResponse.json({ chains: getSessionChains(getDb(), ids) });
}
