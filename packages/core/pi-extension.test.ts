import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { verifyLines } from './provenance';

/**
 * The pi extension is one standalone file a user copies into
 * ~/.pi/agent/extensions; it inlines the chain rule rather than
 * importing it. This drives it with a fake `pi` and checks the file it
 * writes with the ingester's own verifier — the writer never grades
 * itself.
 */
const extension = (await import('../schema/extensions/pi-unfirehose')).default;

describe('pi extension writes a chained, rooted unfirehose/1.0 journal', () => {
  it('verifies end to end through the ingester’s verifier', async () => {
    const out = mkdtempSync(path.join(tmpdir(), 'pi-ext-'));
    const handlers: Record<string, (event: any, ctx: any) => Promise<void>> = {};
    extension({ on: (name: string, fn: (event: any, ctx: any) => Promise<void>) => { handlers[name] = fn; } });
    const ctx = { settings: { unfirehose: { outputDir: out } } };
    try {
      await handlers.session_start({ cwd: '/home/demo/proj', sessionId: 'pi-native' }, ctx);
      await handlers.message_end({
        message: { role: 'user', content: [{ type: 'text', text: 'hello é 日本' }], timestamp: Date.now() },
        entryId: 'e1',
      }, ctx);
      await handlers.message_end({
        message: { role: 'assistant', content: [{ type: 'text', text: 'hi' }], timestamp: Date.now(), model: 'm', provider: 'p', api: 'x', stopReason: 'stop', usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 } },
        entryId: 'e2',
      }, ctx);
      await handlers.session_shutdown({}, ctx);

      const dir = readdirSync(out).find((d) => d.includes('demo'))!;
      const file = readdirSync(path.join(out, dir)).find((f) => f.endsWith('.jsonl'))!;
      const lines = readFileSync(path.join(out, dir, file), 'utf8').split('\n');
      const rep = verifyLines(lines);
      expect(rep.state).toBe('verified');
      expect(rep.breaks).toBe(0);
      expect(rep.entries).toBe(5);                                    // header, 2 messages, closed, session_end
      expect([rep.merkle_version, rep.encoding_version, rep.root_semantics])
        .toEqual(['merkle-v1', 'jsonl-bytes-v1', 'SEQUENCE']);
      const header = JSON.parse(lines[0]);
      expect(header.hashVersion).toBe('unfirehose-chain-v1');
      expect(header.prevHash).toBeNull();
      lines[1] = lines[1].replace('hello', 'HELLO');
      expect(verifyLines(lines).state).toBe('corrupted');
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  });
});
