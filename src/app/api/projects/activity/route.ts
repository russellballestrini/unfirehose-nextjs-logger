import { NextRequest, NextResponse } from 'next/server';
import { getProjectActivity, getProjectRecentPrompts } from '@/lib/db/ingest';

/* eslint-disable @typescript-eslint/no-explicit-any */

// Average blended rate for rough per-project cost estimates (2026 Opus rates)
const AVG_RATE = { input: 5, output: 25, cacheRead: 0.50, cacheWrite: 6.25 };

export async function GET(request: NextRequest) {
  try {
    const days = Number(request.nextUrl.searchParams.get('days') ?? '30');
    const project = request.nextUrl.searchParams.get('project');

    const activity = getProjectActivity(days) as any[];

    // Compute per-project cost estimates using blended rate
    const enriched = activity.map((p: any) => {
      const costEstimate =
        ((p.total_input ?? 0) / 1_000_000) * AVG_RATE.input +
        ((p.total_output ?? 0) / 1_000_000) * AVG_RATE.output +
        ((p.total_cache_read ?? 0) / 1_000_000) * AVG_RATE.cacheRead +
        ((p.total_cache_write ?? 0) / 1_000_000) * AVG_RATE.cacheWrite;

      return {
        ...p,
        cost_estimate: Math.round(costEstimate * 100) / 100,
      };
    });

    // If a specific project is requested, include recent prompts
    if (project) {
      const prompts = getProjectRecentPrompts(project, 10);
      const proj = enriched.find((p: any) => p.name === project);
      return NextResponse.json({
        project: proj ?? null,
        recentPrompts: prompts.map((p) => ({
          prompt: (p.prompt ?? '').slice(0, 200),
          timestamp: p.timestamp,
          sessionId: p.session_uuid,
          response: (p.response ?? '').slice(0, 2000) || null,
        })),
      });
    }

    return NextResponse.json(enriched);
  } catch (err) {
    return NextResponse.json(
      { error: 'Failed to get activity', detail: String(err) },
      { status: 500 }
    );
  }
}
