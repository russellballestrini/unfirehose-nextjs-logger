import type { UfMessage } from './session-paths';

export interface CodexState {
  sessionId?: string;
  cwd?: string;
  model?: string;
  totals?: Record<string, number>;
}

// Rollouts are an event envelope, not bare Responses API objects. Only
// response_item carries transcript content; event_msg repeats that content.
// Never copy encrypted reasoning or the session's base instructions.
export function normalizeCodexEntry(raw: any, state: CodexState, id: string): UfMessage | null {
  const p = raw.payload ?? {};
  if (raw.type === 'session_meta') {
    state.sessionId = p.id ?? p.session_id;
    state.cwd = p.cwd;
    return null;
  }
  if (raw.type === 'turn_context') {
    state.model = p.model;
    return null;
  }
  const message: UfMessage = {
    $schema: 'unfirehose/1.0', type: 'message', role: 'assistant', id,
    sessionId: state.sessionId, cwd: state.cwd, model: state.model,
    timestamp: raw.timestamp, harness: 'codex', content: [],
  };
  if (raw.type === 'event_msg' && p.type === 'token_count') {
    const totals = p.info?.total_token_usage;
    if (!totals) return null;
    const delta = (key: string) => Math.max(0, (totals[key] ?? 0) - (state.totals?.[key] ?? 0));
    const input = delta('input_tokens'), cached = delta('cached_input_tokens');
    const output = delta('output_tokens'), write = delta('cache_write_input_tokens');
    state.totals = totals;
    if (!input && !output && !cached && !write) return null;
    message.usage = {
      inputTokens: Math.max(0, input - cached), outputTokens: output,
      inputTokenDetails: { cacheReadTokens: cached, cacheWriteTokens: write },
    };
    message.subtype = 'usage';
    return message;
  }
  if (raw.type !== 'response_item') return null;
  switch (p.type) {
    case 'message':
      message.role = p.role === 'developer' ? 'system' : p.role;
      message.content = (p.content ?? []).filter((b: any) => b.type === 'input_text' || b.type === 'output_text')
        .map((b: any) => ({ type: 'text', text: b.text }));
      break;
    case 'function_call':
    case 'custom_tool_call':
      // Preserve the actual argument string, including incomplete/invalid JSON.
      message.content = [{ type: 'tool-call', toolName: p.name, toolCallId: p.call_id, input: p.arguments ?? p.input }];
      break;
    case 'function_call_output':
    case 'custom_tool_call_output':
      message.role = 'user'; // Database stores tool results on user messages.
      message.content = [{ type: 'tool-result', toolCallId: p.call_id, output: p.output }];
      break;
    case 'reasoning':
      message.content = (p.summary ?? []).filter((b: any) => typeof b.text === 'string')
        .map((b: any) => ({ type: 'reasoning', text: b.text }));
      break;
    default: return null;
  }
  return message.content.length ? message : null;
}
