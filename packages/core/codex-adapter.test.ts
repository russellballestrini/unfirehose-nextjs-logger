import { describe, expect, it } from 'vitest';
import { normalizeCodexEntry, type CodexState } from './codex-adapter';

describe('Codex rollouts', () => {
  it('carries session and model metadata, without duplicating event messages', () => {
    const state: CodexState = {};
    normalizeCodexEntry({ type: 'session_meta', payload: { id: 'session', cwd: '/repo' } }, state, '0');
    normalizeCodexEntry({ type: 'turn_context', payload: { model: 'test-model' } }, state, '1');
    expect(normalizeCodexEntry({ type: 'event_msg', payload: { type: 'user_message', message: 'hello' } }, state, '2')).toBeNull();
    expect(normalizeCodexEntry({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hello' }] } }, state, '3'))
      .toMatchObject({ sessionId: 'session', model: 'test-model', cwd: '/repo', content: [{ type: 'text', text: 'hello' }] });
  });
  it('counts cumulative usage once and separates cached input', () => {
    const state: CodexState = {};
    const record = (input: number, cached: number, output: number) => ({ type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: input, cached_input_tokens: cached, output_tokens: output } } } });
    expect(normalizeCodexEntry(record(100, 40, 10), state, '1')?.usage).toMatchObject({ inputTokens: 60, outputTokens: 10, inputTokenDetails: { cacheReadTokens: 40 } });
    expect(normalizeCodexEntry(record(100, 40, 10), state, '2')).toBeNull();
    expect(normalizeCodexEntry(record(150, 60, 20), state, '3')?.usage).toMatchObject({ inputTokens: 30, outputTokens: 10, inputTokenDetails: { cacheReadTokens: 20 } });
    expect(normalizeCodexEntry({ type: 'token_usage_record', payload: { usage: {} } }, state, '4')).toBeNull();
  });
  it('preserves both tool protocols and never exports encrypted reasoning', () => {
    for (const type of ['function_call', 'custom_tool_call']) {
      expect(normalizeCodexEntry({ type: 'response_item', payload: { type, name: 'exec', call_id: 'call', arguments: '{partial', input: 'raw' } }, {}, '1')?.content[0])
        .toMatchObject({ type: 'tool-call', toolName: 'exec', toolCallId: 'call', input: '{partial' });
    }
    expect(normalizeCodexEntry({ type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 'call', output: 'done' } }, {}, '2'))
      .toMatchObject({ role: 'user', content: [{ type: 'tool-result', output: 'done' }] });
    expect(normalizeCodexEntry({ type: 'response_item', payload: { type: 'reasoning', encrypted_content: 'secret', summary: [] } }, {}, '3')).toBeNull();
    const summary = normalizeCodexEntry({ type: 'response_item', payload: { type: 'reasoning', encrypted_content: 'secret', summary: [{ text: 'Public summary' }] } }, {}, '4');
    expect(JSON.stringify(summary)).not.toContain('secret');
  });
});
