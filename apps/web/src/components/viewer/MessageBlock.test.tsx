// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { MessageBlock } from './MessageBlock';

afterEach(() => cleanup());

describe('MessageBlock', () => {
  describe('UserMessage', () => {
    it('renders user text when content is a string', () => {
      const entry = { type: 'user', message: { content: 'Hello world' } };
      render(<MessageBlock entry={entry} showThinking={true} showTools={true} />);
      expect(screen.getByText('Hello world')).toBeTruthy();
      expect(screen.getByText('USER')).toBeTruthy();
    });

    it('renders user text when content is an array of text blocks', () => {
      const entry = {
        type: 'user',
        message: { content: [{ type: 'text', text: 'Array content' }] },
      };
      render(<MessageBlock entry={entry} showThinking={true} showTools={true} />);
      expect(screen.getByText('Array content')).toBeTruthy();
    });

    it('renders timestamp when present', () => {
      const entry = {
        type: 'user',
        timestamp: '2026-03-03T14:30:00Z',
        message: { content: 'test' },
      };
      render(<MessageBlock entry={entry} showThinking={true} showTools={true} />);
      // formatTimestamp produces yyyy-MM-dd HH:mm:ss format
      expect(screen.getByText(/2026-03-03/)).toBeTruthy();
    });
  });

  describe('AssistantMessage', () => {
    it('renders text blocks', () => {
      const entry = {
        type: 'assistant',
        message: {
          model: 'claude-opus-4-6-20260301',
          content: [{ type: 'text', text: 'Response text' }],
        },
      };
      render(<MessageBlock entry={entry} showThinking={true} showTools={true} />);
      expect(screen.getByText('Response text')).toBeTruthy();
    });

    it('renders model badge', () => {
      const entry = {
        type: 'assistant',
        message: {
          model: 'claude-opus-4-6-20260301',
          content: [{ type: 'text', text: 'hi' }],
        },
      };
      render(<MessageBlock entry={entry} showThinking={true} showTools={true} />);
      expect(screen.getByText('opus-4-6')).toBeTruthy();
    });

    it('renders token usage stats', () => {
      const entry = {
        type: 'assistant',
        message: {
          content: [{ type: 'text', text: 'hi' }],
          usage: { input_tokens: 1000, output_tokens: 500 },
        },
      };
      render(<MessageBlock entry={entry} showThinking={true} showTools={true} />);
      expect(screen.getByText(/in:1,000/)).toBeTruthy();
    });

    it('renders thinking block when showThinking is true', () => {
      const entry = {
        type: 'assistant',
        message: {
          content: [{ type: 'thinking', thinking: 'Deep thought here' }],
        },
      };
      render(<MessageBlock entry={entry} showThinking={true} showTools={true} />);
      expect(screen.getByText(/expand thinking/)).toBeTruthy();
    });

    it('hides thinking block when showThinking is false', () => {
      const entry = {
        type: 'assistant',
        message: {
          content: [{ type: 'thinking', thinking: 'Hidden thought' }],
        },
      };
      render(<MessageBlock entry={entry} showThinking={false} showTools={true} />);
      expect(screen.queryByText(/expand thinking/)).toBeNull();
    });

    it('renders tool use block when showTools is true', () => {
      const entry = {
        type: 'assistant',
        message: {
          content: [{ type: 'tool_use', name: 'Bash', input: { command: 'ls' } }],
        },
      };
      render(<MessageBlock entry={entry} showThinking={true} showTools={true} />);
      expect(screen.getByText(/Bash/)).toBeTruthy();
    });

    it('hides tool use block when showTools is false', () => {
      const entry = {
        type: 'assistant',
        message: {
          content: [{ type: 'tool_use', name: 'Bash', input: { command: 'ls' } }],
        },
      };
      render(<MessageBlock entry={entry} showThinking={true} showTools={false} />);
      expect(screen.queryByText(/Bash/)).toBeNull();
    });
  });

  describe('SystemMessage', () => {
    it('renders turn duration for turn_duration subtype', () => {
      const entry = { type: 'system', subtype: 'turn_duration', durationMs: 5000 };
      render(<MessageBlock entry={entry} showThinking={true} showTools={true} />);
      expect(screen.getByText(/turn: 5s/)).toBeTruthy();
    });

    it('renders subtype label for other system events', () => {
      const entry = { type: 'system', subtype: 'init' };
      render(<MessageBlock entry={entry} showThinking={true} showTools={true} />);
      expect(screen.getByText(/system: init/)).toBeTruthy();
    });

    it('renders slug when present', () => {
      const entry = { type: 'system', subtype: 'event', slug: 'test-slug' };
      render(<MessageBlock entry={entry} showThinking={true} showTools={true} />);
      expect(screen.getByText(/test-slug/)).toBeTruthy();
    });
  });

  it('returns null for unknown entry types', () => {
    const entry = { type: 'progress', data: 'something' };
    const { container } = render(
      <MessageBlock entry={entry} showThinking={true} showTools={true} />
    );
    expect(container.innerHTML).toBe('');
  });
});
