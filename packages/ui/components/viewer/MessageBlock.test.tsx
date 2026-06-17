// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { MessageBlock } from './MessageBlock';

afterEach(() => cleanup());

// MessageBlock consumes canonical unfirehose/1.0:
//   { type: "message", role, content: [...blocks], model?, usage?, ... }

describe('MessageBlock', () => {
  describe('UserMessage', () => {
    it('renders user text from a text block', () => {
      const entry = {
        type: 'message',
        role: 'user',
        content: [{ type: 'text', text: 'Hello world' }],
      };
      render(<MessageBlock entry={entry} showThinking={true} showTools={true} />);
      expect(screen.getByText('Hello world')).toBeTruthy();
      expect(screen.getByText('USER')).toBeTruthy();
    });

    it('renders user text when content has multiple text blocks', () => {
      const entry = {
        type: 'message',
        role: 'user',
        content: [
          { type: 'text', text: 'Array content' },
          { type: 'text', text: 'second line' },
        ],
      };
      render(<MessageBlock entry={entry} showThinking={true} showTools={true} />);
      expect(screen.getByText(/Array content/)).toBeTruthy();
    });

    it('renders timestamp when present', () => {
      const entry = {
        type: 'message',
        role: 'user',
        timestamp: '2026-03-03T14:30:00Z',
        content: [{ type: 'text', text: 'test' }],
      };
      render(<MessageBlock entry={entry} showThinking={true} showTools={true} />);
      expect(screen.getByText(/2026-03-03/)).toBeTruthy();
    });
  });

  describe('AssistantMessage', () => {
    it('renders text blocks', () => {
      const entry = {
        type: 'message',
        role: 'assistant',
        model: 'claude-opus-4-6-20260301',
        content: [{ type: 'text', text: 'Response text' }],
      };
      render(<MessageBlock entry={entry} showThinking={true} showTools={true} />);
      expect(screen.getByText('Response text')).toBeTruthy();
    });

    it('renders model badge', () => {
      const entry = {
        type: 'message',
        role: 'assistant',
        model: 'claude-opus-4-6-20260301',
        content: [{ type: 'text', text: 'hi' }],
      };
      render(<MessageBlock entry={entry} showThinking={true} showTools={true} />);
      expect(screen.getByText('opus-4-6')).toBeTruthy();
    });

    it('renders token usage stats (unfirehose/1.0 camelCase)', () => {
      const entry = {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'text', text: 'hi' }],
        usage: { inputTokens: 1000, outputTokens: 500 },
      };
      render(<MessageBlock entry={entry} showThinking={true} showTools={true} />);
      expect(screen.getByText(/in:1,000/)).toBeTruthy();
    });

    it('renders reasoning block when showThinking is true', () => {
      const entry = {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'reasoning', text: 'Deep thought here' }],
      };
      render(<MessageBlock entry={entry} showThinking={true} showTools={true} />);
      expect(screen.getByText(/expand thinking/)).toBeTruthy();
    });

    it('hides reasoning block when showThinking is false', () => {
      const entry = {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'reasoning', text: 'Hidden thought' }],
      };
      render(<MessageBlock entry={entry} showThinking={false} showTools={true} />);
      expect(screen.queryByText(/expand thinking/)).toBeNull();
    });

    it('renders tool-call block when showTools is true', () => {
      const entry = {
        type: 'message',
        role: 'assistant',
        content: [{
          type: 'tool-call',
          toolCallId: 't1',
          toolName: 'Bash',
          input: { command: 'ls' },
        }],
      };
      render(<MessageBlock entry={entry} showThinking={true} showTools={true} />);
      expect(screen.getByText(/Bash/)).toBeTruthy();
    });

    it('hides tool-call block when showTools is false', () => {
      const entry = {
        type: 'message',
        role: 'assistant',
        content: [{
          type: 'tool-call',
          toolCallId: 't1',
          toolName: 'Bash',
          input: { command: 'ls' },
        }],
      };
      render(<MessageBlock entry={entry} showThinking={true} showTools={false} />);
      expect(screen.queryByText(/Bash/)).toBeNull();
    });
  });

  describe('ToolMessage', () => {
    it('renders a tool-result block when showTools is true', () => {
      const entry = {
        type: 'message',
        role: 'tool',
        content: [{
          type: 'tool-result',
          toolCallId: 't1',
          toolName: 'Bash',
          output: 'hello',
          isError: false,
        }],
      };
      render(<MessageBlock entry={entry} showThinking={true} showTools={true} />);
      expect(screen.getByText(/Bash → result/)).toBeTruthy();
    });

    it('marks tool-result as error when isError is true', () => {
      const entry = {
        type: 'message',
        role: 'tool',
        content: [{
          type: 'tool-result',
          toolCallId: 't1',
          toolName: 'Bash',
          output: 'boom',
          isError: true,
        }],
      };
      render(<MessageBlock entry={entry} showThinking={true} showTools={true} />);
      expect(screen.getByText(/Bash → error/)).toBeTruthy();
    });
  });

  describe('SystemMessage', () => {
    it('renders turn duration for turn_duration subtype', () => {
      const entry = { type: 'message', role: 'system', subtype: 'turn_duration', durationMs: 5000, content: [] };
      render(<MessageBlock entry={entry} showThinking={true} showTools={true} />);
      expect(screen.getByText(/turn: 5s/)).toBeTruthy();
    });

    it('renders subtype label for other system events', () => {
      const entry = { type: 'message', role: 'system', subtype: 'init', content: [] };
      render(<MessageBlock entry={entry} showThinking={true} showTools={true} />);
      expect(screen.getByText(/system: init/)).toBeTruthy();
    });

    it('renders slug when present', () => {
      const entry = { type: 'message', role: 'system', subtype: 'event', slug: 'test-slug', content: [] };
      render(<MessageBlock entry={entry} showThinking={true} showTools={true} />);
      expect(screen.getByText(/test-slug/)).toBeTruthy();
    });
  });

  it('returns null for unknown roles', () => {
    const entry = { type: 'message', role: 'progress', content: [] };
    const { container } = render(
      <MessageBlock entry={entry} showThinking={true} showTools={true} />
    );
    expect(container.innerHTML).toBe('');
  });
});
