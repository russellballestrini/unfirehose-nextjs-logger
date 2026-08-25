import { describe, it, expect } from 'vitest';
import {
  entryRole,
  extractTools,
  extractToolResults,
  extractText,
  extractReasoningInfo,
  isToolPlaceholder,
  summarizeEntry,
  toolDetail,
} from './stream-blocks.js';

// Shapes taken verbatim from real captured JSONL:
//   ~/.uncloseai/unfirehose/home-fox-git-contra/*.jsonl  (unfirehose/1.0)
//   ~/.claude/projects/*/*.jsonl                         (Claude Code)

const UNCLOSE_ASSISTANT_TOOL = {
  $schema: 'unfirehose/1.0',
  type: 'message',
  role: 'assistant',
  content: [
    { type: 'text', text: '[→ bash]' },
    { type: 'tool-call', toolName: 'bash', toolCallId: 'tc1', input: { command: 'make -j8' } },
  ],
};

const UNCLOSE_USER_RESULT = {
  type: 'message',
  role: 'user',
  content: [
    {
      type: 'tool-result',
      toolName: 'grep',
      toolCallId: 'tc1',
      isError: false,
      output: '121:        const float VIEW_H = 14.0f;\n122: more',
    },
  ],
};

const CLAUDE_ASSISTANT_TOOL = {
  type: 'assistant',
  message: {
    content: [
      { type: 'text', text: 'Let me build it.' },
      { type: 'tool_use', name: 'Bash', id: 'tu1', input: { command: 'make -j8' } },
    ],
  },
};

const CLAUDE_USER_RESULT = {
  type: 'user',
  message: {
    content: [
      { type: 'tool_result', tool_use_id: 'tu1', is_error: false, content: 'build ok' },
    ],
  },
};

describe('entryRole', () => {
  it('reads both envelope shapes', () => {
    expect(entryRole(UNCLOSE_ASSISTANT_TOOL)).toBe('assistant');
    expect(entryRole(CLAUDE_ASSISTANT_TOOL)).toBe('assistant');
    expect(entryRole(UNCLOSE_USER_RESULT)).toBe('user');
    expect(entryRole(CLAUDE_USER_RESULT)).toBe('user');
    expect(entryRole({ type: 'session' })).toBe('unknown');
  });
});

describe('the defect: uncloseai tool calls were invisible', () => {
  it('extracts a tool-call from unfirehose/1.0', () => {
    const tools = extractTools(UNCLOSE_ASSISTANT_TOOL);
    expect(tools).toHaveLength(1);
    expect(tools[0].name).toBe('bash');
    expect(tools[0].id).toBe('tc1');
    expect(tools[0].detail).toBe('make -j8');
  });

  it('still extracts a tool_use from Claude Code', () => {
    const tools = extractTools(CLAUDE_ASSISTANT_TOOL);
    expect(tools).toHaveLength(1);
    expect(tools[0].name).toBe('Bash');
    expect(tools[0].detail).toBe('make -j8');
  });

  it('extracts a tool-result from unfirehose/1.0', () => {
    const r = extractToolResults(UNCLOSE_USER_RESULT);
    expect(r).toHaveLength(1);
    expect(r[0].toolName).toBe('grep');
    expect(r[0].content).toContain('VIEW_H');
    expect(r[0].isError).toBe(false);
  });

  it('still extracts a tool_result from Claude Code', () => {
    const r = extractToolResults(CLAUDE_USER_RESULT);
    expect(r).toHaveLength(1);
    expect(r[0].content).toBe('build ok');
  });

  it('flags an errored unfirehose result', () => {
    const e = { type: 'message', role: 'user', content: [
      { type: 'tool-result', toolName: 'bash', toolCallId: 'x', isError: true, output: 'boom' },
    ] };
    expect(extractToolResults(e)[0].isError).toBe(true);
  });
});

