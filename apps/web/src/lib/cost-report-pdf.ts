import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from 'pdf-lib';
import { CATEGORY_LABEL, inReportCurrency, type MonthlyCostReport } from '@unturf/unfirehose/cost-report';

/**
 * A monthly cost report as a PDF an expense system will take.
 *
 * Built with pdf-lib's standard fonts so nothing is downloaded or embedded:
 * those fonts carry Windows-1252 only, so amounts are written with the ISO
 * code ("180.00 EUR") rather than a symbol a viewer might not have, and any
 * character outside that set in a name is replaced rather than dropped.
 */

const PAGE_W = 612;   // US Letter, points
const PAGE_H = 792;
const MARGIN = 54;
const INK = rgb(0.1, 0.1, 0.1);
const MUTED = rgb(0.42, 0.42, 0.42);
const RULE = rgb(0.82, 0.82, 0.82);

const BASIS_LABEL: Record<string, string> = {
  stated: 'stated', priced: 'priced', measured: 'measured', flat: 'flat',
};

/** Keep only what WinAnsi can draw. */
function safe(font: PDFFont, s: string): string {
  let out = '';
  for (const ch of s) {
    try { font.encodeText(ch); out += ch; } catch { out += '?'; }
  }
  return out;
}

function monthTitle(month: string): string {
  const [y, m] = month.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });
}

class Writer {
  page!: PDFPage;
  y = 0;
  constructor(private doc: PDFDocument, readonly regular: PDFFont, readonly bold: PDFFont, private footer: string) {
    this.newPage();
  }

  newPage() {
    this.page = this.doc.addPage([PAGE_W, PAGE_H]);
    this.y = PAGE_H - MARGIN;
    const n = this.doc.getPageCount();
    this.page.drawText(safe(this.regular, `${this.footer} · page ${n}`), { x: MARGIN, y: MARGIN / 2, size: 8, font: this.regular, color: MUTED });
  }

  need(h: number) {
    if (this.y - h < MARGIN) this.newPage();
  }

  /** Words wrapped to `width`; returns the lines. */
  wrap(text: string, font: PDFFont, size: number, width: number): string[] {
    const words = safe(font, text).split(/\s+/);
    const lines: string[] = [];
    let line = '';
    for (const w of words) {
      const next = line ? `${line} ${w}` : w;
      if (font.widthOfTextAtSize(next, size) <= width || !line) line = next;
      else { lines.push(line); line = w; }
    }
    if (line) lines.push(line);
    return lines;
  }

  /** A section heading and its rule, moved to a new page with room for a first row. */
  heading(s: string) {
    this.need(70);
    this.text(s, { size: 12, bold: true });
    this.rule();
  }

  text(s: string, opts: { size?: number; bold?: boolean; color?: ReturnType<typeof rgb>; x?: number; gap?: number } = {}) {
    const size = opts.size ?? 10;
    const font = opts.bold ? this.bold : this.regular;
    for (const l of this.wrap(s, font, size, PAGE_W - MARGIN * 2 - ((opts.x ?? MARGIN) - MARGIN))) {
      this.need(size + 4);
      this.page.drawText(l, { x: opts.x ?? MARGIN, y: this.y - size, size, font, color: opts.color ?? INK });
      this.y -= size + 4;
    }
    this.y -= opts.gap ?? 0;
  }

  rule() {
    this.need(6);
    this.page.drawLine({ start: { x: MARGIN, y: this.y - 2 }, end: { x: PAGE_W - MARGIN, y: this.y - 2 }, thickness: 0.5, color: RULE });
    this.y -= 8;
  }

  /** A row: left text (wrapping), a short middle column, a right-aligned amount. */
  row(left: string, mid: string, amount: string, opts: { bold?: boolean; sub?: string } = {}) {
    const size = 10;
    const font = opts.bold ? this.bold : this.regular;
    const amountX = PAGE_W - MARGIN;
    const midX = PAGE_W - MARGIN - 170;
    const leftW = midX - MARGIN - 10;
    const left1 = this.wrap(left, font, size, leftW);
    const subLines = opts.sub ? this.wrap(opts.sub, this.regular, 8, leftW) : [];
    this.need((size + 4) * left1.length + 11 * subLines.length + 2);
    const top = this.y;
    left1.forEach((l, i) => this.page.drawText(l, { x: MARGIN, y: top - size - i * (size + 4), size, font, color: INK }));
    if (mid) this.page.drawText(safe(this.regular, mid), { x: midX, y: top - size, size: 9, font: this.regular, color: MUTED });
    const a = safe(font, amount);
    this.page.drawText(a, { x: amountX - font.widthOfTextAtSize(a, size), y: top - size, size, font, color: INK });
    this.y = top - (size + 4) * left1.length;
    for (const l of subLines) {
      this.page.drawText(l, { x: MARGIN + 8, y: this.y - 8, size: 8, font: this.regular, color: MUTED });
      this.y -= 11;
    }
    this.y -= 3;
  }
}

