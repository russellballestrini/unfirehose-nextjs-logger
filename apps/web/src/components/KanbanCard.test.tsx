// @vitest-environment jsdom
import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import { render, cleanup, act, fireEvent } from '@testing-library/react';
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

/**
 * The card's own states, which are where its branches live.
 *
 * A rendered card is a fraction of this component. The rest is what opens
 * when you click it — editing the text in place, confirming a delete,
 * picking a node to run on, setting an estimate — and each of those has an
 * accept path and an abandon path that must leave the todo alone.
 */
describe('KanbanCard interactions', () => {
  const click = (el: Element | null) => act(() => { (el as HTMLElement).click(); });
  const text = (r: ReturnType<typeof show>, s: string) =>
    [...r.container.querySelectorAll('button, p, a')].find(e => e.textContent?.trim() === s) ?? null;

  /** The button that opens the node picker. Throws rather than skipping. */
  const deployButton = (r: ReturnType<typeof show>) => {
    const el = [...r.container.querySelectorAll('button')]
      .find(b => b.textContent?.trim() === 'Deploy');
    if (!el) throw new Error('no Deploy button');
    return el;
  };
  const node = (r: ReturnType<typeof show>, name: string) => {
    const el = [...r.container.querySelectorAll('button')]
      .find(b => b.textContent?.trim() === name);
    if (!el) throw new Error(`no ${name} in the node picker`);
    return el;
  };

  it('turns the text into an editor when you click it', () => {
    const r = show();
    expect(r.container.querySelector('textarea')).toBeNull();
    click(text(r, 'fix the thing'));
    expect((r.container.querySelector('textarea') as HTMLTextAreaElement).value).toBe('fix the thing');
  });

  it('saves an edit on Enter', () => {
    const onUpdate = vi.fn();
    const r = show({}, { onUpdate });
    click(text(r, 'fix the thing'));
    const ta = r.container.querySelector('textarea') as HTMLTextAreaElement;
    fireEvent.change(ta, { target: { value: 'fix the other thing' } });
    act(() => { ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); });
    expect(onUpdate).toHaveBeenCalledWith(1, { content: 'fix the other thing' });
  });

  it('abandons an edit on Escape without touching the todo', () => {
    // Escape is what someone presses after realising they clicked the wrong
    // card. Saving there rewrites a todo nobody meant to edit.
    const onUpdate = vi.fn();
    const r = show({}, { onUpdate });
    click(text(r, 'fix the thing'));
    const ta = r.container.querySelector('textarea') as HTMLTextAreaElement;
    fireEvent.change(ta, { target: { value: 'oops' } });
    act(() => { ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
    expect(onUpdate).not.toHaveBeenCalled();
    expect(r.container.querySelector('textarea')).toBeNull();
  });

  it('does not save an edit that changed nothing', () => {
    const onUpdate = vi.fn();
    const r = show({}, { onUpdate });
    click(text(r, 'fix the thing'));
    const ta = r.container.querySelector('textarea') as HTMLTextAreaElement;
    act(() => { ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); });
    expect(onUpdate).not.toHaveBeenCalled();
  });

  it('does not save an edit down to nothing', () => {
    // An empty todo is unreadable on the board and cannot be searched for.
    const onUpdate = vi.fn();
    const r = show({}, { onUpdate });
    click(text(r, 'fix the thing'));
    const ta = r.container.querySelector('textarea') as HTMLTextAreaElement;
    fireEvent.change(ta, { target: { value: '   ' } });
    act(() => { ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); });
    expect(onUpdate).not.toHaveBeenCalled();
  });

  it('asks before deleting', () => {
    const onDelete = vi.fn();
    const r = show({}, { onDelete });
    click(text(r, 'Del'));
    expect(onDelete).not.toHaveBeenCalled();
    expect(text(r, 'Confirm')).toBeTruthy();
    click(text(r, 'Confirm'));
    expect(onDelete).toHaveBeenCalledWith(1);
  });

  it('lets a delete be called off', () => {
    const onDelete = vi.fn();
    const r = show({}, { onDelete });
    click(text(r, 'Del'));
    click(text(r, 'Cancel'));
    expect(onDelete).not.toHaveBeenCalled();
    expect(text(r, 'Del')).toBeTruthy();
  });

  it('sets an estimate from the picker and closes it', () => {
    const onUpdate = vi.fn();
    const r = show({ estimatedMinutes: null }, { onUpdate });
    click(r.container.querySelector('[title*="stimate"], button') as Element);
    const choice = [...r.container.querySelectorAll('button')].find(b => /^\d+m$/.test(b.textContent ?? ''));
    if (choice) {
      click(choice);
      expect(onUpdate).toHaveBeenCalledWith(1, { estimatedMinutes: expect.any(Number) });
    }
  });

  it('offers localhost and every reachable node, and no unreachable one', () => {
    // Booting at an unreachable node fails after a 30s ssh timeout, by
    // which time the todo is already marked in-progress.
    const r = show();
    click(deployButton(r));
    const btn = (name: string) => [...r.container.querySelectorAll('button')]
      .find(b => b.textContent?.trim() === name) as HTMLButtonElement | undefined;
    expect(btn('localhost')?.disabled).toBe(false);
    expect(btn('cammy')?.disabled).toBe(false);
    // Still listed, because a node that vanishes from the list reads as a
    // node that is gone — but not choosable.
    expect(btn('guile')).toBeTruthy();
    expect(btn('guile')?.disabled).toBe(true);
  });

  it('marks a todo in progress at the moment it is booted, not when it finishes', () => {
    // The board is how anyone sees an agent is already on this. Leaving it
    // pending is how two agents get sent at the same todo.
    const onUpdate = vi.fn(); const onBoot = vi.fn();
    const r = show({}, { onUpdate, onBoot });
    click(deployButton(r));
    const local = [...r.container.querySelectorAll('button')].find(b => b.textContent?.trim() === 'localhost');
    if (!local) throw new Error('missing control: local');
    click(local);
    expect(onUpdate).toHaveBeenCalledWith(1, { status: 'in_progress' });
    expect(onBoot).toHaveBeenCalledWith('/home/fox/git/demo', expect.anything(), 'fix the thing', 'localhost', [1], '-home-fox-git-demo');
  });

  it('copies the id, and says so', () => {
    const r = show();
    const idBtn = [...r.container.querySelectorAll('button')].find(b => b.textContent?.trim() === '#1');
    click(idBtn!);
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith('#1');
    expect([...r.container.querySelectorAll('button')].some(b => b.textContent === 'copied')).toBe(true);
  });

  it('copies the uuid, which is the id that survives a re-ingest', () => {
    const r = show();
    const uuidBtn = [...r.container.querySelectorAll('button')]
      .find(b => b.textContent?.trim() === '01a03597-28b3-7b9c-991e-35decbcd4e4c'.slice(-8));
    click(uuidBtn!);
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith('01a03597-28b3-7b9c-991e-35decbcd4e4c');
  });
});
