import { getModelColor } from '@unturf/unfirehose-ui/modelColor';
import { Donut } from '@/components/Donut';
import { NoToolsEmpty } from './empties';
import { UPlotCategoryChart } from '@/components/UPlotCategoryChart';
import { UPlotTimeChart } from '@/components/UPlotTimeChart';
import { getHarnessColor, shortModel, TOOL_COLORS } from '../_lib';

/* eslint-disable @typescript-eslint/no-explicit-any */

export function ToolsTab({ toolCalls, totalToolCalls, toolsByModel, blockTypes, toolsByHarness, dailyActivity }: {
  toolCalls: any[];
  totalToolCalls: number;
  toolsByModel: any[];
  blockTypes: any[];
  toolsByHarness: any[];
  dailyActivity: any[];
}) {
  // Top 12 tool calls for pie chart, rest as "other"
  const topTools = toolCalls.slice(0, 12);
  const otherTools = toolCalls.slice(12);
  const toolPieData = [
    ...topTools.map((t: any, i: number) => ({
      name: t.tool_name,
      value: t.count,
      color: TOOL_COLORS[i % TOOL_COLORS.length],
    })),
    ...(otherTools.length > 0
      ? [{
          name: 'other',
          value: otherTools.reduce((s: number, t: any) => s + t.count, 0),
          color: '#52525b',
        }]
      : []),
  ];

  return (
    <>
      {/* Top tools by harness */}
      {toolsByHarness && toolsByHarness.length > 0 && (
        <div className="bg-[var(--color-surface)] rounded border border-[var(--color-border)] p-4">
          <h3 className="text-base font-bold mb-3 text-[var(--color-muted)]">
            Top Tools by Harness
          </h3>
          {(() => {
            // Group by harness, show top 5 tools each
            const grouped: Record<string, { tool_name: string; count: number }[]> = {};
            for (const r of toolsByHarness) {
              if (!grouped[r.harness]) grouped[r.harness] = [];
              if (grouped[r.harness].length < 5) grouped[r.harness].push(r);
            }
            return (
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                {Object.entries(grouped).map(([harness, tools]) => (
                  <div key={harness}>
                    <div className="flex items-center gap-2 mb-2">
                      <span
                        className="inline-block w-2 h-2 rounded-full shrink-0"
                        style={{ background: getHarnessColor(harness) }}
                      />
                      <span className="font-bold">{harness}</span>
                    </div>
                    {tools.map((t) => (
                      <div key={t.tool_name} className="flex justify-between text-base py-0.5">
                        <span className="text-[var(--color-muted)]">{t.tool_name}</span>
                        <span>{t.count.toLocaleString()}</span>
                      </div>
                    ))}
                  </div>
                ))}
              </div>
            );
          })()}
        </div>
      )}

      {/* Row: Tool calls pie + Tool calls bar */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {/* Tool calls pie */}
        <div className="bg-[var(--color-surface)] rounded border border-[var(--color-border)] p-4">
          <h3 className="text-base font-bold mb-2 text-[var(--color-muted)]">
            Tool Calls ({totalToolCalls.toLocaleString()} total)
          </h3>
          <Donut data={toolPieData} format={(v) => v.toLocaleString()} height={280} empty={<NoToolsEmpty />} />
        </div>

        {/* Tool calls horizontal bar */}
        <div className="bg-[var(--color-surface)] rounded border border-[var(--color-border)] p-4">
          <h3 className="text-base font-bold mb-2 text-[var(--color-muted)]">
            Tool Calls by Type
          </h3>
          <UPlotCategoryChart
            data={toolCalls.slice(0, 15)}
            labelKey="tool_name"
            horizontal
            series={[{ key: 'count', label: 'calls', color: '#fbbf24' }]}
            height={280}
            format={(v) => v.toLocaleString()}
          />
        </div>
      </div>

      {/* Row: Tool calls by model + Content block types */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {/* Tools by model */}
        <div className="bg-[var(--color-surface)] rounded border border-[var(--color-border)] p-4">
          <h3 className="text-base font-bold mb-2 text-[var(--color-muted)]">
            Tool Calls by Model
          </h3>
          <Donut
            data={toolsByModel.map((t: any) => ({ name: shortModel(t.model ?? 'unknown'), fullName: t.model ?? 'unknown', value: t.count, color: getModelColor(t.model ?? '') }))}
            format={(v) => v.toLocaleString()}
            height={200}
            empty={<NoToolsEmpty />}
          />
        </div>

        {/* Content block types */}
        <div className="bg-[var(--color-surface)] rounded border border-[var(--color-border)] p-4">
          <h3 className="text-base font-bold mb-2 text-[var(--color-muted)]">
            Content Block Types
          </h3>
          <Donut
            data={blockTypes.map((b: any, i: number) => ({ name: b.block_type, value: b.count, color: TOOL_COLORS[i % TOOL_COLORS.length] }))}
            format={(v) => v.toLocaleString()}
            height={200}
          />
        </div>
      </div>

      {/* Daily activity line chart */}
      <div className="bg-[var(--color-surface)] rounded border border-[var(--color-border)] p-4">
        <h3 className="text-base font-bold mb-3 text-[var(--color-muted)]">
          Daily Messages & Tool Calls (last 30 days)
        </h3>
        <UPlotTimeChart
          data={(dailyActivity ?? []).slice(-30).map((d: any) => ({
            ...d,
            tsMs: new Date(d.date + 'T00:00Z').getTime(),
          }))}
          height={250}
          syncKey="tokens-daily"
          domain={null}
          yMin={0}
          series={[
            { key: 'messageCount', label: 'Messages', stroke: '#10b981', width: 2 },
            { key: 'toolCallCount', label: 'Tool Calls', stroke: '#fbbf24', width: 2 },
          ]}
        />
      </div>
    </>
  );
}
