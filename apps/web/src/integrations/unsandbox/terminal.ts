import type { TerminalProvider } from '../index';
import { XtermPane } from './XtermPane';

const post = (url: string, body: unknown, method = 'POST') =>
  fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

/** How /tmux/<session>?host=unsandbox draws, types into and ends a container. */
export const unsandboxTerminal: TerminalProvider = {
  label: 'unsandbox',
  Pane: XtermPane,
  footer: 'unsandbox container, full interactive terminal. Drag a file to inject its path.',

  sendKeys(sessionId, keys) {
    post('/api/unsandbox/shell', { session_id: sessionId, keys }).catch(() => {});
  },

  // Known defect, left as is (fox, 2026-10-24): this sends DELETE, but our
  // proxy only answers GET and POST (kill-session is a POST action), so a
  // disconnect has never ended the container. Not fixed because unsandbox is
  // leaving this app; a fix would also start ending paid containers on
  // every disconnect.
  kill(sessionId) {
    post('/api/unsandbox', { action: 'kill-session', sessionId }, 'DELETE').catch(() => {});
  },

  // Bootstrapping starts the agent in a tmux session named claude; attach to
  // it so the terminal does not open on a bare shell beside it.
  onFirstConnect(sessionId) {
    setTimeout(() => {
      post('/api/unsandbox/shell', {
        session_id: sessionId,
        keys: 'source ~/.bashrc 2>/dev/null; tmux attach -t claude 2>/dev/null || true\r',
      }).catch(() => {});
    }, 500);
  },

  async serviceAction(sessionId, action) {
    if (action === 'logs') {
      const res = await post('/api/unsandbox', { action: 'service-logs', serviceId: sessionId });
      const data = await res.json();
      return data.logs || data.stdout || data.output || JSON.stringify(data, null, 2);
    }
    await post('/api/unsandbox', { action: `service-${action}`, serviceId: sessionId });
    return undefined;
  },
};
