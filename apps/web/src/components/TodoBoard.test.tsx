// @vitest-environment jsdom
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, act, waitFor, fireEvent } from '@testing-library/react';
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

/**
 * Dragging a card between columns.
 *
 * A drop is not a status change. Dropping onto in-progress boots an agent
 * against that todo, and dropping onto completed tells the boot route to
 * retire the agent's tmux window. Both are actions on a machine, driven by
 * a gesture, and neither is visible in the resulting board — which is why
 * the rules about which drops are allowed matter as much as what a drop
 * does.
 */
describe('TodoBoard — dragging', () => {
  /** Every request the board made, as method + path + parsed body. */
  const calls = () => (global.fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls
    .map(([url, init]) => ({
      url: String(url),
      method: (init as { method?: string } | undefined)?.method ?? 'GET',
      body: (() => {
        try { return JSON.parse((init as { body?: string } | undefined)?.body ?? 'null'); }
        catch { return null; }
      })(),
    }));

  const card = (text: string) => {
    const el = [...document.querySelectorAll('[data-kanban-col] [draggable="true"]')]
      .find(e => e.textContent?.includes(text));
    if (!el) throw new Error(`no card for ${text}`);
    return el;
  };

  const column = (key: string) => document.querySelector(`[data-kanban-col="${key}"]`);

  const dataTransfer = () => ({
    setData() {}, getData: () => '', setDragImage() {},
    effectAllowed: '', dropEffect: '', files: [],
  });

  const drag = async (from: string, to: string) => {
    const target = column(to);
    if (!target) throw new Error(`no column ${to}`);
    await act(async () => { fireEvent.dragStart(card(from), { dataTransfer: dataTransfer() }); });
    await act(async () => {
      fireEvent.drop(target, { dataTransfer: dataTransfer(), clientX: 100, clientY: 100 });
    });
  };

  it('starts the work when a pending todo is dragged into progress', async () => {
    // The drop is the whole gesture — nobody presses a second button — so
    // if this does not boot, the card moves and nothing happens.
    await mount();
    await waitFor(() => expect(card('fix the thing')).toBeTruthy());
    await drag('fix the thing', 'in_progress');

    await waitFor(() => {
      const patched = calls().find(c => c.url.includes('/api/todos') && c.method === 'PATCH');
      expect(patched?.body).toMatchObject({ id: 1, status: 'in_progress' });
    });
    await waitFor(() => {
      const booted = calls().find(c => c.url.includes('/api/boot') && c.method === 'POST');
      expect(booted?.body).toMatchObject({
        projectPath: '/home/fox/git/demo', prompt: 'fix the thing', todoIds: [1],
      });
    });
  });

  it('retires the agent when its todo is dragged to done', async () => {
    // Otherwise the tmux window stays open on whichever machine ran it,
    // and nothing on this board says so.
    response = board([todo({
      status: 'in_progress',
      deployment: { tmuxSession: 'demo', tmuxWindow: '120000', status: 'running', startedAt: '2026-09-04T12:00:00.000Z' },
    })]);
    await mount();
    await waitFor(() => expect(card('fix the thing')).toBeTruthy());
    await drag('fix the thing', 'completed');

    await waitFor(() => {
      const finished = calls().find(c => c.url.includes('/api/boot/finished'));
      expect(finished?.body).toEqual({ tmuxSession: 'demo', tmuxWindow: '120000' });
    });
  });

  it('does not boot again when a todo is dragged back out of progress', async () => {
    // Moving work back to pending is someone saying it is not being worked
    // on. Starting an agent there is the opposite.
    response = board([todo({ status: 'in_progress' })]);
    await mount();
    await waitFor(() => expect(card('fix the thing')).toBeTruthy());
    await drag('fix the thing', 'pending');

    await waitFor(() => {
      expect(calls().find(c => c.url.includes('/api/todos') && c.method === 'PATCH')?.body)
        .toMatchObject({ status: 'pending' });
    });
    expect(calls().some(c => c.url.includes('/api/boot') && c.method === 'POST')).toBe(false);
  });

  it('ignores a drop onto the column the card is already in', async () => {
    await mount();
    await waitFor(() => expect(screen.getByText('fix the thing')).toBeInTheDocument());
    const before = calls().length;
    await drag('fix the thing', 'pending');
    expect(calls().length).toBe(before);
  });

  it('will not let a pending todo be dropped straight onto done', async () => {
    // Skipping in-progress skips the boot, so the todo would be closed
    // with the work never started.
    await mount();
    await waitFor(() => expect(screen.getByText('fix the thing')).toBeInTheDocument());
    const before = calls().length;
    await drag('fix the thing', 'completed');
    expect(calls().length).toBe(before);
  });
});

/**
 * Mega deploy: one agent per project with open todos, from one button.
 *
 * It is the most consequential control in the dashboard — a single click
 * starts up to ten agents on this machine, each with commit and push
 * rights in a different repository. What it reports back afterwards is the
 * only account of what it started.
 */
describe('mega deploy', () => {
  const button = (label: string) => {
    const el = [...document.querySelectorAll('button')]
      .find(b => b.textContent?.trim().startsWith(label));
    if (!el) throw new Error(`no ${label} button`);
    return el;
  };
  const calls = () => (global.fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls
    .map(([url, init]) => ({
      url: String(url),
      method: (init as { method?: string } | undefined)?.method ?? 'GET',
      body: (() => {
        try { return JSON.parse((init as { body?: string })?.body ?? 'null'); }
        catch { return null; }
      })(),
    }));

  it('caps how many agents one click can start', async () => {
    // Ten is a lot of processes; unbounded is every project at once.
    await mount();
    await act(async () => { button('Mega Deploy').click(); });
    await waitFor(() => {
      const call = calls().find(c => c.url === '/api/boot/mega' && c.method === 'POST');
      expect(call?.body).toEqual({ maxAgents: 10 });
    });
  });

  it('shows what it launched, per project', async () => {
    response = {
      launched: 2, total: 3,
      results: [
        { project: 'demo', status: 'launched', tmuxSession: 'mega-demo-120000', todoCount: 4 },
        { project: 'other', status: 'launched', tmuxSession: 'mega-other-120000', todoCount: 1 },
        { project: 'third', status: 'skipped', reason: 'already running' },
      ],
    };
    const { container } = await mount();
    await act(async () => { button('Mega Deploy').click(); });
    await waitFor(() => expect(container.textContent).toContain('mega-demo-120000'));
    // The skip matters as much as the launch: it is why the third project
    // has no agent, and without it that reads as a failure.
    expect(container.textContent).toContain('already running');
  });

  it('shows why a launch failed rather than reporting a smaller number', async () => {
    response = {
      launched: 0, total: 1,
      results: [{ project: 'demo', status: 'failed', reason: 'duplicate session' }],
    };
    const { container } = await mount();
    await act(async () => { button('Mega Deploy').click(); });
    await waitFor(() => expect(container.textContent).toContain('duplicate session'));
  });

  it('reports a network failure rather than an empty panel', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) =>
      String(url).includes('/api/boot/mega')
        ? Promise.reject(new Error('ECONNREFUSED'))
        : { ok: true, status: 200, json: async () => response, text: async () => '' }));
    const { container } = await mount();
    await act(async () => { button('Mega Deploy').click(); });
    await waitFor(() => expect(container.textContent).toContain('ECONNREFUSED'));
  });

  it('asks what is running without starting anything', async () => {
    // Status is a GET on purpose; the same path with a POST launches.
    await mount();
    await act(async () => { button('Status').click(); });
    await waitFor(() => expect(calls().some(c => c.url === '/api/boot/mega' && c.method === 'GET')).toBe(true));
    expect(calls().some(c => c.url === '/api/boot/mega' && c.method === 'POST')).toBe(false);
  });

  it('culls finished agents with a DELETE, not by launching more', async () => {
    await mount();
    await act(async () => { button('Cull').click(); });
    await waitFor(() => expect(calls().some(c => c.url === '/api/boot/mega' && c.method === 'DELETE')).toBe(true));
  });
});
