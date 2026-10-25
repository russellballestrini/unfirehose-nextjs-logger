'use client';

import { useCallback, useEffect, useLayoutEffect, useState } from 'react';
import { createPortal } from 'react-dom';

/**
 * Three hints on a page's first visit, pinned to what they describe.
 *
 * Each hint names an anchor — an element carrying `data-coach="<id>"` — and
 * is drawn beside it, numbered. A hint whose anchor is not on the page (a
 * panel with nothing to show yet) is skipped rather than pointing at air.
 * "Got it" dismisses a page's hints for good; Settings → General → "Show
 * hints again" brings them all back. State is one localStorage key, kept
 * on this browser only. Motion is CSS (`coach-in` in globals.css), and
 * reduced-motion turns it off.
 */

export const COACH_STORAGE_KEY = 'unfirehose_coach_marks';

export type CoachPage = 'dashboard' | 'tokens' | 'projects' | 'permacomputer';

export interface CoachHint { anchor: string; title: string; body: string }

export const COACH_HINTS: Record<CoachPage, CoachHint[]> = {
  dashboard: [
    { anchor: 'dashboard-range', title: 'Pick a window', body: 'Every chart here follows this range, and each page remembers its own.' },
    { anchor: 'dashboard-stats', title: 'What it cost', body: 'Equivalent cost at our price ledger, with cache reads split out. Self-hosted models count their electricity.' },
    { anchor: 'dashboard-models', title: 'Which models did the work', body: 'Tokens and cost per model. Hover a bar for the input, output and cache split.' },
  ],
  tokens: [
    { anchor: 'tokens-tabs', title: 'Four views of one spend', body: 'Overview, harnesses, tools and your plan: the same tokens, cut four ways.' },
    { anchor: 'tokens-range', title: 'Window and project', body: 'Narrow to one project to see what it alone consumed.' },
    { anchor: 'tokens-models', title: 'Per model, priced per day', body: 'Each day books at that day\'s price, so a later price change does not rewrite last month.' },
  ],
  projects: [
    { anchor: 'projects-search', title: 'Find a project', body: 'Search by name or path. Renamed repos stay one project: identity is the git root commit.' },
    { anchor: 'projects-chips', title: 'Focus on one', body: 'Click a chip to show only that project; the hotter its colour, the more recent its work.' },
    { anchor: 'projects-list', title: 'One card per repo', body: 'Agent scratch workspaces fold into the repo they worked on.' },
  ],
  permacomputer: [
    { anchor: 'mesh-nodes', title: 'Your machines', body: 'Every host in ~/.ssh/config, probed over ssh. Click one for its processes, containers and harnesses.' },
    { anchor: 'mesh-economics', title: 'What the fleet costs', body: 'Measured watts at each node\'s rate, plus its connection. Set rates per node on its page.' },
    { anchor: 'mesh-add', title: 'Add a machine', body: 'A new Host block in ssh config joins the mesh within a minute.' },
  ],
};

type Dismissed = Partial<Record<CoachPage, true>>;

function read(): Dismissed {
  try {
    const raw = globalThis.localStorage?.getItem(COACH_STORAGE_KEY);
    const v = raw ? JSON.parse(raw) : {};
    return v && typeof v === 'object' ? v : {};
  } catch { return {}; }
}

function write(v: Dismissed): void {
  try { globalThis.localStorage?.setItem(COACH_STORAGE_KEY, JSON.stringify(v)); } catch { /* private mode */ }
}

/** Bring every page's hints back. Settings calls this. */
export function resetCoachMarks(): void {
  try { globalThis.localStorage?.removeItem(COACH_STORAGE_KEY); } catch { /* private mode */ }
}

export function coachDismissed(page: CoachPage): boolean {
  return !!read()[page];
}

interface Placed extends CoachHint { n: number; top: number; left: number }

/** Room a hint takes: its width, and a height generous enough for three lines. */
const HINT_W = 288;
const HINT_H = 120;
/** An anchor taller than this is a region, not a control: its hint sits inside its top corner. */
const TALL = 240;