export async function costReportPdf(r: MonthlyCostReport): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const title = `Cost report — ${monthTitle(r.month)}`;
  doc.setTitle(title);
  doc.setSubject(`unfirehose monthly cost report ${r.month}`);
  doc.setProducer('unfirehose');
  doc.setCreator('unfirehose');
  // Fixed rather than now, so a filed month renders to the same bytes.
  doc.setCreationDate(new Date(r.generatedAt));
  doc.setModificationDate(new Date(r.generatedAt));
  const regular = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const w = new Writer(doc, regular, bold, `unfirehose cost report ${r.month}`);

  const code = r.currency.code;
  const amt = (usd: number) => `${inReportCurrency(r, usd)} ${code}`;

  w.text(title, { size: 18, bold: true, gap: 4 });
  // Dates as the reader's calendar has them, not UTC's: a New York month
  // ends at 04:00 UTC on the first of the next.
  const localDay = (iso: string, backMs = 0) => new Date(Date.parse(iso) - backMs)
    .toLocaleDateString('en-CA', { timeZone: r.timeZone });
  w.text(`Period ${localDay(r.periodStart)} to ${localDay(r.periodEnd, 1000)} (${r.timeZone})${r.closed ? '' : ' — month to date'}`, { color: MUTED });
  w.text(`Generated ${r.generatedAt.replace('T', ' ').slice(0, 16)} UTC`, { color: MUTED });
  if (code !== 'USD') {
    w.text(`Amounts in ${code} at 1 USD = ${r.currency.rate} ${code}, ${r.currency.source} rate for ${r.currency.rateDate}. Sources are in USD.`, { color: MUTED });
  } else if (r.currency.fallbackReason) {
    w.text(`Amounts in USD: ${r.currency.fallbackReason}.`, { color: MUTED });
  }
  w.y -= 10;

  w.text(`Total ${amt(r.totalUSD)}`, { size: 14, bold: true, gap: 8 });

  w.heading('By category');
  for (const c of r.byCategory) w.row(c.label, '', amt(c.usd));
  w.y -= 10;

  w.heading('Line items');
  for (const c of Object.keys(CATEGORY_LABEL) as (keyof typeof CATEGORY_LABEL)[]) {
    const ls = r.lines.filter((l) => l.category === c);
    if (!ls.length) continue;
    w.text(CATEGORY_LABEL[c], { size: 10, bold: true, color: MUTED });
    for (const l of ls) w.row(l.item, BASIS_LABEL[l.basis], amt(l.usd), { sub: l.detail });
  }
  w.rule();
  w.row('Total', '', amt(r.totalUSD), { bold: true });
  w.y -= 10;

  if (r.byProject.length) {
    w.heading('Model API usage by project');
    for (const p of r.byProject) w.row(p.project, '', amt(p.usd));
    w.y -= 10;
  }

  // Absent from a report filed before ticket 4004, which then renders as it did.
  if (r.electricityByProject?.length) {
    w.heading('Electricity our sessions used, by project (inside the electricity lines)');
    for (const p of r.electricityByProject) w.row(p.project, '', amt(p.usd));
    w.y -= 10;
  }

  if (r.memo.length) {
    w.heading('Not counted in the total');
    for (const m of r.memo) w.row(m.item, 'memo', amt(m.usd), { sub: m.detail });
    w.y -= 10;
  }

  w.heading('How each figure was reached');
  for (const n of [
    'stated: the amount a provider said it charged.',
    'priced: tokens at our price ledger on the day they were spent.',
    'measured: sampled watts over the hours sampled, at the node\'s electricity rate.',
    'flat: a monthly amount configured in unfirehose (a plan, an ISP bill).',
    ...r.notes,
  ]) w.text(n, { size: 9, color: MUTED });

  return doc.save({ useObjectStreams: false });
}
