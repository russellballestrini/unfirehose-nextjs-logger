import type { ReactNode } from 'react';
import { Donut } from '@/components/Donut';

// Donut for the per-model breakdowns. Model names are open-ended (self-hosted
// quants like `Lorbus/Qwen3.6-27B-int4-AutoRound` are long and unbounded in
// count), so Recharts' in-chart <Legend> overflows the fixed-height box and
// stacks over the donut. Instead: cap slices to the top N by value (rest folded
// into "other" so the ring stays legible), and render the legend in its own
// scrollable list below the donut — legend length can never push into the ring.
const MODEL_DONUT_TOP_N = 10;

export function ModelDonut({
  title,
  data,
  format,
  empty,
}: {
  title: string;
  data: Array<{ name: string; fullName?: string; value: number; color: string }>;
  format: (n: number) => string;
  empty?: ReactNode;
}) {
  return (
    <div className="bg-[var(--color-surface)] rounded border border-[var(--color-border)] p-4">
      <h3 className="text-base font-bold mb-2 text-[var(--color-muted)]">{title}</h3>
      <Donut data={data} format={format} height={160} topN={MODEL_DONUT_TOP_N} empty={empty} />
    </div>
  );
}
