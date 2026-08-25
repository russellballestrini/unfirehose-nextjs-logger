import { NextRequest, NextResponse } from 'next/server';
import {
  getAlertById,
  getProjectModelUsageInWindow,
  getModelBreakdownInWindow,
  getActiveSessionsInWindow,
  getThinkingBlocksInWindow,
  getTimelineInWindow,
  getUserPromptsInWindow,
} from '@unturf/unfirehose/db/ingest';
import { costForUsage, costForUsageRows } from '@unturf/unfirehose/pricing';
import { ensurePricingHydrated } from '@unturf/unfirehose/pricing-sync';

// Cost comes from costForUsage — the single entry point in @unturf/unfirehose/pricing.
// This route used to carry its own copy of a blended Opus rate, which priced a
// project running on local Qwen as if every token were Anthropic's most
// expensive tier.

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
    ensurePricingHydrated();
    // Per project AND per model, so each project prices against what it
    // actually ran rather than one blended rate.
    const projectModelRows = getProjectModelUsageInWindow(windowStart, windowEnd);
    const modelBreakdown = getModelBreakdownInWindow(windowStart, windowEnd);
    const activeSessions = getActiveSessionsInWindow(windowStart, windowEnd);
    const reasoningBlocks = getThinkingBlocksInWindow(windowStart, windowEnd);
    const sealedReasoningBlocks = reasoningBlocks.filter((b: { text_content: string | null }) => !b.text_content || b.text_content.length === 0).length;
    const timeline = getTimelineInWindow(minuteStart, minuteEnd);
    const userPrompts = getUserPromptsInWindow(windowStart, windowEnd);

    // Compute costs and totals
    let totalInput = 0;
    let totalOutput = 0;
    let totalCacheRead = 0;
    let totalCacheWrite = 0;
    let totalMessages = 0;

    // Collapse the per-(project, model) rows back to one row per project,
    // summing cost through the single cost function on the way.
    const perProject = new Map<string, {
      name: string; display_name: string;
      input_tokens: number; output_tokens: number;
      cache_read_tokens: number; cache_creation_tokens: number;
      message_count: number; cost_usd: number; pct_of_total: number;
    }>();
    for (const r of projectModelRows) {
      totalInput += r.input_tokens;
      totalOutput += r.output_tokens;
      totalCacheRead += r.cache_read_tokens;
      totalCacheWrite += r.cache_creation_tokens;
      totalMessages += r.message_count;

      const cost = costForUsage({
        model: r.model,
        input: r.input_tokens,
        output: r.output_tokens,
        cacheRead: r.cache_read_tokens,
        cacheWrite: r.cache_creation_tokens,
        provider: r.provider,
        endpoint: r.endpoint,
      }).total;

      const cur = perProject.get(r.name) ?? {
        name: r.name, display_name: r.display_name,
        input_tokens: 0, output_tokens: 0,
        cache_read_tokens: 0, cache_creation_tokens: 0,
        message_count: 0, cost_usd: 0, pct_of_total: 0,
      };
      cur.input_tokens += r.input_tokens;
      cur.output_tokens += r.output_tokens;
      cur.cache_read_tokens += r.cache_read_tokens;
      cur.cache_creation_tokens += r.cache_creation_tokens;
      cur.message_count += r.message_count;
      cur.cost_usd += cost;
      perProject.set(r.name, cur);
    }

    const enrichedProjects = [...perProject.values()]
      .sort((a, b) => (b.input_tokens + b.output_tokens) - (a.input_tokens + a.output_tokens));
    for (const p of enrichedProjects) {
      p.cost_usd = Math.round(p.cost_usd * 10000) / 10000;
    }

    const totalCost = enrichedProjects.reduce((s, p) => s + p.cost_usd, 0);

    // Fill percentages
    for (const p of enrichedProjects) {
      p.pct_of_total = totalCost > 0
        ? Math.round((p.cost_usd / totalCost) * 1000) / 10
        : 0;
    }

    const enrichedModels = modelBreakdown.map((m: any) => {
      const c = costForUsage({
        model: m.model,
        input: m.input_tokens,
        output: m.output_tokens,
        cacheRead: m.cache_read_tokens,
        cacheWrite: m.cache_creation_tokens,
        provider: m.provider,
        endpoint: m.endpoint,
      });
      return {
        ...m,
        cost_usd: Math.round(c.total * 10000) / 10000,
        market_usd: Math.round(c.market * 10000) / 10000,
        avoided_usd: Math.round(c.avoided * 10000) / 10000,
        cost_source: c.source,
      };
    });

    // Derived stats for bean counters + math people
    const totalTokens = totalInput + totalOutput + totalCacheRead + totalCacheWrite;
    const costPerMinute = alert.window_minutes > 0 ? totalCost / alert.window_minutes : 0;
    const tokensPerMinute = alert.window_minutes > 0 ? totalTokens / alert.window_minutes : 0;
    const inputOutputRatio = totalOutput > 0 ? totalInput / totalOutput : 0;
    const cacheHitRate = (totalInput + totalCacheRead) > 0
      ? totalCacheRead / (totalInput + totalCacheRead) * 100
      : 0;
    const outputShare = totalTokens > 0 ? (totalOutput / totalTokens) * 100 : 0;
    const reasoningChars = reasoningBlocks.reduce((s, b) => s + b.char_count, 0);

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
      reasoningBlocks,
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
        // Per-class split, priced through the same function. The alert page
        // used to multiply these by 5 / 25 / 0.50 / 6.25 typed inline in JSX.
        cost_split_usd: (() => {
          const c = costForUsageRows(projectModelRows.map((r) => ({
            model: r.model,
            input: r.input_tokens,
            output: r.output_tokens,
            cacheRead: r.cache_read_tokens,
            cacheWrite: r.cache_creation_tokens,
            provider: r.provider,
            endpoint: r.endpoint,
          })));
          const r4 = (n: number) => Math.round(n * 10000) / 10000;
          return {
            input: r4(c.input), output: r4(c.output),
            cache_read: r4(c.cacheRead), cache_write: r4(c.cacheWrite),
            market: r4(c.market), avoided: r4(c.avoided),
          };
        })(),
      },
      stats: {
        cost_per_minute: Math.round(costPerMinute * 10000) / 10000,
        tokens_per_minute: Math.round(tokensPerMinute),
        input_output_ratio: Math.round(inputOutputRatio * 100) / 100,
        cache_hit_rate: Math.round(cacheHitRate * 10) / 10,
        output_share_pct: Math.round(outputShare * 10) / 10,
        reasoning_blocks: reasoningBlocks.length,
        sealed_reasoning_blocks: sealedReasoningBlocks,
        reasoning_chars: reasoningChars,
        // Legacy aliases — drop after one release cycle.
        thinking_blocks: reasoningBlocks.length,
        thinking_chars: reasoningChars,
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