describe('tool placeholders are not content', () => {
  it('recognises what uncloseai-cli writes into the text block', () => {
    for (const p of ['[→ bash]', '[→ edit]', '[→ vision]', '  [→ apply_patch]  ', '[-> read]']) {
      expect(isToolPlaceholder(p)).toBe(true);
    }
  });

  it('does not eat real prose that mentions a tool', () => {
    for (const s of ['run [→ bash] then check', 'Done — camera zoomed in.', '[note] see below']) {
      expect(isToolPlaceholder(s)).toBe(false);
    }
  });

  it('drops the placeholder so callers can fall back to tool detail', () => {
    expect(extractText(UNCLOSE_ASSISTANT_TOOL)).toBe('');
    expect(extractText(UNCLOSE_ASSISTANT_TOOL, { stripPlaceholders: false })).toBe('[→ bash]');
  });

  it('keeps genuine assistant prose', () => {
    const e = { type: 'message', role: 'assistant', content: [
      { type: 'text', text: 'Done — camera zoomed in and verified on screen.' },
    ] };
    expect(extractText(e)).toBe('Done — camera zoomed in and verified on screen.');
  });
});

describe('toolDetail picks the field worth showing', () => {
  it('uses per-tool rules, case-insensitively across harnesses', () => {
    expect(toolDetail('bash', { command: 'ls -la' })).toBe('ls -la');
    expect(toolDetail('Bash', { command: 'ls -la' })).toBe('ls -la');
    expect(toolDetail('read', { path: '/x/y.c', offset: 1, limit: 20 })).toBe('/x/y.c');
    expect(toolDetail('Read', { file_path: '/x/y.c' })).toBe('/x/y.c');
    expect(toolDetail('fetch', { url: 'https://a.b' })).toBe('https://a.b');
    expect(toolDetail('search', { query: 'contra sprites' })).toBe('contra sprites');
    expect(toolDetail('delegate', { role: 'coder', task: 'port kernel' })).toBe('port kernel');
  });

  it('shows grep pattern with its path', () => {
    expect(toolDetail('grep', { pattern: 'VIEW_H', path: 'src' })).toBe('/VIEW_H/ in src');
  });

  it('falls back generically for a tool it has never seen', () => {
    expect(toolDetail('some_new_tool', { url: 'https://x' })).toBe('https://x');
    expect(toolDetail('some_new_tool', { nothing: 1 })).toBeUndefined();
  });
});

describe('summarizeEntry — a row never renders blank when it has content', () => {
  it('summarizes an uncloseai tool call as tool + argument', () => {
    expect(summarizeEntry(UNCLOSE_ASSISTANT_TOOL)).toBe('bash: make -j8');
  });

  it('summarizes an uncloseai tool result as tool + first output line', () => {
    const s = summarizeEntry(UNCLOSE_USER_RESULT);
    expect(s.startsWith('grep → ')).toBe(true);
    expect(s).toContain('VIEW_H');
  });

  it('prefers real prose over tool detail', () => {
    expect(summarizeEntry(CLAUDE_ASSISTANT_TOOL)).toBe('Let me build it.');
  });

  it('truncates long text', () => {
    const e = { type: 'message', role: 'assistant', content: [{ type: 'text', text: 'x'.repeat(500) }] };
    expect(summarizeEntry(e, 50)).toHaveLength(51); // 50 + ellipsis
  });

  it('returns empty for an entry that genuinely has nothing', () => {
    expect(summarizeEntry({ type: 'message', role: 'system', content: [] })).toBe('');
  });

  it('handles several tool calls in one turn', () => {
    const e = { type: 'message', role: 'assistant', content: [
      { type: 'tool-call', toolName: 'read', input: { path: '/a' } },
      { type: 'tool-call', toolName: 'bash', input: { command: 'ls' } },
    ] };
    expect(summarizeEntry(e)).toBe('read: /a · bash: ls');
  });
});

describe('reasoning', () => {
  it('reads both block names and reports sealed reasoning', () => {
    const claude = { type: 'assistant', message: { content: [{ type: 'thinking', thinking: 'hmm' }] } };
    const uf = { type: 'message', role: 'assistant', content: [{ type: 'reasoning', text: 'hmm' }] };
    const sealed = { type: 'message', role: 'assistant', content: [{ type: 'reasoning', text: '', signature: 'sig' }] };
    expect(extractReasoningInfo(claude)!.text).toBe('hmm');
    expect(extractReasoningInfo(uf)!.text).toBe('hmm');
    expect(extractReasoningInfo(sealed)!.sealed).toBe(true);
    expect(extractReasoningInfo(UNCLOSE_USER_RESULT)).toBeNull();
  });
});
