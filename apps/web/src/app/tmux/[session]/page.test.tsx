// @vitest-environment jsdom
import { describe, it, expect, beforeEach, beforeAll, afterEach, vi } from 'vitest';
import { render, cleanup, act, waitFor } from '@testing-library/react';
import { INTEGRATIONS } from '@/integrations/catalog';

/**
 * A terminal in a browser tab.
 *
 * xterm draws to a canvas jsdom cannot provide, so it is replaced by a
 * stand-in that records what was written to it and lets its input handler
 * be called directly. What that leaves under test is everything around the
 * terminal: the stream it subscribes to, the frames it decodes, what it
 * does when a container is asleep, and what happens to the session when
 * somebody closes the tab.
 *
 * The last one matters most: disconnecting a tmux session must not kill
 * anything, because that session is somebody's work on a machine. Sessions
 * on a host an integration owns (a cloud container) are tested in that
 * integration's directory; here, with every integration off, such a host
 * says so instead of reaching for tmux.
 */

/** The fake terminal, and everything written to it. */
let term: {
  written: string[];
  onData?: (d: string) => void;
  onResize?: (s: { cols: number; rows: number }) => void;
  keyHandler?: (e: KeyboardEvent) => boolean;
  disposed: boolean;
};
vi.mock('@xterm/xterm/css/xterm.css', () => ({}));
vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    written: string[] = [];
    constructor() {
      term = { written: this.written, disposed: false };
    }
    open() {}
    write(d: string | Uint8Array) {
      this.written.push(typeof d === 'string' ? d : new TextDecoder().decode(d));
    }
    onData(cb: (d: string) => void) { term.onData = cb; return { dispose() {} }; }
    onResize(cb: (s: { cols: number; rows: number }) => void) { term.onResize = cb; return { dispose() {} }; }
    attachCustomKeyEventHandler(cb: (e: KeyboardEvent) => boolean) { term.keyHandler = cb; }
    loadAddon() {}
    focus() {}
    clear() {}
    dispose() { term.disposed = true; }
    get cols() { return 80; }
    get rows() { return 24; }
  },
}));
vi.mock('@xterm/addon-fit', () => ({
  FitAddon: class { fit() {} activate() {} dispose() {} },
}));

/** Every EventSource opened, and a way to push a frame down it. */
let streams: Array<{ url: string; closed: boolean; emit: (data: unknown) => void }>;

let nicknames: unknown;
let windows: unknown;
vi.mock('swr', () => ({
  default: (key: string | null) => ({
    data: key == null ? undefined
      : String(key).includes('nickname') ? nicknames
      : String(key) === '/api/integrations' ? { integrations: [] }
      : windows,
    error: undefined, isLoading: false, mutate: vi.fn(),
  }),
  useSWRConfig: () => ({ mutate: vi.fn() }),
}));

let host: string | undefined;
vi.mock('next/navigation', () => ({
  useParams: () => ({ session: 'demo' }),
  useSearchParams: () => new URLSearchParams(host ? { host } : {}),
  useRouter: () => ({ push: vi.fn() }),
  usePathname: () => '/tmux/demo',
}));

const TmuxViewerPage = (await import('./page')).default;

const posts = () => (global.fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls
  .map(([url, init]) => ({
    url: String(url),
    method: (init as { method?: string } | undefined)?.method ?? 'GET',
    body: (() => { try { return JSON.parse((init as { body?: string })?.body ?? 'null'); } catch { return null; } })(),
  }));

beforeAll(() => {
  window.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as never;
  Element.prototype.scrollIntoView ??= vi.fn() as never;
});

beforeEach(() => {
  streams = [];
  nicknames = {}; windows = { windows: [{ index: '0', name: 'main', active: true }] };
  host = undefined;
  (global as Record<string, unknown>).EventSource = class {
    onmessage: ((e: { data: string }) => void) | null = null;
    onerror: (() => void) | null = null;
    constructor(public url: string) {
      streams.push({
        url, closed: false,
        emit: (data: unknown) => this.onmessage?.({ data: JSON.stringify(data) }),
      });
    }
    close() { streams.find(s => s.url === this.url)!.closed = true; }
    addEventListener() {} removeEventListener() {}
  };
  global.fetch = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ ok: true }) })) as never;
});
afterEach(cleanup);

const show = async () => {
  const view = render(<TmuxViewerPage />);
  await act(async () => { await Promise.resolve(); });
  return view;
};

const button = (re: RegExp) =>
  [...document.querySelectorAll('button')].find(b => re.test(b.textContent ?? ''));

describe('the terminal', () => {
  it('subscribes to the session named in the url', async () => {
    await show();
    await waitFor(() => expect(streams.length).toBeGreaterThan(0));
    expect(streams[0].url).toContain('demo');
  });

});

const integrationHost = INTEGRATIONS.flatMap(i => [...i.hosts])[0];

describe.skipIf(!integrationHost)('a host owned by an integration that is off', () => {
  it('says where to turn it on and opens no stream', async () => {
    host = integrationHost;
    const { container } = await show();
    expect(container.textContent).toMatch(/integration is off/);
    expect(container.textContent).toContain('Settings');
    expect(streams).toEqual([]);
  });
});

