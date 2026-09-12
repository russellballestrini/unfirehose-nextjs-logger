// Incremental, local-only Codex rollout -> native unfirehose/1.0 bridge.
// Output and checkpoint commits are ordered; a restart rolls back any output
// written after the last committed checkpoint. Source logs are never modified.
import { readdir, mkdir, readFile, writeFile, rename, stat, open, truncate, appendFile } from 'node:fs/promises';
import path from 'node:path';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import { normalizeCodexEntry, type CodexState } from '../packages/core/codex-adapter';

const source = path.join(process.env.CODEX_HOME || path.join(homedir(), '.codex'), 'sessions');
const destination = process.env.UNFIREHOSE_CODEX_DIR || path.join(homedir(), '.codex', 'unfirehose');
const checkpoints = process.env.CODEX_BRIDGE_STATE || path.join(homedir(), '.unfirehose', 'codex-bridge');
interface Checkpoint { offset: number; outputSize: number; output?: string; state: CodexState }
async function* walk(dir: string): AsyncGenerator<string> {
  for (const entry of (await readdir(dir, { withFileTypes: true }).catch(() => [])).sort((a, b) => b.name.localeCompare(a.name))) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(file);
    else if (entry.name.endsWith('.jsonl')) yield file;
  }
}
async function sync(file: string) {
  const key = createHash('sha256').update(file).digest('hex');
  const checkpoint = path.join(checkpoints, key + '.json');
  const previous = await readFile(checkpoint, 'utf8').catch((err) => {
    if (err.code !== 'ENOENT') throw err;
    return '';
  });
  const c: Checkpoint = previous ? JSON.parse(previous) : { offset: 0, outputSize: 0, state: {} };
  const size = (await stat(file)).size;
  if (size < c.offset) throw new Error(`Source truncated: ${file}`);
  if (size === c.offset) return 0;
  if (c.output) await truncate(c.output, c.outputSize);
  const handle = await open(file, 'r');
  let pending = Buffer.alloc(0), position = c.offset, records = 0;
  try {
    // Bound work per file per pass, while allowing a single large JSONL record.
    while (position < size && position - c.offset < 32 * 1024 * 1024) {
      const buffer = Buffer.alloc(Math.min(1024 * 1024, size - position));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
      if (!bytesRead) break;
      position += bytesRead;
      pending = Buffer.concat([pending, buffer.subarray(0, bytesRead)]);
      let end: number;
      while ((end = pending.indexOf(10)) >= 0) {
        const line = pending.subarray(0, end).toString('utf8');
        const offset = position - pending.length;
        pending = pending.subarray(end + 1);
        if (!line.trim()) continue;
        const raw = JSON.parse(line); // Fail visibly on corruption; never silently skip.
        const message = normalizeCodexEntry(raw, c.state, `codex:${key}:${offset}`);
        if (raw.type === 'session_meta' && !c.output) {
          if (!c.state.sessionId || !/^[a-zA-Z0-9-]+$/.test(c.state.sessionId)) throw new Error('Invalid session id');
          const slug = (c.state.cwd || 'unknown').replace(/[^a-zA-Z0-9_-]/g, '-');
          const dir = path.join(destination, slug);
          await mkdir(dir, { recursive: true });
          c.output = path.join(dir, c.state.sessionId + '.jsonl');
          await writeFile(c.output, JSON.stringify({ type: 'session', id: c.state.sessionId, createdAt: raw.timestamp, cwd: c.state.cwd, gitBranch: raw.payload.git?.branch }) + '\n', { mode: 0o600 });
        }
        if (message && c.output) {
          await appendFile(c.output, JSON.stringify(message) + '\n');
          records++;
        }
      }
    }
  } finally { await handle.close(); }
  c.offset = position - pending.length; // A partial last line is retried next pass.
  if (c.output) c.outputSize = (await stat(c.output)).size;
  await writeFile(checkpoint + '.tmp', JSON.stringify(c), { mode: 0o600 });
  await rename(checkpoint + '.tmp', checkpoint);
  return records;
}
await mkdir(checkpoints, { recursive: true });
do {
  let records = 0;
  for await (const file of walk(source)) records += await sync(file);
  console.log(`[codex-bridge] synced ${records} messages at ${new Date().toISOString()}`);
  if (process.argv.includes('--once')) break;
  await new Promise(resolve => setTimeout(resolve, 10_000));
} while (true);
