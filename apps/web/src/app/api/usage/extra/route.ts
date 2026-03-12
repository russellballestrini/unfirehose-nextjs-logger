import { NextRequest, NextResponse } from 'next/server';
import { setSetting, getSetting } from '@unturf/unfirehose/db/ingest';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS });
}

export async function GET() {
  return NextResponse.json({
    extraSpent:     getSetting('extra_usage_spent')     ?? null,
    extraLimit:     getSetting('extra_usage_limit')     ?? null,
    extraBalance:   getSetting('extra_usage_balance')   ?? null,
    extraResetDate: getSetting('extra_usage_reset_date') ?? null,
    extraUpdatedAt: getSetting('extra_usage_updated_at') ?? null,
  }, { headers: CORS });
}

export async function POST(req: NextRequest) {
  const body = await req.json();
  const { spent, limit, balance, resetDate } = body;

  if (spent   !== undefined) setSetting('extra_usage_spent',      String(spent));
  if (limit   !== undefined) setSetting('extra_usage_limit',      String(limit));
  if (balance !== undefined) setSetting('extra_usage_balance',    String(balance));
  if (resetDate !== undefined) setSetting('extra_usage_reset_date', String(resetDate));
  setSetting('extra_usage_updated_at', new Date().toISOString());

  return NextResponse.json({ ok: true }, { headers: CORS });
}
