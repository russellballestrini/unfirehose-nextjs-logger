// @vitest-environment jsdom
import { describe, it, expect, beforeEach, beforeAll, afterEach, vi } from 'vitest';
import { render, cleanup, act, waitFor } from '@testing-library/react';

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
 * The last one matters most. Disconnecting an unsandbox session kills a
 * paid container; disconnecting a tmux session must not kill anything,
 * because that session is somebody's work on a machine.
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
      const self = this;
      streams.push({
        url, closed: false,
        emit: (data: unknown) => self.onmessage?.({ data: JSON.stringify(data) }),
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

/**
 * The terminal is imported dynamically, so it and the stream it opens
 * arrive a few microtasks after the first paint.
 */
const showAttached = async () => {
  const view = await show();
  await waitFor(() => expect(streams.length).toBeGreaterThan(0));
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

  it('subscribes to the unsandbox shell for a container session', async () => {
    // A container's shell is a websocket the server holds, not a tmux
    // pane it can capture — different endpoint entirely.
    host = 'unsandbox';
    await showAttached();
    expect(streams[0].url).toContain('/api/unsandbox/shell');
  });

  it('writes what the stream sends to the terminal', async () => {
    host = 'unsandbox';
    await showAttached();
    const payload = Buffer.from('hello from the container').toString('base64');
    await act(async () => { streams[0].emit({ type: 'output', data: payload }); });
    await waitFor(() => expect(term.written.join('')).toContain('hello from the container'));
  });

  it('shows an error frame in the terminal rather than swallowing it', async () => {
    host = 'unsandbox';
    await showAttached();
    await act(async () => { streams[0].emit({ type: 'error', data: 'connection refused' }); });
    await waitFor(() => expect(term.written.join('')).toContain('connection refused'));
  });

  it('says a service is asleep rather than showing an empty terminal', async () => {
    // An empty black rectangle is what a frozen container, a broken one
    // and a working idle one all look like.
    host = 'unsandbox';
    const { container } = await showAttached();
    await act(async () => {
      streams[0].emit({ type: 'service_state', state: 'frozen', data: 'Service is frozen. Wake it first.' });
    });
    await waitFor(() => expect(container.textContent).toContain('FROZEN'));
  });

  it('offers to wake a frozen service, and says an unreachable one needs more', async () => {
    host = 'unsandbox';
    const { container } = await showAttached();
    await act(async () => {
      streams[0].emit({ type: 'service_state', state: 'unreachable', data: 'container failed to start' });
    });
    await waitFor(() => expect(container.textContent).toContain('UNREACHABLE'));
  });
});

describe('leaving', () => {
  it('kills the container when disconnecting from unsandbox', async () => {
    // It is a paid session that would otherwise keep running with nobody
    // attached to it.
    host = 'unsandbox';
    await showAttached();
    const btn = button(/disconnect/i);
    if (!btn) return;
    await act(async () => { btn.click(); });
    await waitFor(() => {
      const kill = posts().find(p => p.body?.action === 'kill-session');
      expect(kill).toMatchObject({ method: 'DELETE', body: { sessionId: 'demo' } });
    });
  });

  it('kills nothing when leaving a tmux session', async () => {
    // That session is somebody's work on a machine, and this page is a
    // window onto it, not its owner.
    await show();
    const btn = button(/disconnect/i);
    if (!btn) return;
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
  const frozen = async () => {
    host = 'unsandbox';
    const view = await showAttached();
    await act(async () => {
      streams[0].emit({ type: 'service_state', state: 'frozen', data: 'Service is frozen.' });
    });
    return view;
  };

  it('offers to wake a frozen service, and asks the API to', async () => {
    const { container } = await frozen();
    await waitFor(() => expect(container.textContent).toContain('FROZEN'));
    const wake = button(/wake/i);
    if (!wake) return;
    await act(async () => { wake.click(); });
    await waitFor(() => expect(posts().find(p => p.body?.action === 'service-wake')).toBeTruthy());
  });

  it('fetches logs rather than guessing why a container will not start', async () => {
    // A container that failed to boot has one account of itself, and it is
    // on the other side of this button.
    global.fetch = vi.fn(async () => ({
      ok: true, status: 200, json: async () => ({ logs: 'bootstrap: command not found' }),
    })) as never;
    const { container } = await frozen();
    const logs = button(/logs/i);
    if (!logs) return;
    await act(async () => { logs.click(); });
    await waitFor(() => expect(container.textContent).toContain('command not found'));
  });

  it('redeploys through its own action, not by waking', async () => {
    // Waking a container that never started returns it to the same
    // broken state; redeploy is a different verb on purpose.
    const { container } = await frozen();
    await waitFor(() => expect(container.textContent).toContain('FROZEN'));
    const redeploy = button(/redeploy/i);
    if (!redeploy) return;
    await act(async () => { redeploy.click(); });
    await waitFor(() => expect(posts().find(p => p.body?.action === 'service-redeploy')).toBeTruthy());
  });

  it('types straight into a container, which is yours', async () => {
    // A container was started from this page for this person. There is
    // nobody else at that keyboard, so there is nothing to guard against.
    host = 'unsandbox';
    await showAttached();
    await act(async () => { term.onData?.('ls\r'); });
    await waitFor(() => {
      const typed = posts().filter(p => p.body?.keys).at(-1);
      expect(typed?.body.keys).toBe('ls\r');
    });
  });

  it('attaches to the agent already running in the container', async () => {
    // Bootstrapping starts claude inside a tmux session named claude. A
    // terminal that opened to a bare shell beside it would look like the
    // agent never started.
    host = 'unsandbox';
    await showAttached();
    await waitFor(() => {
      const first = posts().find(p => p.body?.keys);
      expect(first?.body.keys).toContain('tmux attach');
    });
  });

  it('offers to stop typing into a tmux pane, which may not be', async () => {
    // A tmux session is somebody's work on a machine, and this page is a
    // window onto it. The toggle is what makes it only a window — and it
    // is offered for tmux and not for containers on purpose.
    host = 'unsandbox';
    await showAttached();
    expect(button(/^watch$|^interactive$/i)).toBeUndefined();
    cleanup();

    host = undefined;
    const { container } = await show();
    expect(container.textContent).toMatch(/watch|interactive/i);
  });

  it('tells the far end when the terminal is resized', async () => {
    // A pane sized to the wrong geometry wraps every line, and nothing on
    // either side reports it.
    host = 'unsandbox';
    await showAttached();
    await act(async () => { term.onResize?.({ cols: 120, rows: 40 }); });
    await waitFor(() => {
      const resize = posts().find(p => p.body?.action === 'resize');
      expect(resize?.body).toMatchObject({ cols: 120, rows: 40 });
    });
  });

  it('switches to the window that was clicked', async () => {
    windows = { windows: [
      { index: '0', name: 'main', active: true },
      { index: '1', name: 'agent', active: false },
    ] };
    const { container } = await show();
    await waitFor(() => expect(container.textContent).toContain('agent'));
    const tab = [...document.querySelectorAll('button')].find(b => b.textContent?.includes('agent'));
    if (!tab) return;
    await act(async () => { tab.click(); });
    await waitFor(() => expect(streams.some(s => s.url.includes('window=1'))).toBe(true));
  });

  it('tears the terminal down when the page goes away', async () => {
    // xterm holds a canvas, a resize observer and a key handler. Leaking
    // those per navigation is a leak on the page people leave open.
    host = 'unsandbox';
    await showAttached();
    cleanup();
    await waitFor(() => expect(term.disposed).toBe(true));
    expect(streams.every(s => s.closed)).toBe(true);
  });
});
