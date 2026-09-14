import { NextRequest } from 'next/server';
import { execFile } from 'child_process';
import { createReadStream } from 'fs';
import { stat } from 'fs/promises';
import { createInterface } from 'readline';
import { extractText, extractTools, extractToolResults, extractReasoningInfo, entryRole } from '@unturf/unfirehose/stream-blocks';

/**
 * The tail of one harness session's JSONL, as readable lines.
 *
 * A harness never holds its session file open -- it appends and closes --
 * so there is nothing to attach to the way the tmux route attaches to a
 * pane. The tie from a process to its file is made in the node probe
 * (parseHarnessSessions); this route is handed the file that came back and
 * shows what is being written to it. Local files are read from disk;
 * a file on another node is tailed over SSH, the same reach the tmux and
 * mesh routes already use.
 *
 * Entries are rendered to text here, not on the client, so the viewer is
 * the same <pre> the tmux preview already is: one string in, no per-entry
 * React. Both the Claude and the unfirehose/1.0 shapes render through
 * core's extractors, so a claude session and an uncloseai one read alike.
 *
 * GET /api/session/tail?path=<jsonl>            local
 * GET /api/session/tail?path=<jsonl>&host=<h>   over ssh
 * GET /api/session/tail?...&lines=N             how many entries to keep (default 40)
 */

/**
 * A session path we will open. It is not free-form: it must be a .jsonl
 * inside a harness's project tree (~/.claude/projects/<enc>/ or
 * ~/.<harness>/unfirehose/<slug>/), which is exactly the shape the probe
 * emits. This keeps the endpoint from being turned into read-any-file.
 */
function isSessionPath(p: string): boolean {
  if (!p.endsWith('.jsonl') || p.includes('..') || p.includes('\0')) return false;
  return /\/\.[^/]+\/(?:projects|unfirehose)\/[^/]+\/[^/]+\.jsonl$/.test(p);
}

/** One JSONL entry as a compact, readable line — role, then its text/tools. */
function renderEntry(parsed: unknown): string | null {
  const role = entryRole(parsed);
  if (role === 'unknown') return null;
  const parts: string[] = [];
  const reasoning = extractReasoningInfo(parsed);
  if (reasoning && (reasoning.text.trim() || reasoning.sealed)) {
    parts.push(reasoning.sealed && !reasoning.text.trim() ? '[reasoning · sealed]' : `[reasoning] ${reasoning.text.trim()}`);
  }
  const text = extractText(parsed, { stripPlaceholders: true }).trim();
  if (text) parts.push(text);
  for (const t of extractTools(parsed)) {
    const arg = t.input ? ` ${JSON.stringify(t.input).slice(0, 200)}` : '';
    parts.push(`[→ ${t.name}]${arg}`);
  }
  for (const r of extractToolResults(parsed)) {
    const body = (r.content ?? '').toString().trim().replace(/\s+/g, ' ').slice(0, 300);
    if (body) parts.push(`[← ${r.isError ? 'error' : 'result'}] ${body}`);
  }
  if (parts.length === 0) return null;
  const tag = role === 'assistant' ? '⏵' : role === 'user' ? '⏴' : '·';
  return `${tag} ${role}\n${parts.join('\n')}`;
}

/** Read the last `lines` renderable entries from a local file. */
function tailLocal(filePath: string, lines: number): Promise<string> {
  return new Promise((resolve) => {
    const rendered: string[] = [];
    const rl = createInterface({ input: createReadStream(filePath, { encoding: 'utf-8' }), crlfDelay: Infinity });
    const timer = setTimeout(() => { try { rl.close(); } catch { /* ignore */ } }, 3000);
    rl.on('line', (line) => {
      const t = line.trim();
      if (!t) return;
      try {
        const r = renderEntry(JSON.parse(t));
        if (r) { rendered.push(r); if (rendered.length > lines) rendered.shift(); }
      } catch { /* skip */ }
    });
    rl.on('close', () => { clearTimeout(timer); resolve(rendered.join('\n\n')); });
    rl.on('error', () => { clearTimeout(timer); resolve(''); });
  });
}

/** Tail a file on another node — the raw last lines, parsed and rendered here. */
function tailRemote(host: string, filePath: string, lines: number): Promise<string> {
  // A tool_use entry is large, so ask for generous raw lines and render/trim
  // to `lines` entries this side. -n counts newline-delimited JSONL records,
  // which is one entry each.
  return new Promise((resolve) => {
    execFile(
      'ssh',
      ['-o', 'ConnectTimeout=5', '-o', 'StrictHostKeyChecking=no', '-o', 'BatchMode=yes', host, 'tail', '-n', String(lines * 2), '--', filePath],
      { timeout: 10000, maxBuffer: 8 * 1024 * 1024, encoding: 'utf-8' },
      (_err, stdout) => {
        const rendered: string[] = [];
        for (const line of (stdout || '').split('\n')) {
          const t = line.trim();
          if (!t) continue;
          try {
            const r = renderEntry(JSON.parse(t));
            if (r) rendered.push(r);
          } catch { /* skip */ }
        }
        resolve(rendered.slice(-lines).join('\n\n'));
      },
    );
  });
}

async function snapshot(host: string | undefined, filePath: string, lines: number): Promise<string> {
  const isLocal = !host || host === 'localhost';
  if (isLocal) {
    const s = await stat(filePath).catch(() => null);
    if (!s?.isFile()) return '';
    return tailLocal(filePath, lines);
  }
  return tailRemote(host, filePath, lines);
}

export async function GET(request: NextRequest) {
  const filePath = request.nextUrl.searchParams.get('path');
  const host = request.nextUrl.searchParams.get('host') ?? undefined;
  const lines = Math.min(200, Math.max(5, parseInt(request.nextUrl.searchParams.get('lines') ?? '40') || 40));

  if (!filePath || !isSessionPath(filePath)) {
    return new Response('Invalid session path', { status: 400 });
  }
  if (host && !/^[a-zA-Z0-9._-]+$/.test(host)) {
    return new Response('Invalid host', { status: 400 });
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      let closed = false;
      let last = '';
      const send = (data: object) => {
        if (closed) return;
        try { controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`)); }
        catch { closed = true; }
      };

      const tick = async () => {
        if (closed) return;
        try {
          const content = await snapshot(host, filePath, lines);
          // Only resend when it changed; a session at rest costs one poll,
          // not a repaint.
          if (content !== last) { last = content; send({ type: 'tail', content }); }
        } catch { /* leave the last snapshot up */ }
      };

      try { controller.enqueue(encoder.encode(': hello\n\n')); } catch { closed = true; }
      await tick();
      const poll = setInterval(tick, host ? 4000 : 1500);
      const heartbeat = setInterval(() => {
        if (closed) return;
        try { controller.enqueue(encoder.encode(': ping\n\n')); } catch { closed = true; }
      }, 15000);

      const cleanup = () => {
        closed = true;
        clearInterval(poll);
        clearInterval(heartbeat);
        try { controller.close(); } catch { /* ignore */ }
      };
      request.signal.addEventListener('abort', cleanup);
    },
  });

  return new Response(stream, {
    headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive' },
  });
}
