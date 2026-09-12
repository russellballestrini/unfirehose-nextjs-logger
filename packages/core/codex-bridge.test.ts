import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, appendFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';

it('resumes complete UTF-8 lines, is idempotent, and recovers uncommitted output', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'codex-bridge-'));
  try {
    const source = path.join(dir, 'source');
    mkdirSync(path.join(source, 'sessions'), { recursive: true });
    const file = path.join(source, 'sessions', 'rollout-test.jsonl');
    const line = (payload: unknown) => JSON.stringify({ type: 'response_item', timestamp: '2026-09-12T00:00:00Z', payload }) + '\n';
    const user = line({ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'héllo' }] });
    const outputDir = path.join(dir, 'output');
    const stateDir = path.join(dir, 'state');
    writeFileSync(file, JSON.stringify({ type: 'session_meta', payload: { id: 'test-session', cwd: '/repo' } }) + '\n' + user.slice(0, -3));
    const run = () => execFileSync(path.resolve('../../node_modules/.bin/tsx'), [path.resolve('../../scripts/codex-bridge.mts'), '--once'], {
      env: { ...process.env, CODEX_HOME: source, UNFIREHOSE_CODEX_DIR: outputDir, CODEX_BRIDGE_STATE: stateDir },
    });
    run();
    const output = path.join(outputDir, '-repo', 'test-session.jsonl');
    expect(readFileSync(output, 'utf8').trim().split('\n')).toHaveLength(1);
    appendFileSync(file, user.slice(-3));
    run();
    const expected = readFileSync(output, 'utf8');
    expect(expected).toContain('héllo');
    run();
    expect(readFileSync(output, 'utf8')).toBe(expected);
    // Crash after an output append but before its checkpoint was committed.
    appendFileSync(output, '{"uncommitted":true}\n');
    appendFileSync(file, line({ type: 'custom_tool_call_output', call_id: 'call', output: 'done' }));
    run();
    const recovered = readFileSync(output, 'utf8');
    expect(recovered).not.toContain('uncommitted');
    expect(recovered.trim().split('\n')).toHaveLength(3);
    expect(readdirSync(stateDir)).toHaveLength(1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}, 30_000);
