import { getModelColor } from '@unturf/unfirehose-ui/modelColor';
import { formatTokens } from '@unturf/unfirehose/format';
import { TOKEN_TYPE_COLORS } from '@unturf/unfirehose-ui/TokenSplit';
import { Donut } from '@/components/Donut';
import { NoCostEmpty } from './empties';
import { UPlotCategoryChart } from '@/components/UPlotCategoryChart';
import { getHarnessColor, shortModel, formatCost } from '../_lib';

/* eslint-disable @typescript-eslint/no-explicit-any */

export function HarnessTab({ harnessData, harnessModelBreakdown, harnessSessions, dailyByHarness }: {
  harnessData: any[];
  harnessModelBreakdown: any[];
  harnessSessions: any[];
  dailyByHarness: any[];
}) {
  return (
    <>
      <h3 className="text-base text-[var(--color-muted)]">
        Token usage split by originating harness (claude-code, fetch, uncloseai, hermes, agnt)
      </h3>

      {/* Harness stat cards */}
      {harnessData && harnessData.length > 0 && (
        <div className="grid grid-cols-5 gap-4">
          {harnessData
            .filter((h: any) => h.totalTokens > 0)
            .sort((a: any, b: any) => b.totalTokens - a.totalTokens)
            .slice(0, 5)
            .map((h: any) => {
              const sessions = (harnessSessions ?? []).find((s: any) => s.harness === h.harness);
              return (
                <div key={h.harness} className="bg-[var(--color-surface)] rounded border border-[var(--color-border)] p-4">
                  <div className="flex items-center gap-2 mb-1">
                    <span
                      className="inline-block w-2 h-2 rounded-full shrink-0"
                      style={{ background: getHarnessColor(h.harness) }}
                    />
                    <span className="text-base text-[var(--color-muted)]">{h.harness}</span>
                  </div>
                  <div className="text-2xl font-bold">{formatTokens(h.totalTokens)}</div>
                  <div className="text-base text-[var(--color-muted)] mt-1">
                    {formatCost(h.costUSD)} · {sessions?.sessions ?? 0} sessions · {h.cacheEfficiency.toFixed(0)}x cache
                  </div>
                </div>
              );
            })}
        </div>
      )}

      {/* Row: Harness charts */}
      {harnessData && harnessData.length > 0 ? (
        <div className="grid grid-cols-3 gap-4">
          {/* Tokens by Harness donut */}
          <div className="bg-[var(--color-surface)] rounded border border-[var(--color-border)] p-4">
            <h3 className="text-base font-bold mb-2 text-[var(--color-muted)]">
              Tokens by Harness
            </h3>
            <Donut
              data={harnessData.filter((h: any) => h.totalTokens > 0).map((h: any) => ({ name: h.harness, value: h.totalTokens, color: getHarnessColor(h.harness) }))}
              format={formatTokens}
              height={200}
            />
          </div>

          {/* Cost by Harness donut */}
          <div className="bg-[var(--color-surface)] rounded border border-[var(--color-border)] p-4">
            <h3 className="text-base font-bold mb-2 text-[var(--color-muted)]">
              Cost by Harness
            </h3>
            <Donut
              data={harnessData.filter((h: any) => h.costUSD > 0).map((h: any) => ({ name: h.harness, value: h.costUSD, color: getHarnessColor(h.harness) }))}
              format={formatCost}
              height={200}
              empty={<NoCostEmpty />}
            />
          </div>

          {/* Harness × Model stacked bar */}
          <div className="bg-[var(--color-surface)] rounded border border-[var(--color-border)] p-4">
            <h3 className="text-base font-bold mb-2 text-[var(--color-muted)]">
              Harness × Model
            </h3>
            {(() => {
              const harnesses = [...new Set((harnessModelBreakdown ?? []).map((r: any) => r.harness))] as string[];
              const models = [...new Set((harnessModelBreakdown ?? []).map((r: any) => r.model))] as string[];
              const barData = harnesses.map((h) => {
                const row: any = { harness: h };
                for (const m of models) {
                  const match = (harnessModelBreakdown ?? []).find((r: any) => r.harness === h && r.model === m);
                  if (match) {
                    row[m] = match.input_tokens + match.output_tokens + match.cache_read_tokens + match.cache_creation_tokens;
                  }
                }
                return row;
              });
              return (
                <UPlotCategoryChart
                  data={barData}
                  labelKey="harness"
                  horizontal
                  stacked
                  legend
                  series={models.map((m) => ({ key: m, label: shortModel(m), color: getModelColor(m) }))}
                  height={200}
                  format={formatTokens}
                />
              );
            })()}
          </div>
        </div>
      ) : (
        <div className="bg-[var(--color-surface)] rounded border border-[var(--color-border)] p-4 text-[var(--color-muted)] text-base">
          No harness data yet. Sessions need the <code>harness</code> field populated during ingestion.
        </div>
      )}

      {/* Daily tokens by harness */}
      {dailyByHarness && dailyByHarness.length > 0 && (
        <div className="bg-[var(--color-surface)] rounded border border-[var(--color-border)] p-4">
          <h3 className="text-base font-bold mb-3 text-[var(--color-muted)]">
            Daily Tokens by Harness
          </h3>
          {(() => {
            // Pivot: { date, claude-code: N, fetch: N, uncloseai: N, ... }
            const harnesses = [...new Set(dailyByHarness.map((r: any) => r.harness))] as string[];
            const byDate: Record<string, any> = {};
            for (const r of dailyByHarness) {
              if (!byDate[r.date]) byDate[r.date] = { date: r.date };
              byDate[r.date][r.harness] = r.tokens;
            }
            const chartData = Object.values(byDate).slice(-30);
            return (
              <UPlotCategoryChart
                data={chartData as Array<Record<string, unknown>>}
                labelKey="date"
                stacked
                legend
                series={harnesses.map((h) => ({ key: h, label: h, color: getHarnessColor(h) }))}
                height={250}
                format={formatTokens}
                tick={(d) => d.slice(5)}
              />
            );
          })()}
        </div>
      )}

      {/* Harness breakdown table */}
      {harnessData && harnessData.length > 0 && (
        <div className="bg-[var(--color-surface)] rounded border border-[var(--color-border)] p-4">
          <h3 className="text-base font-bold mb-3 text-[var(--color-muted)]">
            Per-Harness Breakdown
          </h3>
          <table className="w-full text-base">
            <thead>
              <tr className="text-[var(--color-muted)] text-left border-b border-[var(--color-border)]">
                <th className="pb-2">Harness</th>
                <th className="pb-2 text-right">Sessions</th>
                <th className="pb-2 text-right" colSpan={5}>Tokens</th>
                <th className="pb-2 text-right">Cache Eff</th>
                <th className="pb-2 text-right" colSpan={5}>Equivalent Cost</th>
              </tr>
              <tr className="text-[var(--color-muted)] text-left border-b border-[var(--color-border)]">
                <th className="pb-2"></th>
                <th className="pb-2"></th>
                <th className="pb-2 text-right">Input</th>
                <th className="pb-2 text-right">Output</th>
                <th className="pb-2 text-right">Cache Read</th>
                <th className="pb-2 text-right">Cache Write</th>
                <th className="pb-2 text-right">Total</th>
                <th className="pb-2"></th>
                <th className="pb-2 text-right">Input</th>
                <th className="pb-2 text-right">Output</th>
                <th className="pb-2 text-right">Cache Read</th>
                <th className="pb-2 text-right">Cache Write</th>
                <th className="pb-2 text-right">Total</th>
              </tr>
            </thead>
            <tbody>
              {harnessData
                .filter((h: any) => h.totalTokens > 0)
                .sort((a: any, b: any) => b.totalTokens - a.totalTokens)
                .map((h: any) => {
                  const sessions = (harnessSessions ?? []).find((s: any) => s.harness === h.harness);
                  return (
                    <tr key={h.harness} className="border-b border-[var(--color-border)]">
                      <td className="py-2 flex items-center gap-2">
                        <span
                          className="inline-block w-2 h-2 rounded-full shrink-0"
                          style={{ background: getHarnessColor(h.harness) }}
                        />
                        {h.harness}
                      </td>
                      <td className="py-2 text-right">{sessions?.sessions ?? 0}</td>
                      <td className="py-2 text-right" style={{ color: TOKEN_TYPE_COLORS.input }}>
                        {formatTokens(h.inputTokens)}
                      </td>
                      <td className="py-2 text-right" style={{ color: TOKEN_TYPE_COLORS.output }}>
                        {formatTokens(h.outputTokens)}
                      </td>
                      <td className="py-2 text-right" style={{ color: TOKEN_TYPE_COLORS.cacheRead }}>
                        {formatTokens(h.cacheReadTokens)}
                      </td>
                      <td className="py-2 text-right" style={{ color: TOKEN_TYPE_COLORS.cacheWrite }}>
                        {formatTokens(h.cacheCreationTokens)}
                      </td>
                      <td className="py-2 text-right font-bold">
                        {formatTokens(h.totalTokens)}
                      </td>
                      <td className="py-2 text-right">
                        {h.cacheEfficiency.toFixed(0)}x
                      </td>
                      <td className="py-2 text-right" style={{ color: TOKEN_TYPE_COLORS.input }}>
                        {formatCost(h.inputCostUSD ?? 0)}
                      </td>
                      <td className="py-2 text-right" style={{ color: TOKEN_TYPE_COLORS.output }}>
                        {formatCost(h.outputCostUSD ?? 0)}
                      </td>
                      <td className="py-2 text-right" style={{ color: TOKEN_TYPE_COLORS.cacheRead }}>
                        {formatCost(h.cacheReadCostUSD ?? 0)}
                      </td>
                      <td className="py-2 text-right" style={{ color: TOKEN_TYPE_COLORS.cacheWrite }}>
                        {formatCost(h.cacheWriteCostUSD ?? 0)}
                      </td>
                      <td className="py-2 text-right text-[var(--color-accent)] font-bold">
                        {formatCost(h.costUSD)}
                      </td>
                    </tr>
                  );
                })}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
