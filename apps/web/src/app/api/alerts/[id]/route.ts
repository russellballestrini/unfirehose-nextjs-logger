import { NextRequest, NextResponse } from 'next/server';
import {
  getAlertById,
  getUsageByProjectInWindow,
  getModelBreakdownInWindow,
  getActiveSessionsInWindow,
  getThinkingBlocksInWindow,
  getTimelineInWindow,
  getUserPromptsInWindow,
} from '@sexy-logger/core/db/ingest';

// 2026 blended rates (same as /api/projects/activity)
const AVG_RATE = { input: 5, output: 25, cacheRead: 0.50, cacheWrite: 6.25 };

function computeCost(input: number, output: number, cacheRead: number, cacheWrite: number): number {
  return (
    (input / 1_000_000) * AVG_RATE.input +
    (output / 1_000_000) * AVG_RATE.output +
    (cacheRead / 1_000_000) * AVG_RATE.cacheRead +
    (cacheWrite / 1_000_000) * AVG_RATE.cacheWrite
  );
}

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: idStr } = await params;
  const id = parseInt(idStr, 10);
  if (isNaN(id)) {
    return NextResponse.json({ error: 'Invalid alert ID' }, { status: 400 });
  }

  try {
    const alert = getAlertById(id);
    if (!alert) {
      return NextResponse.json({ error: 'Alert not found' }, { status: 404 });
    }

    // Compute window boundaries
    let windowStart: string;
    const windowEnd = alert.triggered_at;

    try {
      const details = JSON.parse(alert.details ?? '{}');
      windowStart = details.windowStart ?? '';
    } catch {
      windowStart = '';
    }

    // Fallback: compute from triggered_at - window_minutes
    if (!windowStart) {
      const endDate = new Date(windowEnd);
      windowStart = new Date(endDate.getTime() - alert.window_minutes * 60_000)
        .toISOString()
        .slice(0, 16);
    }

    // For usage_minutes queries (minute-level precision)
    const minuteStart = windowStart.slice(0, 16);
    const minuteEnd = windowEnd.slice(0, 16);

    // Run all queries
    const projectBreakdown = getUsageByProjectInWindow(minuteStart, minuteEnd);
    const modelBreakdown = getModelBreakdownInWindow(windowStart, windowEnd);
    const activeSessions = getActiveSessionsInWindow(windowStart, windowEnd);
    const thinkingBlocks = getThinkingBlocksInWindow(windowStart, windowEnd);
    const timeline = getTimelineInWindow(minuteStart, minuteEnd);
    const userPrompts = getUserPromptsInWindow(windowStart, windowEnd);

    // Compute costs and totals
    let totalInput = 0;
    let totalOutput = 0;
    let totalCacheRead = 0;
    let totalCacheWrite = 0;
    let totalMessages = 0;

    const enrichedProjects = projectBreakdown.map((p) => {
      totalInput += p.input_tokens;
      totalOutput += p.output_tokens;
      totalCacheRead += p.cache_read_tokens;
      totalCacheWrite += p.cache_creation_tokens;
      totalMessages += p.message_count;

      return {
        ...p,
        cost_usd: Math.round(computeCost(p.input_tokens, p.output_tokens, p.cache_read_tokens, p.cache_creation_tokens) * 10000) / 10000,
        pct_of_total: 0, // filled below
      };
    });

    const totalCost = computeCost(totalInput, totalOutput, totalCacheRead, totalCacheWrite);

    // Fill percentages
    for (const p of enrichedProjects) {
      p.pct_of_total = totalCost > 0
        ? Math.round((p.cost_usd / totalCost) * 1000) / 10
        : 0;
    }

    const enrichedModels = modelBreakdown.map((m) => ({
      ...m,
      cost_usd: Math.round(computeCost(m.input_tokens, m.output_tokens, m.cache_read_tokens, m.cache_creation_tokens) * 10000) / 10000,
    }));

    // Derived stats for bean counters + math people
    const totalTokens = totalInput + totalOutput + totalCacheRead + totalCacheWrite;
    const costPerMinute = alert.window_minutes > 0 ? totalCost / alert.window_minutes : 0;
    const tokensPerMinute = alert.window_minutes > 0 ? totalTokens / alert.window_minutes : 0;
    const inputOutputRatio = totalOutput > 0 ? totalInput / totalOutput : 0;
    const cacheHitRate = (totalInput + totalCacheRead) > 0
      ? totalCacheRead / (totalInput + totalCacheRead) * 100
      : 0;
    const outputShare = totalTokens > 0 ? (totalOutput / totalTokens) * 100 : 0;
    const thinkingChars = thinkingBlocks.reduce((s, b) => s + b.char_count, 0);

    return NextResponse.json({
      alert,
      window: {
        start: windowStart,
        end: windowEnd,
        duration_minutes: alert.window_minutes,
      },
      projectBreakdown: enrichedProjects,
      modelBreakdown: enrichedModels,
      activeSessions,
      thinkingBlocks,
      timeline,
      userPrompts,
      totals: {
        input_tokens: totalInput,
        output_tokens: totalOutput,
        cache_read_tokens: totalCacheRead,
        cache_creation_tokens: totalCacheWrite,
        total_tokens: totalTokens,
        total_cost_usd: Math.round(totalCost * 10000) / 10000,
        messages: totalMessages,
      },
      stats: {
        cost_per_minute: Math.round(costPerMinute * 10000) / 10000,
        tokens_per_minute: Math.round(tokensPerMinute),
        input_output_ratio: Math.round(inputOutputRatio * 100) / 100,
        cache_hit_rate: Math.round(cacheHitRate * 10) / 10,
        output_share_pct: Math.round(outputShare * 10) / 10,
        thinking_blocks: thinkingBlocks.length,
        thinking_chars: thinkingChars,
        active_sessions: activeSessions.length,
        unique_models: enrichedModels.length,
        user_prompts: userPrompts.length,
      },
    });
  } catch (err) {
    return NextResponse.json(
      { error: 'Failed to fetch alert detail', detail: String(err) },
      { status: 500 }
    );
  }
}
