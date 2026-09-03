import { describe, it, expect } from 'vitest';
import { classifyClaudeApiError, normalizeClaudeCodeEntry } from './claude-code-adapter';

// Every shape here is a real row from ~/.claude/projects, fields trimmed.
const overloaded = {
  type: 'assistant', timestamp: '2026-09-03T13:40:25.031Z', requestId: 'req_011CegbnMJeEuSTNbe3TsF4K',
  error: 'server_error', isApiErrorMessage: true, apiErrorStatus: 529, uuid: 'u1',
  message: { role: 'assistant', model: '<synthetic>', content: [{ type: 'text', text: 'API Error: 529 Overloaded. This is a server-side issue, usually temporary — try again in a moment. If it persists, check https://status.claude.com.' }], usage: { input_tokens: 0, output_tokens: 0 } },
};
const sessionLimit = {
  type: 'assistant', error: 'rate_limit', isApiErrorMessage: true, apiErrorStatus: 429, uuid: 'u2',
  message: { role: 'assistant', model: '<synthetic>', content: [{ type: 'text', text: "You've hit your session limit · resets 11:30am (America/New_York)" }] },
};
const unreachable = {
  type: 'assistant', error: 'server_error', isApiErrorMessage: true, uuid: 'u3',
  message: { role: 'assistant', model: '<synthetic>', content: [{ type: 'text', text: 'API Error: Unable to connect to API (ENOTIMP)' }] },
};
const loginExpired = {
  type: 'assistant', error: 'authentication_failed', isApiErrorMessage: true, uuid: 'u4',
  message: { role: 'assistant', model: '<synthetic>', content: [{ type: 'text', text: 'Login expired · Please run /login' }] },
};
const tooLong = {
  type: 'assistant', error: 'invalid_request', isApiErrorMessage: true, apiErrorStatus: 400, uuid: 'u5',
  message: { role: 'assistant', model: '<synthetic>', content: [{ type: 'text', text: 'Prompt is too long' }] },
};

describe('classifyClaudeApiError', () => {
  it('529 is the provider overloaded — an outage, not our usage', () => {
    const r = classifyClaudeApiError(overloaded)!;
    expect(r.kind).toBe('overloaded');
    expect(r.status).toBe(529);
    expect(r.detail.startsWith('API Error: 529 Overloaded')).toBe(true);
  });

  it('session limit is quota: wait for the reset, do not back off', () => {
    expect(classifyClaudeApiError(sessionLimit)!.kind).toBe('quota');
  });

  it('a generic rate_limit without quota wording stays rate_limit', () => {
    const r = classifyClaudeApiError({ ...sessionLimit, message: { role: 'assistant', content: [{ type: 'text', text: 'Too many requests' }] } })!;
    expect(r.kind).toBe('rate_limit');
    expect(r.status).toBe(429);
  });

  it('unable to connect is a server error with no status', () => {
    const r = classifyClaudeApiError(unreachable)!;
    expect(r.kind).toBe('server_error');
    expect(r.status).toBeNull();
  });

  it('our own failures are not refusals', () => {
    expect(classifyClaudeApiError(loginExpired)).toBeNull();
    expect(classifyClaudeApiError(tooLong)).toBeNull();
  });

  it('an ordinary assistant row is not an error', () => {
    expect(classifyClaudeApiError({ type: 'assistant', message: { content: [{ type: 'text', text: 'API Error: 529 Overloaded' }] } })).toBeNull();
  });
});

describe('normalizeClaudeCodeEntry carries the refusal', () => {
  it('attaches the classified refusal and drops the synthetic model', () => {
    const n = normalizeClaudeCodeEntry(overloaded)!;
    expect(n.refusal).toEqual({ kind: 'overloaded', status: 529, detail: expect.stringContaining('529 Overloaded') });
    expect(n.model).toBeNull();
    expect(n.content[0]).toEqual({ type: 'text', text: expect.stringContaining('529 Overloaded') });
  });

  it('a real row has no refusal and keeps its model', () => {
    const n = normalizeClaudeCodeEntry({ type: 'assistant', uuid: 'u9', message: { role: 'assistant', model: 'claude-opus-5', content: [{ type: 'text', text: 'hi' }] } })!;
    expect(n.refusal).toBeNull();
    expect(n.model).toBe('claude-opus-5');
  });
});
