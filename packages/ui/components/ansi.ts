/**
 * ANSI escape codes to styled HTML.
 *
 * This existed twice — once in the node detail page, once in the tmux viewer
 * — with identical colour maps and two implementations of the state machine
 * that reads them. A terminal that renders one colour differently from the
 * other terminal beside it is the kind of drift nobody files a defect about
 * and everybody notices.
 *
 * The cached form is the one kept: tmux capture-pane redraws several times a
 * second, and most spans repeat, so the style string is built once per
 * distinct combination rather than once per span.
 */

const FG: Record<string, string> = {
  '30': '#1e1e1e', '31': '#ef4444', '32': '#22c55e', '33': '#eab308',
  '34': '#60a5fa', '35': '#c084fc', '36': '#22d3ee', '37': '#d4d4d4',
  '90': '#737373', '91': '#f87171', '92': '#4ade80', '93': '#facc15',
  '94': '#93c5fd', '95': '#d8b4fe', '96': '#67e8f9', '97': '#ffffff',
};

const BG: Record<string, string> = {
  '40': '#1e1e1e', '41': '#991b1b', '42': '#166534', '43': '#854d0e',
  '44': '#1e3a5f', '45': '#581c87', '46': '#164e63', '47': '#404040',
};

const SPLIT = /(\x1b\[[0-9;]*m)/;
const ESCAPE = /^\x1b\[([0-9;]*)m$/;

const styleCache = new Map<string, string>();

function openTag(fg: string, bg: string, bold: boolean, dim: boolean): string {
  const key = `${fg}|${bg}|${bold ? 1 : 0}|${dim ? 1 : 0}`;
  let cached = styleCache.get(key);
  if (cached === undefined) {
    const styles: string[] = [];
    if (fg) styles.push(`color:${fg}`);
    if (bg) styles.push(`background:${bg}`);
    if (bold) styles.push('font-weight:bold');
    if (dim) styles.push('opacity:0.6');
    cached = styles.length ? `<span style="${styles.join(';')}">` : '';
    styleCache.set(key, cached);
  }
  return cached;
}

/**
 * Escaped so terminal output cannot become markup. This result is handed to
 * dangerouslySetInnerHTML, so that escaping is the only thing standing
 * between a process's stdout and script execution in our page.
 */
export function ansiToHtml(text: string): string {
  const chunks: string[] = [];
  let fg = '';
  let bg = '';
  let bold = false;
  let dim = false;

  for (const part of text.split(SPLIT)) {
    if (!part) continue;

    const match = ESCAPE.exec(part);
    if (match) {
      for (const code of match[1].split(';')) {
        if (!code || code === '0') { fg = ''; bg = ''; bold = false; dim = false; }
        else if (code === '1') bold = true;
        else if (code === '2') dim = true;
        else if (code === '22') { bold = false; dim = false; }
        else if (FG[code]) fg = FG[code];
        else if (BG[code]) bg = BG[code];
        else if (code === '39') fg = '';
        else if (code === '49') bg = '';
      }
      continue;
    }

    const escaped = part
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
    const open = openTag(fg, bg, bold, dim);
    if (open) chunks.push(open, escaped, '</span>');
    else chunks.push(escaped);
  }

  return chunks.join('');
}
