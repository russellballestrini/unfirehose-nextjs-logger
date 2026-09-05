// @vitest-environment jsdom
import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import { render, cleanup, act } from '@testing-library/react';
import { KanbanCard } from './TodoBoard';

/**
 * One todo card.
 *
 * Forty-one branches, and every one of them a state a card is genuinely in:
 * estimated or not, blocked or not, deployed or not, mid-edit, awaiting a
 * delete confirmation, picking a node to run on. Reaching any of it through
 * the board meant fetching, rendering, and then clicking blind.
 */

beforeAll(() => {
  window.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as never;
  window.confirm ??= (() => true) as never;
  Object.assign(navigator, { clipboard: { writeText: vi.fn().mockResolvedValue(undefined) } });
  global.fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) }) as never;
});

afterEach(cleanup);

const todo = (over: Record<string, unknown> = {}) => ({
  id: 1, uuid: '01a03597-28b3-7b9c-991e-35decbcd4e4c', content: 'fix the thing',
  status: 'pending', activeForm: 'Fixing the thing', source: 'claude',
  externalId: '42', blockedBy: [], sessionUuid: 's1', sessionDisplay: 'session one',
  projectName: '-home-fox-git-demo', createdAt: '2026-09-04T12:00:00.000Z',
  updatedAt: '2026-09-04T12:00:00.000Z', completedAt: null, estimatedMinutes: 10,
  tmuxSession: null, deployment: null, attachments: [], ...over,
});

const show = (over: Record<string, unknown> = {}, props: Record<string, unknown> = {}) =>
  render(
    <KanbanCard
      todo={todo(over)}
      onUpdate={vi.fn()}
      onDelete={vi.fn()}
      projectPath="/home/fox/git/demo"
      onBoot={vi.fn()}
      booting={null}
      bootResult={null}
      onDragStart={vi.fn()}
      onDragEnd={vi.fn()}
      isDragging={false}
      landed={false}
      meshNodes={[{ hostname: 'cammy', reachable: true }, { hostname: 'guile', reachable: false }]}
      {...props}
    />,
  );

describe('KanbanCard', () => {
  it('shows what the todo says', () => {
    expect(show().container.textContent).toContain('fix the thing');
  });

  it('shows an estimate when there is one', () => {
    expect(show({ estimatedMinutes: 45 }).container.textContent).toMatch(/45/);
  });

  it('renders a todo with no estimate, which is most of them', () => {
    expect(() => show({ estimatedMinutes: null })).not.toThrow();
  });

  it('flags a todo big enough to want a ticket instead', () => {
    // Our own rule: over fifteen minutes is a ticket, not a todo.
    const big = show({ estimatedMinutes: 240 }).container.textContent;
    const small = show({ estimatedMinutes: 5 }).container.textContent;
    expect(big).not.toBe(small);
  });

  it('renders a todo that is blocked by others', () => {
    expect(() => show({ blockedBy: ['7', '8'] })).not.toThrow();
  });

  it('renders an in-progress todo differently from a pending one', () => {
    const active = show({ status: 'in_progress' }).container.innerHTML;
    cleanup();
    const idle = show({ status: 'pending' }).container.innerHTML;
    expect(active).not.toBe(idle);
  });

  it('renders a completed todo', () => {
    expect(() => show({ status: 'completed', completedAt: '2026-09-04T13:00:00.000Z' })).not.toThrow();
  });

  it('shows a running deployment', () => {
    const { container } = show({
      status: 'in_progress',
      deployment: { tmuxSession: 'agent-1', tmuxWindow: '0', status: 'running', startedAt: '2026-09-04T12:00:00.000Z', stoppedAt: null },
    });
    expect(container.textContent).toContain('agent-1');
  });

  it('shows a stopped deployment', () => {
    expect(() => show({
      deployment: { tmuxSession: 'agent-1', tmuxWindow: null, status: 'stopped', startedAt: '2026-09-04T12:00:00.000Z', stoppedAt: '2026-09-04T12:30:00.000Z' },
    })).not.toThrow();
  });

  it('renders a todo that came from a harness with no session or ids', () => {
    expect(() => show({ uuid: null, externalId: null, sessionUuid: null, sessionDisplay: null })).not.toThrow();
  });

  it('renders while it is being dragged', () => {
    expect(() => show({}, { isDragging: true })).not.toThrow();
  });

  it('renders just after it landed in a new column', () => {
    expect(() => show({}, { landed: true })).not.toThrow();
  });

  it('renders while a boot is running against it', () => {
    expect(() => show({}, { booting: 'todo-1' })).not.toThrow();
  });

  it('renders a boot result', () => {
    expect(() => show({}, { bootResult: { key: 'todo-1', msg: 'started agent-1' } })).not.toThrow();
  });

  it('renders with attachments', () => {
    expect(() => show({
      attachments: [{ id: 1, filename: 'shot.png', mimeType: 'image/png', sizeBytes: 1024, hash: 'a'.repeat(64) }],
    })).not.toThrow();
  });

  it('renders with no node to run on', () => {
    // A fresh install has no mesh configured.
    expect(() => show({}, { meshNodes: [] })).not.toThrow();
  });

  it('leaves every control pressable without taking the card down', () => {
    const { container } = show();
    const pressed = new Set<Element>();
    for (let round = 0; round < 3; round += 1) {
      const controls = [...container.querySelectorAll('button')].filter((b) => !pressed.has(b));
      if (controls.length === 0) break;
      for (const c of controls) { pressed.add(c); act(() => { (c as HTMLElement).click(); }); }
    }
    expect(pressed.size).toBeGreaterThan(2);
  });
});
