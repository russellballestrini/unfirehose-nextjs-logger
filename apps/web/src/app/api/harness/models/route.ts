import { NextRequest, NextResponse } from 'next/server';
import { execFile } from 'child_process';
import {
  HARNESS_MODEL_ADAPTERS,
  CLAUDE_MODELS,
  supportsModelSelection,
  type HarnessModel,
} from '@unturf/unfirehose/harness-models';

export const dynamic = 'force-dynamic';

// Enumerating 469 models costs a process spawn (or an SSH round trip), and the
// answer changes when fox adds a provider, not between page loads.
const TTL_MS = 5 * 60 * 1000;
const cache = new Map<string, { models: HarnessModel[]; ts: number; error?: string }>();

function run(cmd: string, args: string[], timeout: number): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
      if (err && !stdout) reject(err);
      else resolve(stdout);
    });
  });
}

// uncloseai-cli installs as both `unclose` and `uncloseai-cli`. Try each —
// PATH differs between fox's box and a freshly bootstrapped node.
const UNCLOSE_BINS = ['unclose', 'uncloseai-cli'];

async function listLocal(harness: string): Promise<HarnessModel[]> {
  const adapter = HARNESS_MODEL_ADAPTERS[harness];
  if (!adapter) return [];
  const bins = harness === 'uncloseai' ? UNCLOSE_BINS : [harness];
  let lastErr: unknown;
  for (const bin of bins) {
    try {
      const [cmd, ...args] = adapter.command(bin);
      const out = await run(cmd, args, 60_000);
      const models = adapter.parse(out);
      if (models.length) return models;
    } catch (err) {
      lastErr = err;
    }
  }
  if (lastErr) throw lastErr;
  return [];
}

async function listRemote(harness: string, host: string): Promise<HarnessModel[]> {
  const adapter = HARNESS_MODEL_ADAPTERS[harness];
  if (!adapter) return [];
  const bins = harness === 'uncloseai' ? UNCLOSE_BINS : [harness];
  // Source the login PATH: a harness installed under ~/.local/bin is not on
  // PATH for a non-interactive ssh command.
  const script = bins
    .map((b) => adapter.command(b).join(' '))
    .join(' || ');
  const out = await run(
    'ssh',
    [
      '-o', 'ConnectTimeout=5',
      '-o', 'StrictHostKeyChecking=no',
      '-o', 'BatchMode=yes',
      host,
      `export PATH="$HOME/.local/bin:$PATH"; ${script}`,
    ],
    60_000,
  );
  return adapter.parse(out);
}

/**
 * GET /api/harness/models?harness=uncloseai&host=4090-ai.foxhop.net
 *
 * Lists what a harness can actually run on a given target, so dispatching work
 * is a choice of model rather than whatever default the harness happens to
 * hold. `host` omitted means localhost.
 */
export async function GET(req: NextRequest) {
  const harness = req.nextUrl.searchParams.get('harness') ?? '';
  const host = req.nextUrl.searchParams.get('host') ?? '';
  const refresh = req.nextUrl.searchParams.get('refresh') === '1';

  if (!harness) {
    return NextResponse.json({ error: 'harness required' }, { status: 400 });
  }

  // Harnesses we cannot enumerate still report whether they take a model, so
  // the UI can show a free-text box instead of nothing.
  if (harness === 'claude') {
    return NextResponse.json({
      harness, host: host || 'localhost',
      models: CLAUDE_MODELS, selectable: true, source: 'static',
    });
  }

  if (!HARNESS_MODEL_ADAPTERS[harness]) {
    return NextResponse.json({
      harness, host: host || 'localhost',
      models: [], selectable: supportsModelSelection(harness), source: 'none',
    });
  }

  const key = `${harness}@${host || 'localhost'}`;
  const hit = cache.get(key);
  if (!refresh && hit && Date.now() - hit.ts < TTL_MS) {
    return NextResponse.json({
      harness, host: host || 'localhost',
      models: hit.models, selectable: true, source: 'cache', error: hit.error,
    });
  }

  try {
    const models = host ? await listRemote(harness, host) : await listLocal(harness);
    cache.set(key, { models, ts: Date.now() });
    return NextResponse.json({
      harness, host: host || 'localhost',
      models, selectable: true, source: host ? 'ssh' : 'local',
    });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    // Cache the failure briefly too — a node that is down should not be
    // re-probed on every keystroke in the dispatch box.
    cache.set(key, { models: [], ts: Date.now(), error: detail });
    return NextResponse.json({
      harness, host: host || 'localhost',
      models: [], selectable: true, source: 'error', error: detail,
    });
  }
}
