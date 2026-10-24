/**
 * Every GPU in a node, as one reading.
 *
 * `nvidia-smi --query-gpu=power.draw,name,memory.total,memory.used,utilization.gpu`
 * prints one CSV row per card. A node is the unit our sampler, our energy
 * attribution (ticket 4004) and our monthly cost report price, so its GPU
 * draw is the SUM over its cards: two 3090s at 280 W each are a 560 W node.
 * We do not split by CUDA device until nvidia-smi gives us a process to
 * device mapping we sample (`--query-compute-apps`); until then a node's
 * cards are one draw and its models share it.
 *
 * The local probe and the remote probe used to carry a copy each of this
 * loop; both read through here now.
 */
import { num } from './num';

export interface GpuTotals {
  /** Summed power.draw across every card that reported one; null when none did. */
  watts: number | null;
  /** The first card's name. */
  model?: string;
  /** Summed across cards. */
  memTotalMB?: number;
  memUsedMB?: number;
  /** The busiest card's utilisation: one pegged GPU is a busy node. */
  util?: number;
  /** Cards seen, whether or not they reported power. */
  count: number;
}

/** Sum nvidia-smi CSV rows (no header, no units). Rows that do not parse are skipped. */
export function sumNvidiaRows(lines: Iterable<string>): GpuTotals {
  const r: GpuTotals = { watts: null, count: 0 };
  let watts = 0;
  let any = false;
  for (const line of lines) {
    if (!line.trim()) continue;
    const parts = line.split(',').map((s) => s.trim());
    r.count++;
    // A card that does not expose power prints [N/A]; it adds nothing
    // rather than poisoning the node's sum.
    const w = parseFloat(parts[0]);
    if (Number.isFinite(w)) { watts += w; any = true; }
    if (!r.model && parts[1]) r.model = parts[1];
    if (parts[2]) r.memTotalMB = (r.memTotalMB ?? 0) + num(parts[2]);
    if (parts[3]) r.memUsedMB = (r.memUsedMB ?? 0) + num(parts[3]);
    if (parts[4]) r.util = Math.max(r.util ?? 0, num(parts[4]));
  }
  r.watts = any && watts > 0 ? watts : null;
  return r;
}