/**
 * Where each hint goes: below a control, inside the top-right corner of a
 * tall region, kept inside the viewport, and pushed down past any hint it
 * would cover.
 */
export function placeHints(hints: CoachHint[], rectOf: (anchor: string) => DOMRect | null, vw: number, scroll = { x: 0, y: 0 }): Placed[] {
  const out: Placed[] = [];
  hints.forEach((h, i) => {
    const r = rectOf(h.anchor);
    if (!r) return;
    const tall = r.height > TALL;
    const left = tall ? r.right - HINT_W - 8 : r.left;
    out.push({
      ...h, n: i + 1,
      top: (tall ? r.top + 8 : r.bottom + 8) + scroll.y,
      left: Math.max(8, Math.min(left + scroll.x, vw - HINT_W - 8)),
    });
  });
  const byTop = [...out].sort((a, b) => a.top - b.top);
  for (let i = 1; i < byTop.length; i++) {
    for (let j = 0; j < i; j++) {
      const a = byTop[j], b = byTop[i];
      const sideBySide = b.left >= a.left + HINT_W || a.left >= b.left + HINT_W;
      if (!sideBySide && b.top < a.top + HINT_H) b.top = a.top + HINT_H;
    }
  }
  return out;
}

function place(hints: CoachHint[]): Placed[] {
  return placeHints(
    hints,
    (anchor) => document.querySelector(`[data-coach="${anchor}"]`)?.getBoundingClientRect() ?? null,
    globalThis.innerWidth || 1024,
    { x: globalThis.scrollX || 0, y: globalThis.scrollY || 0 },
  );
}

export function CoachMarks({ page }: { page: CoachPage }) {
  // Hidden on the server and the first client render; decided after mount,
  // where localStorage exists, so hydration never disagrees.
  const [open, setOpen] = useState(false);
  const [placed, setPlaced] = useState<Placed[]>([]);

  // eslint-disable-next-line react-hooks/set-state-in-effect -- localStorage exists only after mount
  useEffect(() => { setOpen(!coachDismissed(page)); }, [page]);

  // An unknown page has no hints rather than a crash.
  const layout = useCallback(() => setPlaced(place(COACH_HINTS[page] ?? [])), [page]);
  useLayoutEffect(() => {
    if (!open) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- positions come from measuring the rendered anchors
    layout();
    // Anchors render as data arrives; look again a moment later and on resize.
    const t = setTimeout(layout, 800);
    globalThis.addEventListener('resize', layout);
    return () => { clearTimeout(t); globalThis.removeEventListener('resize', layout); };
  }, [open, layout]);

  if (!open || placed.length === 0) return null;
  const dismiss = () => { write({ ...read(), [page]: true }); setOpen(false); };

  // On document.body: positions are page coordinates, and inside our
  // content column (offset by the sidebar) they would land a sidebar's
  // width to the right of what they point at.
  return createPortal(
    <div data-coach-page={page} aria-label="Hints for this page">
      {placed.map((h) => (
        <div
          key={h.anchor}
          role="note"
          data-coach-hint={h.anchor}
          className="coach-mark absolute z-40 w-[288px] rounded border border-[var(--color-accent)] bg-[var(--color-surface)] p-3 text-sm shadow-lg"
          style={{ top: h.top, left: h.left }}
        >
          <div className="flex items-baseline gap-2">
            <span className="shrink-0 w-5 h-5 rounded-full bg-[var(--color-accent)] text-black text-xs font-bold flex items-center justify-center">{h.n}</span>
            <span className="font-bold">{h.title}</span>
          </div>
          <p className="mt-1 text-[var(--color-muted)]">{h.body}</p>
          {h.n === placed[placed.length - 1].n && (
            <button type="button" onClick={dismiss} className="mt-2 px-2 py-0.5 rounded bg-[var(--color-accent)] text-black font-bold cursor-pointer">
              Got it
            </button>
          )}
        </div>
      ))}
    </div>,
    document.body,
  );
}
