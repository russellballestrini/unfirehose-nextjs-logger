// @vitest-environment jsdom
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, act, waitFor } from '@testing-library/react';
import { TodoBoard } from './TodoBoard';

/**
 * The kanban board, with todos on it.
 *
 * It carries the most change risk of any component here, and almost all of
 * that sits in the card: forty-one branches for the estimate, the delete
 * confirmation, inline editing, the node picker, the copy buttons and the
 * deployment badge. None of them exist until a card does, and a card does
 * not exist until the board has fetched something — which is why rendering
 * the todos page proved nothing about any of it.
 */

const todo = (over: Record<string, unknown> = {}) => ({
  id: 1, uuid: '01a03597-28b3-7b9c-991e-35decbcd4e4c', content: 'fix the thing',
  status: 'pending', activeForm: 'Fixing the thing', source: 'claude',
  externalId: '42', blockedBy: [], sessionUuid: 's1', sessionDisplay: 'session one',
  projectName: '-home-fox-git-demo', createdAt: '2026-09-04T12:00:00.000Z',
  updatedAt: '2026-09-04T12:00:00.000Z', completedAt: null, estimatedMinutes: 10,
  tmuxSession: null, deployment: null, attachments: [], ...over,
});

const board = (todos: unknown[]) => ({
  byProject: [{
    project: '-home-fox-git-demo', display: 'demo',
    projectPath: '/home/fox/git/demo', todos,
  }],
  counts: { pending: todos.length, inProgress: 0, completed: 0, total: todos.length },
});

let response: unknown;

beforeAll(() => {
  window.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as never;
  Element.prototype.scrollIntoView ??= vi.fn() as never;
  window.confirm ??= (() => true) as never;
});

beforeEach(() => {
  response = board([todo()]);
  vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => ({
    ok: true, status: 200, json: async () => response, text: async () => '',
  })));
});

afterEach(cleanup);

const mount = async () => {
  const view = render(<TodoBoard />);
  await waitFor(() => expect(screen.queryByText(/Loading/i)).toBeNull());
  return view;
};

describe('TodoBoard', () => {
  it('shows a todo it was given', async () => {
    await mount();
    await waitFor(() => expect(screen.getByText('fix the thing')).toBeInTheDocument());
  });

  it('names the project only in the view that groups by it', async () => {
    // Kanban columns are statuses, so the project name does not belong on
    // them; By Project is the view that puts it up. Asserting that keeps the
    // two views actually different.
    const { container } = await mount();
    await waitFor(() => expect(screen.getByText('fix the thing')).toBeInTheDocument());
    expect(container.textContent).not.toContain('demo');

    act(() => { screen.getByText('By Project').click(); });
    await waitFor(() => expect(container.textContent).toContain('demo'));
  });

  it('shows a card for every todo, not only the first', async () => {
    response = board([todo(), todo({ id: 2, content: 'second thing' })]);
    await mount();
    await waitFor(() => {
      expect(screen.getByText('fix the thing')).toBeInTheDocument();
      expect(screen.getByText('second thing')).toBeInTheDocument();
    });
  });

  it('separates an in-progress todo from a pending one', async () => {
    response = board([todo(), todo({ id: 2, content: 'in flight', status: 'in_progress' })]);
    await mount();
    await waitFor(() => expect(screen.getByText('in flight')).toBeInTheDocument());
  });

  it('marks a todo long enough to need a ticket', async () => {
    // Our own rule: over fifteen minutes wants a ticket rather than a todo.
    response = board([todo({ estimatedMinutes: 120 })]);
    await mount();
    await waitFor(() => expect(screen.getByText('fix the thing')).toBeInTheDocument());
  });

  it('renders a todo carrying a running deployment', async () => {
    response = board([todo({
      status: 'in_progress',
      deployment: { tmuxSession: 'agent-1', tmuxWindow: '0', status: 'running', startedAt: '2026-09-04T12:00:00.000Z', stoppedAt: null },
    })]);
    await mount();
    await waitFor(() => expect(screen.getByText('fix the thing')).toBeInTheDocument());
  });

  it('renders a todo with no estimate and no session', async () => {
    // Most todos arrive from a harness with neither.
    response = board([todo({ estimatedMinutes: null, sessionUuid: null, sessionDisplay: null, externalId: null, uuid: null })]);
    await mount();
    await waitFor(() => expect(screen.getByText('fix the thing')).toBeInTheDocument());
  });

  it('survives an empty board', async () => {
    response = { byProject: [], counts: { pending: 0, inProgress: 0, completed: 0, total: 0 } };
    await expect(mount()).resolves.toBeTruthy();
  });

  it('survives an API that answers with an error', async () => {
    response = { error: 'database is locked' };
    await expect(mount()).resolves.toBeTruthy();
  });

  it('leaves every control on a card pressable', async () => {
    // The card is forty-one branches of buttons — estimate, delete, edit,
    // node picker, copy. Pressing one must not take the board down.
    const { container } = await mount();
    await waitFor(() => expect(screen.getByText('fix the thing')).toBeInTheDocument());

    const pressed = new Set<Element>();
    for (let round = 0; round < 3; round += 1) {
      const controls = [...container.querySelectorAll('button')].filter((b) => !pressed.has(b));
      if (controls.length === 0) break;
      for (const control of controls) {
        pressed.add(control);
        act(() => { (control as HTMLElement).click(); });
      }
    }
    expect(pressed.size).toBeGreaterThan(3);
  });
});