describe('leaving', () => {
  it('kills nothing when leaving a tmux session', async () => {
    // That session is somebody's work on a machine, and this page is a
    // window onto it, not its owner.
    await show();
    const btn = button(/disconnect/i);
    if (!btn) throw new Error('missing control: btn');
    await act(async () => { btn.click(); });
    expect(posts().some(p => p.body?.action === 'kill-session')).toBe(false);
  });
});

/**
 * The controls around the terminal.
 *
 * Everything here acts on a machine: switching a window changes which pane
 * is being watched, waking a service starts a paid container, and
 * redeploying destroys one and builds it again. None of that is
 * recoverable from this page, so what each button sends is worth pinning.
 */
describe('the controls', () => {
  it('switches to the window that was clicked', async () => {
    windows = { windows: [
      { index: '0', name: 'main', active: true },
      { index: '1', name: 'agent', active: false },
    ] };
    const { container } = await show();
    await waitFor(() => expect(container.textContent).toContain('agent'));
    const tab = [...document.querySelectorAll('button')].find(b => b.textContent?.includes('agent'));
    if (!tab) throw new Error('missing control: tab');
    await act(async () => { tab.click(); });
    await waitFor(() => expect(streams.some(s => s.url.includes('window=1'))).toBe(true));
  });

});

/**
 * Typing into a tmux pane from the page rather than the terminal widget.
 *
 * A tmux session has no websocket — keystrokes are POSTed one request at a
 * time, so they are queued and coalesced: typing at speed would otherwise
 * be one HTTP round trip per character, arriving out of order.
 *
 * The keyboard listener is on the window, which is why it has to know when
 * not to fire. Typing into the nickname field must not also type into the
 * pane behind it.
 */
describe('typing into a tmux pane', () => {
  const keys = () => posts().filter(p => p.body?.keys || p.body?.special).map(p => p.body);

  /**
   * A keypress as the browser delivers one: targeted at the focused
   * element and bubbling to the window listener. Dispatching on window
   * itself makes e.target the window, which has no closest().
   */
  const press = async (init: KeyboardEventInit) => {
    await act(async () => {
      document.body.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, ...init }));
    });
    await act(async () => { await new Promise(r => setTimeout(r, 30)); });
  };

  /** Everything typed after the session's own auto-attach line. */
  const typed = () => keys().filter(k => !String(k.keys ?? '').includes('tmux attach'));

  it('sends an ordinary character', async () => {
    await show();
    await press({ key: 'a' });
    await waitFor(() => expect(typed().some(k => k.keys === 'a')).toBe(true));
  });

  it('coalesces a burst into one request', async () => {
    // One round trip per character arrives out of order at speed, and a
    // shell that receives 'sl' instead of 'ls' is somebody's afternoon.
    await show();
    await act(async () => {
      for (const key of ['l', 's']) {
        document.body.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
      }
    });
    await act(async () => { await new Promise(r => setTimeout(r, 50)); });
    await waitFor(() => expect(typed().length).toBeGreaterThan(0));
    expect(typed()[0].keys).toBe('ls');
  });

  it('sends a named key by name rather than as a character', async () => {
    await show();
    await press({ key: 'Escape' });
    await waitFor(() => expect(typed().some(k => k.special === 'Escape')).toBe(true));
  });

  it('sends a control chord as the sequence tmux expects', async () => {
    // Ctrl-C is the one people reach for when an agent is running away.
    await show();
    await press({ key: 'c', ctrlKey: true });
    await waitFor(() => expect(typed().some(k => k.special === 'C-c')).toBe(true));
  });

  it('leaves a modifier chord alone when tmux has no name for it', async () => {
    await show();
    await press({ key: 'k', metaKey: true });
    expect(typed().some(k => k.keys === 'k')).toBe(false);
  });

  it('does not type into the pane while somebody is typing into a field', async () => {
    // The listener is on the window. Without this, renaming a session
    // types the name into the shell behind the dialog.
    const { container } = await show();
    const input = document.createElement('input');
    container.appendChild(input);
    input.focus();
    await act(async () => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'x', bubbles: true }));
    });
    await act(async () => { await new Promise(r => setTimeout(r, 30)); });
    expect(typed().some(k => k.keys === 'x')).toBe(false);
  });

  it('pastes a block of text as one request', async () => {
    await show();
    await act(async () => {
      const e = new Event('paste', { bubbles: true }) as ClipboardEvent;
      Object.defineProperty(e, 'clipboardData', { value: { getData: () => 'git status\n' } });
      document.body.dispatchEvent(e);
    });
    await act(async () => { await new Promise(r => setTimeout(r, 30)); });
    await waitFor(() => expect(typed().some(k => k.keys === 'git status\n')).toBe(true));
  });

  it('stops listening when the page goes away', async () => {
    // The listener is on the window, so a leaked one keeps typing into a
    // session the person has already left.
    await show();
    cleanup();
    const before = typed().length;
    await press({ key: 'z' });
    expect(typed().length).toBe(before);
  });
});
